/**
 * super-board QA — issue #20, popup layer boot script.
 *
 * Injected into popup.html immediately BEFORE popup.js, so the popup boots
 * against this `chrome` object. Two things make this stronger than a
 * hand-written fake background:
 *
 *   1. `chrome.runtime.sendMessage` is routed into the REAL background.js
 *      (fetched and evaluated here with `chrome`/`fetch`/`Date` shadowed), so
 *      the popup→background contract is exercised, not re-implemented. This
 *      matters more on this card than on any before it: the whole point of
 *      AC1 is that a message that used to be sent is no longer sent, and only
 *      a real router can tell "not sent" from "sent and ignored".
 *   2. `fetch` under the background is the same stateful Notion double the
 *      Node suite uses, so "what the Notion page holds" is a real read-back.
 *
 * The clock is frozen at an instant where the UTC day and the local day
 * disagree (on this host, America/Chicago at UTC-5 in August,
 * 2026-08-16T02:00:00Z is 2026-08-15 21:00 local) so an assertion that a save
 * wrote "today" is asserting the user's today, not UTC's.
 *
 * Query params:
 *   ?seed=dated|empty|none  what Notion holds when the popup opens: a review
 *                           date, an emptied date, or no page at all
 *   ?intervals=1-3-7        per-expertise review intervals (Low-Medium-High)
 *   ?fail=1                 force the write under test to fail (AC7)
 *   ?demo=<scenario>        drive the UI to a settled state and record checks;
 *                           sets window.__qa.demoDone when finished
 */
(() => {
  const params = new URLSearchParams(location.search);
  const QA_NOW = params.get("now") || "2026-08-16T02:00:00Z";
  const SEED = params.get("seed") || "dated";
  const PAGE_ID = "qa-page-1";
  const PROBLEM_NUMBER = 1;
  const FAR_FUTURE = "2026-09-30";
  const [iLow, iMed, iHigh] = (params.get("intervals") || "1-3-7")
    .split("-")
    .map(Number);

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
    "Date (of first attempt)": { date: { start: "2026-07-01" } },
  };
  if (SEED === "dated")
    basePage["Spaced Repetition"] = { date: { start: FAR_FUTURE } };
  if (SEED === "empty") basePage["Spaced Repetition"] = { date: null };

  // `seed=none` seeds a DIFFERENT problem number, so checkExisting genuinely
  // finds nothing for problem 1 — the state a first-ever visit is in.
  const seedPages =
    SEED === "none"
      ? { "qa-other": { ...basePage, "S No.": { number: 999 } } }
      : { [PAGE_ID]: basePage };

  const notion = window.__qaCreateNotionMock(seedPages);
  if (notion.pages.get(PAGE_ID)) {
    notion.pages.get(PAGE_ID).last_edited_time = new Date(
      fixed - 86400000,
    ).toISOString();
  }

  // --- the real background.js, with its three globals shadowed -------------
  const bgSrc = sync("/background.js");
  const listeners = [];
  const notifications = [];

  const syncStore = {
    notionApiKey: "qa-test-key",
    notionDatabaseId: "qa-db-1",
    spacedRepetitionIntervals: { Low: iLow, Medium: iMed, High: iHigh },
  };
  const localStore = {};

  const pick = (keys, store) => {
    const list = Array.isArray(keys)
      ? keys
      : typeof keys === "string"
        ? [keys]
        : Object.keys(store);
    const out = {};
    for (const k of list)
      if (k in store) out[k] = JSON.parse(JSON.stringify(store[k]));
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
      local: {
        get: async () => ({}),
        set: async () => {},
        remove: async () => {},
      },
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
    `${bgSrc}\n; return { checkDueReviews, localDateString, localDateInDays };`,
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
        { id: 1, url: "https://leetcode.com/problems/two-sum/" },
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
  const checks = [];

  /** Record one observable assertion. Deep-compared, so shapes are exact. */
  function check(ac, label, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    checks.push({ ac, label, ok, actual, expected });
    return ok;
  }

  window.__qa = {
    now: QA_NOW,
    seed: SEED,
    intervals: { Low: iLow, Medium: iMed, High: iHigh },
    pageId: PAGE_ID,
    notion,
    messages,
    notifications,
    checks,
    utcDay: new RealDate(fixed).toISOString().split("T")[0],
    localDay: bg.localDateString(),
    inDays: (n) => bg.localDateInDays(n),
    reviewDate: () => notion.reviewDate(PAGE_ID),
    /** Distinguishes "emptied" from "never had the property". */
    reviewProp: () => JSON.stringify(notion.rawReview(PAGE_ID)),
    toggle: () => {
      const el = $("input-spaced-repetition");
      return el
        ? { present: true, checked: el.checked, disabled: el.disabled }
        : { present: false };
    },
    /** The card's visible-staging contract: the class AND the paint it buys. */
    staged: () => !!$("spaced-repetition-row")?.classList.contains("is-staged"),
    stagedOutline: () => {
      const sw = document.querySelector(
        "#spaced-repetition-row .toggle-switch",
      );
      if (!sw) return null;
      const cs = getComputedStyle(sw);
      return { style: cs.outlineStyle, width: cs.outlineWidth };
    },
    hint: () => $("spaced-repetition-hint")?.textContent ?? null,
    saveStatus: () => $("save-status")?.textContent ?? null,
    successClasses: () => ({
      revisit: !!$("btn-revisit")?.classList.contains("quick-btn-success"),
      tomorrow: !!$("btn-mark-review")?.classList.contains("quick-btn-success"),
    }),
    /** Everything the popup has persisted as a form draft for this problem. */
    draft: () => localStore[`form_state_${PROBLEM_NUMBER}`] ?? null,
    /** Messages the popup sent, by action name. */
    sent: (action) => messages.filter((m) => m.action === action),
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
      "background:#0f172a;color:#e2e8f0;padding:6px 10px;border-bottom:2px solid #38bdf8;" +
      // The message dump is long; without this the banner widens the document
      // and every screenshot comes out wider than the popup it is showing.
      "overflow-wrap:anywhere;word-break:break-word";
    const esc = (s) =>
      String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const render = () => {
      const writes = messages.filter(
        (m) => m.action === "saveToNotion" || m.action === "updateSpacedRepetition",
      );
      const last = writes[writes.length - 1];
      const t = window.__qa.toggle();
      const staged = window.__qa.staged();
      bar.innerHTML =
        `<b style="color:#38bdf8">QA harness</b> · clock frozen ${QA_NOW} · seed=${esc(SEED)}` +
        ` · intervals ${iLow}/${iMed}/${iHigh}` +
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
            ` · <b style="color:${staged ? "#fbbf24" : "#94a3b8"}">${staged ? "STAGED (unsaved)" : "in sync with Notion"}</b>` +
            ` · hint "${esc(window.__qa.hint())}"`
          : `<b style="color:#f87171">not in DOM</b>`) +
        `<br><b style="color:#38bdf8">writes sent</b> ${writes.length}` +
        (last
          ? ` · last ${esc(
              JSON.stringify({
                action: last.action,
                ...pickWriteFields(last.data),
              }),
            ).slice(0, 240)}`
          : " · <b style=\"color:#4ade80\">none</b>") +
        (window.__qa.dueMessage
          ? `<br><b style="color:#38bdf8">hourly alarm</b> <b style="color:#4ade80">${esc(
              window.__qa.dueMessage,
            )}</b>`
          : "");
    };
    const pickWriteFields = (d = {}) => ({
      spacedRepetitionDays: d.spacedRepetitionDays,
      clearSpacedRepetition: d.clearSpacedRepetition,
      scheduleSpacedRepetitionToday: d.scheduleSpacedRepetitionToday,
      ...(d.setToday !== undefined ? { setToday: d.setToday } : {}),
      ...(d.days !== undefined ? { days: d.days } : {}),
      ...(d.clear !== undefined ? { clear: d.clear } : {}),
    });
    render();
    window.__qa.refreshBanner = render;
    document.body.prepend(bar);
    setInterval(render, 200);
  });

  // --- demo driver ----------------------------------------------------------
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

  const el = (id) => document.getElementById(id);
  const switchEl = () => el("input-spaced-repetition");

  /** A real user click on the switch — the browser flips the checkbox itself. */
  const flip = async () => {
    switchEl().click();
    await sleep(150);
  };

  const saveCount = () => window.__qa.sent("saveToNotion").length;
  const clickSave = async () => {
    const before = saveCount();
    el("btn-save").click();
    // Generous: notionRequest retries three times with exponential backoff, so
    // a deliberately failed save takes ~3s of real waiting before it reports.
    await until(
      () => saveCount() > before && el("btn-save").disabled === false,
      20000,
    );
    await sleep(400);
  };

  const pickExpertise = async (level) => {
    document.querySelector(`.expertise-btn[data-expertise="${level}"]`).click();
    await sleep(150);
  };

  window.addEventListener("load", async () => {
    // The popup's start-up path always asks the background whether this
    // problem already exists; everything under test happens after that answer.
    await until(() => messages.some((m) => m.action === "checkExisting"));
    await sleep(500);

    // ── AC8 — hydration, on every scenario, before anything is touched ──────
    if (SEED !== "none") {
      check(
        "AC8",
        `popup open on a ${SEED === "dated" ? "scheduled" : "cleared"} problem hydrates the switch from Notion, unstaged`,
        { checked: switchEl().checked, staged: window.__qa.staged() },
        { checked: SEED === "dated", staged: false },
      );
      check(
        "AC8",
        "…and the hint describes stored state, not a pending change",
        window.__qa.hint(),
        SEED === "dated" ? "Due date set" : "No reviews",
      );
    }

    const writesBefore = () =>
      messages.filter(
        (m) => m.action === "saveToNotion" || m.action === "updateSpacedRepetition",
      ).length;

    // ── AC1 + AC2 — flipping the switch stages, it does not write ──────────
    if (demo === "stage-off" || demo === "stage-off-save") {
      const before = writesBefore();
      const dateBefore = window.__qa.reviewDate();
      await flip();
      // Deliberately generous: an immediate write would have landed long
      // before this, so a quiet second is real evidence of "nothing sent".
      await sleep(1000);

      check("AC1", "flipping the switch sends no write message at all", writesBefore(), before);
      check(
        "AC1",
        'specifically: no "updateSpacedRepetition" message',
        window.__qa.sent("updateSpacedRepetition").length,
        0,
      );
      check(
        "AC1",
        "…and no Notion PATCH reached the page",
        notion.requestsFor(/^pages\//).filter((r) => r.method === "PATCH").length,
        0,
      );
      check("AC1", "the stored review date is untouched", window.__qa.reviewDate(), dateBefore);
      check("AC2", "the row is flagged .is-staged", window.__qa.staged(), true);
      check(
        "AC2",
        "…and styles.css actually paints that flag (computed outline on the switch)",
        window.__qa.stagedOutline(),
        { style: "solid", width: "2px" },
      );
      check(
        "AC2",
        "the hint says what the next update will do",
        window.__qa.hint(),
        "Will clear on update",
      );

      // AC11 — the staged flip must not leak into the persisted form draft.
      el("input-notes").value = "note typed after staging";
      el("input-notes").dispatchEvent(new Event("blur"));
      await sleep(300);
      const draft = window.__qa.draft();
      check("AC11", "a form draft was written (so the check below is real)", !!draft, true);
      check(
        "AC11",
        "…and it carries no spaced-repetition key (staging is session-only)",
        Object.keys(draft || {}).some((k) => /spaced/i.test(k)),
        false,
      );
    }

    // ── AC3 — saving a staged OFF empties the date ─────────────────────────
    if (demo === "stage-off-save") {
      await clickSave();
      check(
        "AC3",
        'the save sent clearSpacedRepetition: true',
        window.__qa.sent("saveToNotion").pop()?.data?.clearSpacedRepetition,
        true,
      );
      check(
        "AC3",
        'the Notion page now holds an explicit empty date, {"date": null}',
        notion.rawReview(PAGE_ID),
        { date: null },
      );
      check("AC7", "a successful save drops the staged flag", window.__qa.staged(), false);
      check(
        "AC7",
        "…and resyncs the switch to what was written",
        { checked: switchEl().checked, hint: window.__qa.hint() },
        { checked: false, hint: "No reviews" },
      );
      check(
        "AC3",
        "no stale 'review scheduled' highlight survives the clear",
        window.__qa.successClasses(),
        { revisit: false, tomorrow: false },
      );
      window.__qa.dueMessage =
        (await window.__qa.runDueCheck())[0] || "(no notification)";
      check(
        "AC3",
        "the hourly alarm raises nothing for the now-cleared problem",
        notifications.length,
        0,
      );
    }

    // ── AC4 — saving a staged ON writes today + the expertise interval ─────
    if (demo === "stage-on-save" || demo === "stage-on-high-save") {
      await flip();
      check("AC2", "staging on flags the row", window.__qa.staged(), true);
      check(
        "AC2",
        "…with the forward-looking hint",
        window.__qa.hint(),
        "Will schedule on update",
      );

      // The interval is resolved at SAVE time: switch expertise after staging
      // and the date that lands must follow the new level, not the old one.
      const level = demo === "stage-on-high-save" ? "High" : "Medium";
      if (level === "High") await pickExpertise("High");

      const expectedDays = level === "High" ? iHigh : iMed;
      await clickSave();

      check(
        "AC4",
        `save with the switch staged on under ${level} sends the ${level} interval`,
        window.__qa.sent("saveToNotion").pop()?.data?.spacedRepetitionDays,
        expectedDays,
      );
      check(
        "AC4",
        `…and the page holds today + ${expectedDays}, not today`,
        window.__qa.reviewDate(),
        window.__qa.inDays(expectedDays),
      );
      check(
        "AC4",
        "…which is a LOCAL calendar day, not the UTC one",
        window.__qa.reviewDate() === window.__qa.utcDay,
        false,
      );
      check("AC7", "the staged flag is dropped by the successful save", window.__qa.staged(), false);
      check(
        "AC7",
        "…and the switch reads on, in sync with Notion",
        { checked: switchEl().checked, hint: window.__qa.hint() },
        { checked: true, hint: "Due date set" },
      );
    }

    // ── AC5 — interval 0 for the selected level ────────────────────────────
    if (demo === "stage-on-zero-save") {
      await flip();
      await clickSave();
      check(
        "AC5",
        "a staged ON on a reviews-disabled level sets scheduleSpacedRepetitionToday",
        window.__qa.sent("saveToNotion").pop()?.data?.scheduleSpacedRepetitionToday,
        true,
      );
      check(
        "AC5",
        "…and the page gets TODAY rather than nothing at all",
        window.__qa.reviewDate(),
        window.__qa.localDay,
      );
      check(
        "AC5",
        "…so the switch is not left claiming a date that does not exist",
        { checked: switchEl().checked, staged: window.__qa.staged() },
        { checked: true, staged: false },
      );
    }

    if (demo === "unstaged-zero-save") {
      const before = window.__qa.reviewDate();
      await clickSave();
      check(
        "AC5",
        "an ORDINARY save on a reviews-disabled level does not set the flag",
        window.__qa.sent("saveToNotion").pop()?.data?.scheduleSpacedRepetitionToday,
        false,
      );
      check(
        "AC5",
        "…and leaves the stored date exactly as it was (issue #3 intact)",
        window.__qa.reviewDate(),
        before,
      );
    }

    // ── AC6 — staging back to the stored state unstages ────────────────────
    if (demo === "off-on-save") {
      await flip(); // on → off (staged)
      check("AC6", "first flip stages", window.__qa.staged(), true);
      await flip(); // off → on, which is what Notion holds
      check(
        "AC6",
        "flipping back to the stored state clears the pending change",
        window.__qa.staged(),
        false,
      );
      check(
        "AC6",
        "…and the hint goes back to describing Notion",
        window.__qa.hint(),
        "Due date set",
      );
      const before = window.__qa.reviewDate();
      await clickSave();
      check(
        "AC6",
        "the following save queues no clear (it was a no-op, not a change)",
        window.__qa.sent("saveToNotion").pop()?.data?.clearSpacedRepetition,
        false,
      );
      check(
        "AC6",
        "a scheduled problem is left scheduled — re-scheduled, never emptied",
        window.__qa.reviewDate() !== null && before !== null,
        true,
      );
    }

    // ── AC7 — a failed save keeps the staged flip for a retry ──────────────
    // Two demos on purpose. `fail-save-only` stops at the failure so there is
    // a screenshot OF the retained staged state; `fail-then-retry` carries on
    // and proves the retry then lands.
    if (demo === "fail-save-only" || demo === "fail-then-retry") {
      await flip(); // stage off
      // Narrowed to the page PATCH: a save probes the database schema first,
      // and an unfiltered failure would be spent on that probe's retries while
      // the write under test quietly succeeded.
      notion.failNextWith(
        500,
        "Notion is unavailable",
        3,
        (endpoint, method) => method === "PATCH" && /^pages\//.test(endpoint),
      );
      await clickSave();
      check(
        "AC7",
        "a failed save leaves the flip staged so it can be retried",
        window.__qa.staged(),
        true,
      );
      check(
        "AC7",
        "…with the switch still showing the user's pending choice",
        { checked: switchEl().checked, hint: window.__qa.hint() },
        { checked: false, hint: "Will clear on update" },
      );
      check(
        "AC7",
        "…and nothing was written to Notion",
        window.__qa.reviewDate(),
        FAR_FUTURE,
      );

      if (demo === "fail-then-retry") {
        notion.clearFailure();
        await clickSave();
        check(
          "AC7",
          "the retry goes through and clears the date",
          notion.rawReview(PAGE_ID),
          { date: null },
        );
        check("AC7", "…and now the staged flag drops", window.__qa.staged(), false);
      }
    }

    // ── AC9 — quick actions still write immediately and win the stage ──────
    if (demo === "review-today-discards-stage") {
      await flip(); // stage OFF on a scheduled problem
      check("AC9", "precondition: an off-flip is staged", window.__qa.staged(), true);

      el("btn-revisit").click();
      await until(
        () =>
          window.__qa.sent("updateSpacedRepetition").length > 0 &&
          el("btn-revisit").disabled === false,
      );
      await sleep(400);

      check(
        "AC9",
        "Review Today still writes immediately",
        window.__qa.sent("updateSpacedRepetition").pop()?.data?.setToday,
        true,
      );
      check(
        "AC9",
        "…landing today's local date on the page",
        window.__qa.reviewDate(),
        window.__qa.localDay,
      );
      check(
        "AC9",
        "the switch reflects the date just written, with nothing staged",
        { checked: switchEl().checked, staged: window.__qa.staged() },
        { checked: true, staged: false },
      );

      // The regression the AC is really about: the discarded "off" must not
      // come back at save time and delete the date the user just asked for.
      await clickSave();
      check(
        "AC9",
        "the discarded staged off does NOT clear on the next save",
        window.__qa.sent("saveToNotion").pop()?.data?.clearSpacedRepetition,
        false,
      );
      check(
        "AC9",
        "…so the problem is still scheduled after the save",
        window.__qa.reviewDate() !== null,
        true,
      );
      window.__qa.dueMessage =
        (await window.__qa.runDueCheck())[0] || "(no notification)";
    }

    if (demo === "review-tomorrow-discards-stage") {
      await flip();
      el("btn-mark-review").click();
      await until(
        () =>
          window.__qa.sent("updateSpacedRepetition").length > 0 &&
          el("btn-mark-review").disabled === false,
      );
      await sleep(400);
      check(
        "AC9",
        "Review Tomorrow still writes immediately (today + 1)",
        window.__qa.reviewDate(),
        window.__qa.inDays(1),
      );
      check(
        "AC9",
        "…and discards the staged flip too",
        { checked: switchEl().checked, staged: window.__qa.staged() },
        { checked: true, staged: false },
      );
    }

    // ── AC10 — an unstaged OFF still keeps the problem out (issue #11) ─────
    if (demo === "unstaged-off-save") {
      check(
        "AC10",
        "precondition: the switch reads off from Notion, with nothing staged",
        { checked: switchEl().checked, staged: window.__qa.staged() },
        { checked: false, staged: false },
      );
      await clickSave();
      check(
        "AC10",
        "a plain Update in Notion still sends the clear",
        window.__qa.sent("saveToNotion").pop()?.data?.clearSpacedRepetition,
        true,
      );
      check(
        "AC10",
        "…so the problem stays out of the rotation (issue #11 guarantee)",
        notion.rawReview(PAGE_ID),
        { date: null },
      );
      window.__qa.dueMessage =
        (await window.__qa.runDueCheck())[0] || "(no notification)";
      check(
        "AC10",
        "…and the hourly alarm still never notifies for it",
        notifications.length,
        0,
      );
    }

    window.__qa.refreshBanner?.();
    window.__qa.demoDone = true;
  });
})();
