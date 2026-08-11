/**
 * super-board QA — issue #10, popup layer boot script.
 *
 * Injected into popup.html immediately BEFORE popup.js, so the popup boots
 * against this `chrome` object. Two things make this harness stronger than a
 * hand-written fake background:
 *
 *   1. `chrome.runtime.sendMessage` is routed into the REAL background.js
 *      (fetched and evaluated here with `chrome`/`fetch`/`Date` shadowed), so
 *      the popup→background contract is exercised, not re-implemented. The
 *      Builder's handoff warned that issue #1's frozen stub still models the
 *      old `days`-only contract — this harness cannot drift that way.
 *   2. `fetch` under the background is the same stateful Notion double the
 *      Node suite uses (suite/notion-mock.mjs, served as a classic script), so
 *      "what the Notion page holds" is a real read-back, not a request log.
 *
 * The clock is frozen at an instant where the UTC day and the local day
 * disagree, which is the AC4 case: on this host (America/Chicago, UTC-5 in
 * August) 2026-08-11T02:00:00Z is 2026-08-10 21:00 local.
 *
 * Query params:
 *   ?intervals=1,3,7 | 0,0,0   seed the per-expertise review intervals (AC3)
 *   ?fail=1                    force the next Notion write to fail (AC5 rollback)
 *   ?demo=before|revisit|tomorrow|due
 *                              drive the UI to a settled state for screenshot
 *                              capture; sets window.__qa.demoDone when finished
 */
(() => {
  const params = new URLSearchParams(location.search);
  const QA_NOW = params.get("now") || "2026-08-11T02:00:00Z";
  const PAGE_ID = "qa-page-1";
  const PROBLEM_NUMBER = 1;

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
  const seedIntervals = (params.get("intervals") || "1,3,7").split(",").map(Number);

  const notion = window.__qaCreateNotionMock({
    [PAGE_ID]: {
      "S No.": { number: PROBLEM_NUMBER },
      Question: { title: [{ text: { content: "Two Sum" } }] },
      "Spaced Repetition": { date: { start: "2026-09-30" } },
      Attempts: { number: 3 },
      "My Expertise": { select: { name: "Medium" } },
      Level: { select: { name: "Easy" } },
      Done: { checkbox: false },
      "Time Complexity": { select: { name: "O(n)" } },
      "Space Complexity": { select: { name: "O(n)" } },
    },
  });
  notion.pages.get(PAGE_ID).last_edited_time = new Date(
    fixed - 86400000,
  ).toISOString();

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
    spacedRepetitionIntervals: {
      Low: seedIntervals[0],
      Medium: seedIntervals[1],
      High: seedIntervals[2],
    },
  };
  const localStore = {};
  const storageReads = []; // every key list the popup asks chrome.storage.sync for

  const pick = (keys, store, log) => {
    const list = Array.isArray(keys)
      ? keys
      : typeof keys === "string"
        ? [keys]
        : Object.keys(store);
    if (log) storageReads.push([...list]);
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
        get: async (k) => pick(k, syncStore, false),
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
        get: async (k) => pick(k, syncStore, true),
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
  window.__qa = {
    now: QA_NOW,
    pageId: PAGE_ID,
    notion,
    messages,
    notifications,
    storageReads,
    syncStore,
    utcDay: new RealDate(fixed).toISOString().split("T")[0],
    localDay: bg.localDateString(),
    reviewDate: () => notion.reviewDate(PAGE_ID),
    attempts: () => notion.attempts(PAGE_ID),
    /** Run the hourly alarm's due check against the current mock state. */
    runDueCheck: async () => {
      notifications.length = 0;
      await bg.checkDueReviews();
      return notifications.map((n) => n.message);
    },
    /** Keys the popup asked chrome.storage.sync for, flattened. */
    storageKeysSeen: () => [...new Set(storageReads.flat())],
  };

  // --- on-page evidence banner ---------------------------------------------
  // The screenshots are the deliverable, so the invisible state (what the
  // Notion page now holds, which day is "today" locally vs in UTC, what the
  // popup actually sent) is rendered into the page rather than left in the
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
      bar.innerHTML =
        `<b style="color:#38bdf8">QA harness</b> · clock frozen ${QA_NOW} · ` +
        `intervals ${esc(JSON.stringify(seedIntervals))}<br>` +
        `local day <b style="color:#4ade80">${window.__qa.localDay}</b> · ` +
        `UTC day <b style="color:#f87171">${window.__qa.utcDay}</b> ` +
        `<span style="color:#94a3b8">(they differ — AC4)</span><br>` +
        `<b style="color:#38bdf8">Notion page</b> Spaced Repetition = ` +
        `<b style="color:#fbbf24">${window.__qa.reviewDate() ?? "(none)"}</b> · ` +
        `Attempts = <b style="color:#fbbf24">${window.__qa.attempts()}</b><br>` +
        `<b style="color:#38bdf8">sent</b> ${
          last ? esc(JSON.stringify({ ...last.data, apiKey: "***" })) : "(nothing yet)"
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
  if (demo) {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const until = async (fn, ms = 5000) => {
      const t0 = performance.now();
      while (performance.now() - t0 < ms) {
        if (fn()) return true;
        await sleep(50);
      }
      return false;
    };
    window.addEventListener("load", async () => {
      // Wait for the popup to finish checkExisting — the quick-action buttons
      // are only meaningful once an existing Notion page has been resolved.
      await until(() => document.getElementById("input-attempts")?.value === "3");

      // Arm the forced failure only now, so it hits the write under test and
      // not the popup's start-up read. Reset the storage log at the same point
      // so `storageKeysSeen()` reports what the CLICK read, not what start-up
      // read — that distinction is the observable form of AC3.
      if (params.get("fail") === "1") notion.failNextWith(500, "QA forced failure");
      storageReads.length = 0;

      const settled = (action) =>
        until(
          () =>
            messages.some((m) => m.action === action) &&
            !document.getElementById("btn-revisit").disabled &&
            !document.getElementById("btn-mark-review").disabled,
        );

      if (demo === "revisit" || demo === "due") {
        document.getElementById("btn-revisit").click();
        await settled("updateSpacedRepetition");
        await sleep(250);
      }
      if (demo === "tomorrow") {
        document.getElementById("btn-mark-review").click();
        await settled("updateSpacedRepetition");
        await sleep(250);
      }
      if (demo === "due") {
        const msgs = await window.__qa.runDueCheck();
        window.__qa.dueMessage = msgs[0] || "(no notification)";
      }
      window.__qa.refreshBanner?.();
      window.__qa.demoDone = true;
    });
  } else {
    window.addEventListener("load", () => {
      window.__qa.demoDone = true;
    });
  }
})();
