/**
 * super-board QA — issue #12, popup layer boot script.
 *
 * Injected into popup.html immediately BEFORE popup.js, so the popup boots
 * against this `chrome` object. Two things make this harness stronger than a
 * hand-written fake background:
 *
 *   1. `chrome.runtime.sendMessage` is routed into the REAL background.js
 *      (fetched and evaluated here with `chrome`/`fetch`/`Date` shadowed), so
 *      the popup→background contract for the new `markTodo` action is
 *      exercised end to end, not re-implemented.
 *   2. `fetch` under the background is the same stateful Notion double the
 *      Node suite uses (suite/notion-mock.mjs, served as a classic script), so
 *      "what the Notion row holds" is a real read-back, not a request log.
 *
 * The clock is frozen at an instant where the UTC day and the local day
 * disagree — on this host (America/Chicago, UTC-5 in August)
 * 2026-08-11T02:00:00Z is 2026-08-10 21:00 local.
 *
 * Query params:
 *   ?seeded=1        the problem already has a Notion row (AC2 hidden case)
 *   ?fail=1          force the create to fail (AC8)
 *   ?race=1          a row appears in Notion after the popup's lookup (AC9)
 *   ?number=&difficulty=&title=   layout stress for AC1
 *   ?demo=marked|update|due       drive the UI to a settled state and set
 *                                 window.__qa.demoDone
 */
(() => {
  const params = new URLSearchParams(location.search);
  const QA_NOW = params.get("now") || "2026-08-11T02:00:00Z";
  const PROBLEM_NUMBER = Number(params.get("number") || 2846);
  const DIFFICULTY = params.get("difficulty") || "Hard";
  const TITLE = params.get("title") || "Minimum Edge Weight Equilibrium Queries in a Tree";
  const SEED_ID = "qa-existing-1";

  // --- frozen clock --------------------------------------------------------
  const fixed = new Date(QA_NOW).getTime();
  const RealDate = Date;
  class FrozenDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(fixed);
      else super(...args);
    }
    static now() {
      return fixed;
    }
  }
  window.Date = FrozenDate;

  const sync = (s) => {
    const x = new XMLHttpRequest();
    x.open("GET", s, false);
    x.send(null);
    return x.responseText;
  };

  // --- stateful Notion double (same module the Node suite uses) ------------
  // eslint-disable-next-line no-eval
  (0, eval)(sync("/qa/notion-mock.js"));

  const seed = {};
  if (params.get("seeded") === "1") {
    seed[SEED_ID] = {
      "S No.": { number: PROBLEM_NUMBER },
      Question: { title: [{ text: { content: TITLE } }] },
      "Spaced Repetition": { date: { start: "2026-09-30" } },
      Attempts: { number: 3 },
      "My Expertise": { select: { name: "Medium" } },
      Level: { select: { name: DIFFICULTY } },
      Done: { checkbox: false },
      "Date (of first attempt)": { date: { start: "2026-07-01" } },
    };
  }

  const notion = window.__qaCreateNotionMock(seed, {
    schema: window.__qaFullSchema,
  });
  if (seed[SEED_ID]) {
    notion.pages.get(SEED_ID).last_edited_time = new RealDate(
      fixed - 86400000,
    ).toISOString();
  }

  // --- the real background.js, with its three globals shadowed -------------
  const bgSrc = sync("/background.js");
  const listeners = [];
  const notifications = [];

  const syncStore = {
    notionApiKey: params.get("nokey") === "1" ? "" : "qa-test-key",
    notionDatabaseId: params.get("nokey") === "1" ? "" : "qa-db-1",
    spacedRepetitionIntervals: { Low: 1, Medium: 3, High: 7 },
  };
  const localStore = {};

  const pick = (keys, store) => {
    const list = Array.isArray(keys)
      ? keys
      : typeof keys === "string"
        ? [keys]
        : Object.keys(store);
    const out = {};
    for (const k of list) if (k in store) out[k] = JSON.parse(JSON.stringify(store[k]));
    return out;
  };

  const noop = () => {};
  const bgChrome = {
    runtime: {
      onMessage: { addListener: (fn) => listeners.push(fn) },
      onStartup: { addListener: noop },
      onInstalled: { addListener: noop },
      sendMessage: noop,
      getURL: (p) => "/" + String(p).replace(/^\//, ""),
      lastError: null,
    },
    alarms: { create: noop, clear: noop, onAlarm: { addListener: noop } },
    storage: {
      sync: {
        get: async (k) => pick(k, syncStore),
        set: async (o) => Object.assign(syncStore, o),
        remove: async () => {},
      },
      local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
    },
    tabs: { create: noop, query: async () => [], onUpdated: { addListener: noop } },
    notifications: {
      create: (id, o, cb) => {
        notifications.push({ id, ...o });
        cb?.(id);
      },
      onClicked: { addListener: noop },
    },
    action: { setBadgeText: noop, setBadgeBackgroundColor: noop },
  };

  const bg = new Function(
    "chrome",
    "fetch",
    "Date",
    `${bgSrc}\n; return { checkDueReviews, localDateString };`,
  )(bgChrome, notion.fetch, FrozenDate);

  const messages = [];
  function toBackground(message) {
    messages.push(JSON.parse(JSON.stringify(message)));
    return new Promise((resolve) => {
      listeners[0](message, { id: "qa" }, resolve);
    });
  }

  // --- the popup's chrome ---------------------------------------------------
  window.chrome = {
    runtime: {
      sendMessage: toBackground,
      getURL: (p) => "/" + String(p).replace(/^\//, ""),
      lastError: null,
    },
    storage: {
      sync: {
        get: async (k) => pick(k, syncStore),
        set: async (o) => Object.assign(syncStore, o),
        remove: async (k) => {
          for (const key of Array.isArray(k) ? k : [k]) delete syncStore[key];
        },
      },
      local: {
        get: async (k) => pick(k, localStore),
        set: async (o) => Object.assign(localStore, o),
        remove: async (k) => {
          for (const key of Array.isArray(k) ? k : [k]) delete localStore[key];
        },
      },
    },
    tabs: {
      query: async () => [
        { id: 1, url: "https://leetcode.com/problems/qa-problem/" },
      ],
      sendMessage: (tabId, msg, cb) => {
        if (typeof cb === "function") cb(undefined);
      },
    },
    scripting: {
      executeScript: async () => [
        {
          result: {
            number: PROBLEM_NUMBER,
            title: TITLE,
            difficulty: DIFFICULTY,
            code: "class Solution:\n    def solve(self):\n        return 0",
            language: "Python3",
            url: "https://leetcode.com/problems/qa-problem/",
            scrapedTags: ["Tree", "Graph"],
            userAttempts: null,
            questionContent: "QA fixture problem statement.",
            examples: [],
            constraints: [],
          },
        },
      ],
    },
  };

  // --- test hooks -----------------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const rect = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      x: Math.round(r.x),
      y: Math.round(r.y),
      w: Math.round(r.width),
      h: Math.round(r.height),
      right: Math.round(r.right),
      bottom: Math.round(r.bottom),
      cy: Math.round(r.y + r.height / 2),
    };
  };

  window.__qa = {
    now: QA_NOW,
    problemNumber: PROBLEM_NUMBER,
    notion,
    messages,
    notifications,
    utcDay: new RealDate(fixed).toISOString().split("T")[0],
    localDay: bg.localDateString(),
    /**
     * The row this scenario is about: whichever page in the double carries
     * this problem's number — the queued one, the seeded one, or the one that
     * raced in. Looked up by "S No." rather than by id so the assertion does
     * not depend on how the row got there.
     */
    row: () => {
      for (const page of notion.pages.values()) {
        if (page.properties?.["S No."]?.number === PROBLEM_NUMBER) {
          return JSON.parse(JSON.stringify(page));
        }
      }
      return null;
    },
    /**
     * Rows that actually exist in the database — NOT create requests. A failed
     * create makes 3 requests (notionRequest retries) and 0 rows; "no
     * half-created state" is a claim about rows.
     */
    createCount: () => notion.createdPages().length,
    createRequests: () => notion.createCount(),
    /** Geometry of the problem header — the AC1 evidence. */
    layout: () => {
      const header = document.querySelector(".problem-header");
      const style = header ? getComputedStyle(header) : null;
      return {
        header: rect(header),
        headerDisplay: style?.display,
        number: rect($("problem-number")),
        badge: rect($("problem-difficulty")),
        button: rect($("btn-mark-todo")),
        buttonHidden: !!$("btn-mark-todo")?.classList.contains("hidden"),
        buttonDisabled: !!$("btn-mark-todo")?.disabled,
        buttonLabel: $("btn-mark-todo")?.textContent.trim().replace(/\s+/g, " "),
        buttonWhiteSpace: $("btn-mark-todo")
          ? getComputedStyle($("btn-mark-todo")).whiteSpace
          : null,
        docScrollW: document.documentElement.scrollWidth,
        docClientW: document.documentElement.clientWidth,
        // The popup is a fixed 400px panel (styles.css `body { width: 400px }`).
        // Measured separately from the document so the QA banner can never be
        // what fails the overflow check.
        appScrollW: document.getElementById("app")?.scrollWidth,
        appClientW: document.getElementById("app")?.clientWidth,
        bodyW: Math.round(document.body.getBoundingClientRect().width),
        cardScrollW: document.getElementById("card-problem-info")?.scrollWidth,
        cardClientW: document.getElementById("card-problem-info")?.clientWidth,
      };
    },
    ui: () => ({
      saveLabel: $("btn-save")?.querySelector("span")?.textContent,
      quickActionsHidden: !!$("card-quick-actions")?.classList.contains("hidden"),
      attempts: $("input-attempts")?.value,
      doneChecked: !!$("input-done")?.checked,
      status: $("save-status")?.textContent,
      statusClass: $("save-status")?.className,
      markTodoHidden: !!$("btn-mark-todo")?.classList.contains("hidden"),
      markTodoDisabled: !!$("btn-mark-todo")?.disabled,
    }),
    sent: () =>
      messages.map((m) => ({
        action: m.action,
        data: { ...m.data, apiKey: undefined, databaseId: undefined },
      })),
    runDueCheck: async () => {
      notifications.length = 0;
      await bg.checkDueReviews();
      return notifications.map((n) => n.message);
    },
  };

  // --- on-page evidence banner ---------------------------------------------
  // The screenshots are the deliverable, so the invisible state (what the
  // Notion row now holds, which day is "today" locally vs in UTC, what the
  // popup actually sent) is rendered into the page rather than left in the
  // console where a screenshot cannot show it.
  window.addEventListener("DOMContentLoaded", () => {
    const bar = document.createElement("div");
    bar.id = "qa-banner";
    // `overflow-wrap:anywhere` + `max-width` so the banner itself can never be
    // what makes the document scroll horizontally — the AC1 overflow check
    // must measure the popup, not the harness chrome around it.
    bar.style.cssText =
      "position:sticky;top:0;z-index:9999;font:10.5px/1.45 ui-monospace,monospace;" +
      "background:#0f172a;color:#e2e8f0;padding:6px 10px;border-bottom:2px solid #38bdf8;" +
      "max-width:100%;box-sizing:border-box;overflow-wrap:anywhere;word-break:break-all";
    const esc = (s) =>
      String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const val = (v) => `<b style="color:#fbbf24">${esc(v === undefined ? "(empty)" : v)}</b>`;
    const render = () => {
      const row = window.__qa.row();
      const p = row?.properties || {};
      const last = messages[messages.length - 1];
      bar.innerHTML =
        `<b style="color:#38bdf8">QA harness</b> · clock frozen ${QA_NOW} · ` +
        `local day <b style="color:#4ade80">${window.__qa.localDay}</b> · ` +
        `UTC day <b style="color:#f87171">${window.__qa.utcDay}</b><br>` +
        `<b style="color:#38bdf8">Notion row</b> ${row ? "" : "<i>none yet</i>"}` +
        (row
          ? `Spaced Repetition=${val(p["Spaced Repetition"]?.date?.start)} · ` +
            `Attempts=${val(p["Attempts"]?.number)} · ` +
            `Done=${val(p["Done"]?.checkbox)} · ` +
            `First attempt=${val(p["Date (of first attempt)"]?.date?.start)} · ` +
            `Expertise=${val(p["My Expertise"]?.select?.name)} · ` +
            `body blocks=${val(row.children?.length)}`
          : "") +
        `<br><b style="color:#38bdf8">rows created</b> ${val(notion.createdPages().length)} ` +
        `<span style="color:#94a3b8">(POST /pages attempts: ${notion.createCount()})</span> · ` +
        `<b style="color:#38bdf8">last sent</b> ${
          last ? esc(JSON.stringify({ action: last.action, ...last.data, apiKey: "***", databaseId: "***" }).slice(0, 220)) : "(nothing yet)"
        }` +
        (window.__qa.dueMessage
          ? `<br><b style="color:#38bdf8">hourly alarm</b> <b style="color:#4ade80">${esc(
              window.__qa.dueMessage,
            )}</b>`
          : "");
    };
    render();
    window.__qa.refreshBanner = render;
    document.body.prepend(bar);
    setInterval(render, 200);
  });

  // --- demo driver (headless screenshot capture) ---------------------------
  const demo = params.get("demo");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 6000) => {
    const t0 = performance.now();
    while (performance.now() - t0 < ms) {
      if (fn()) return true;
      await sleep(50);
    }
    return false;
  };

  window.addEventListener("load", async () => {
    // Wait for the popup's own checkExisting round-trip to resolve — the
    // button's visibility is gated on it, so anything measured before it
    // lands is meaningless.
    await until(() => messages.some((m) => m.action === "checkExisting"));
    await sleep(250);

    if (params.get("race") === "1") {
      // A row appears in Notion after the popup's lookup said there was none:
      // the button is on screen, and the click must still not double-create.
      notion.setPage("qa-raced-1", {
        "S No.": { number: PROBLEM_NUMBER },
        Question: { title: [{ text: { content: TITLE } }] },
        Attempts: { number: 2 },
        "Spaced Repetition": { date: { start: "2026-09-30" } },
      });
    }
    if (params.get("fail") === "1") {
      // Armed only now, so it hits the create under test and not the popup's
      // start-up read.
      notion.failNextWith(500, "QA forced Notion failure", 3, /^pages$/);
    }

    if (demo === "marked" || demo === "update" || demo === "due") {
      $("btn-mark-todo")?.click();
      await until(() => messages.some((m) => m.action === "markTodo"));
      await until(() => $("btn-mark-todo")?.disabled === false, 12000);
      await sleep(300);
    }
    if (demo === "update") {
      // Stand in for the user actually attempting the problem: pick an
      // expertise, tick Done, write a note. Without real content the update
      // has nothing to write into the page body and the "content now lands"
      // half of AC6 would not be exercised.
      const notes = $("input-notes");
      if (notes) {
        notes.value = "Two pointers; watch the mid overflow.";
        notes.dispatchEvent(new Event("input", { bubbles: true }));
      }
      const done = $("input-done");
      if (done && !done.checked) {
        done.checked = true;
        done.dispatchEvent(new Event("change", { bubbles: true }));
      }
      document
        .querySelector('.expertise-btn[data-expertise="High"], [data-expertise="High"]')
        ?.click();
      await sleep(100);
      $("btn-save")?.click();
      await until(() => messages.some((m) => m.action === "saveToNotion"), 12000);
      await until(() => $("btn-save")?.disabled === false, 12000);
      await sleep(300);
    }
    if (demo === "due") {
      const msgs = await window.__qa.runDueCheck();
      window.__qa.dueMessage = msgs[0] || "(no notification)";
    }

    window.__qa.refreshBanner?.();
    window.__qa.demoDone = true;
  });
})();
