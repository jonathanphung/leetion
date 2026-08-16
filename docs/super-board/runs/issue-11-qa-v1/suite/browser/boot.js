/**
 * super-board QA — issue #11, popup layer boot script.
 *
 * Injected into popup.html immediately BEFORE popup.js, so the popup boots
 * against this `chrome` object. Two things make this stronger than a
 * hand-written fake background:
 *
 *   1. `chrome.runtime.sendMessage` is routed into the REAL background.js
 *      (fetched and evaluated here with `chrome`/`fetch`/`Date` shadowed), so
 *      the popup→background contract is exercised, not re-implemented.
 *   2. `fetch` under the background is the same stateful Notion double the
 *      Node suite uses (suite/notion-mock.mjs, served as a classic script), so
 *      "what the Notion page holds" is a real read-back, not a request log.
 *
 * The clock is frozen at an instant where the UTC day and the local day
 * disagree (on this host, America/Chicago at UTC-5 in August,
 * 2026-08-16T02:00:00Z is 2026-08-15 21:00 local) so a screenshot that shows
 * "due today" is showing the user's today, not UTC's.
 *
 * Query params:
 *   ?seed=dated|empty|none   what Notion holds for this problem when the popup
 *                            opens: a review date, an emptied date, or no page
 *                            at all (the AC4 gating case)
 *   ?fail=1                  force the write under test to fail (AC7 rollback)
 *   ?demo=open|clear|enable|save
 *                            drive the UI to a settled state for screenshot
 *                            capture; sets window.__qa.demoDone when finished
 */
(() => {
  const params = new URLSearchParams(location.search);
  const QA_NOW = params.get("now") || "2026-08-16T02:00:00Z";
  const SEED = params.get("seed") || "dated";
  const PAGE_ID = "qa-page-1";
  const PROBLEM_NUMBER = 1;
  const FAR_FUTURE = "2026-09-30";

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

  const basePage = {
    "S No.": { number: PROBLEM_NUMBER },
    Question: { title: [{ text: { content: "Two Sum" } }] },
    Attempts: { number: 3 },
    "My Expertise": { select: { name: "Medium" } },
    Level: { select: { name: "Easy" } },
    Done: { checkbox: false },
    "Time Complexity": { select: { name: "O(n)" } },
    "Space Complexity": { select: { name: "O(n)" } },
  };
  if (SEED === "dated") basePage["Spaced Repetition"] = { date: { start: FAR_FUTURE } };
  if (SEED === "empty") basePage["Spaced Repetition"] = { date: null };

  // `seed=none` seeds a DIFFERENT problem number, so checkExisting genuinely
  // finds nothing for problem 1 — the state a first-ever visit is in.
  const seedPages =
    SEED === "none"
      ? { "qa-other": { ...basePage, "S No.": { number: 999 } } }
      : { [PAGE_ID]: basePage };

  const notion = window.__qaCreateNotionMock(seedPages);
  if (notion.pages.get(PAGE_ID)) {
    notion.pages.get(PAGE_ID).last_edited_time = new Date(fixed - 86400000).toISOString();
  }

  // NOTE: `?fail=1` is armed by the demo driver immediately before the click,
  // not here — arming it at boot would take down the popup's initial
  // checkExisting instead of the write under test.

  // --- the real background.js, with its three globals shadowed -------------
  const bgSrc = sync("/background.js");
  const listeners = [];
  const notifications = [];

  const syncStore = {
    notionApiKey: "qa-test-key",
    notionDatabaseId: "qa-db-1",
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
      query: async () => [{ id: 1, url: "https://leetcode.com/problems/two-sum/" }],
      sendMessage: (tabId, msg, cb) => {
        if (typeof cb === "function") cb(undefined);
      },
    },
    scripting: {
      executeScript: async () => [
        {
          result: {
            number: PROBLEM_NUMBER,
            title: "Two Sum",
            difficulty: "Easy",
            code: "def twoSum(nums, target):\n    seen = {}\n    return []",
            language: "Python3",
            url: "https://leetcode.com/problems/two-sum/",
            scrapedTags: ["Array", "Hash Table"],
            userAttempts: null,
            questionContent:
              "Given an array of integers nums and an integer target, return indices of the two numbers such that they add up to target.",
            examples: [],
            constraints: [],
          },
        },
      ],
    },
  };

  // --- test hooks -----------------------------------------------------------
  const $ = (id) => document.getElementById(id);

  window.__qa = {
    now: QA_NOW,
    seed: SEED,
    pageId: PAGE_ID,
    notion,
    messages,
    notifications,
    utcDay: new RealDate(fixed).toISOString().split("T")[0],
    localDay: bg.localDateString(),
    reviewDate: () => notion.reviewDate(PAGE_ID),
    /** Distinguishes "emptied" from "never had the property". */
    reviewProp: () => JSON.stringify(notion.rawReview(PAGE_ID)),
    attempts: () => notion.attempts(PAGE_ID),
    toggle: () => {
      const el = $("input-spaced-repetition");
      return el ? { present: true, checked: el.checked, disabled: el.disabled } : { present: false };
    },
    hint: () => $("spaced-repetition-hint")?.textContent ?? null,
    quickActionsHidden: () => !!$("card-quick-actions")?.classList.contains("hidden"),
    successClasses: () => ({
      revisit: !!$("btn-revisit")?.classList.contains("quick-btn-success"),
      tomorrow: !!$("btn-mark-review")?.classList.contains("quick-btn-success"),
    }),
    /** Run the hourly alarm's due check against the current mock state. */
    runDueCheck: async () => {
      notifications.length = 0;
      await bg.checkDueReviews();
      return notifications.map((n) => n.message);
    },
  };

  // --- on-page evidence banner ---------------------------------------------
  // The screenshots are the deliverable, so the invisible state — what the
  // Notion page now holds, which day is "today" locally vs in UTC, what the
  // popup actually sent — is rendered into the page rather than left in the
  // console where a screenshot cannot show it.
  window.addEventListener("DOMContentLoaded", () => {
    const bar = document.createElement("div");
    bar.id = "qa-banner";
    bar.style.cssText =
      "position:sticky;top:0;z-index:9999;font:10.5px/1.45 ui-monospace,monospace;" +
      "background:#0f172a;color:#e2e8f0;padding:6px 10px;border-bottom:2px solid #38bdf8";
    const esc = (s) =>
      String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const render = () => {
      const last = messages[messages.length - 1];
      const t = window.__qa.toggle();
      bar.innerHTML =
        `<b style="color:#38bdf8">QA harness</b> · clock frozen ${QA_NOW} · seed=${esc(SEED)}` +
        (params.get("fail") === "1"
          ? ` · <b style="color:#f87171">Notion write forced to fail</b>`
          : "") +
        `<br>local day <b style="color:#4ade80">${window.__qa.localDay}</b> · ` +
        `UTC day <b style="color:#f87171">${window.__qa.utcDay}</b><br>` +
        `<b style="color:#38bdf8">Notion page</b> "Spaced Repetition" = ` +
        `<b style="color:#fbbf24">${esc(window.__qa.reviewProp())}</b><br>` +
        `<b style="color:#38bdf8">switch</b> ` +
        (t.present
          ? `<b style="color:${t.checked ? "#4ade80" : "#f87171"}">${t.checked ? "ON" : "OFF"}</b>` +
            ` · hint "${esc(window.__qa.hint())}"` +
            ` · quick-actions ${window.__qa.quickActionsHidden() ? "HIDDEN" : "visible"}`
          : `<b style="color:#f87171">not in DOM</b>`) +
        `<br><b style="color:#38bdf8">sent</b> ${
          last ? esc(JSON.stringify({ action: last.action, ...last.data, apiKey: "***" })).slice(0, 260) : "(nothing yet)"
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
    // The popup's start-up path always asks the background whether this
    // problem already exists; everything under test happens after that answer.
    await until(() => messages.some((m) => m.action === "checkExisting"));
    await sleep(400);

    if (params.get("fail") === "1") notion.failNextWith(500, "Notion is unavailable");

    const settled = () =>
      until(
        () =>
          messages.some((m) => m.action === "updateSpacedRepetition") &&
          document.getElementById("input-spaced-repetition")?.disabled === false,
      );

    if (demo === "clear" || demo === "enable") {
      const el = document.getElementById("input-spaced-repetition");
      // A real user click, not a programmatic `.checked =` — the browser's own
      // checkbox flip is what the handler's rollback has to undo.
      el.click();
      await settled();
      await sleep(300);
      window.__qa.dueMessage = (await window.__qa.runDueCheck())[0] || "(no notification)";
    }

    // The card's Notes call out the interaction with #10 in both directions:
    // a quick action that writes a date must flip the switch ON, and a clear
    // must drop the stale "review scheduled" highlight off both buttons.
    if (demo === "revisit" || demo === "revisit-then-clear") {
      document.getElementById("btn-revisit").click();
      await until(
        () =>
          messages.some((m) => m.action === "updateSpacedRepetition") &&
          document.getElementById("btn-revisit").disabled === false,
      );
      await sleep(300);
    }
    if (demo === "revisit-then-clear") {
      const before = window.__qa.successClasses();
      window.__qa.successBeforeClear = before;
      document.getElementById("input-spaced-repetition").click();
      await until(
        () =>
          messages.filter((m) => m.action === "updateSpacedRepetition").length >= 2 &&
          document.getElementById("input-spaced-repetition").disabled === false,
      );
      await sleep(300);
      window.__qa.dueMessage = (await window.__qa.runDueCheck())[0] || "(no notification)";
    }

    if (demo === "save") {
      document.getElementById("btn-save").click();
      await until(() => messages.some((m) => m.action === "saveToNotion"));
      await sleep(600);
      window.__qa.dueMessage = (await window.__qa.runDueCheck())[0] || "(no notification)";
    }

    window.__qa.refreshBanner?.();
    window.__qa.demoDone = true;
  });
})();
