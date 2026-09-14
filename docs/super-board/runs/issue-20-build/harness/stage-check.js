/**
 * Builder-side local check for issue #20 — "Spaced Repetition switch stages its
 * change until Update in Notion, and turns on to today + expertise interval".
 *
 * Two halves, both against the REAL shipped files (nothing is rewritten; the
 * globals each file touches are injected as `Function` parameters so they
 * shadow the real ones inside the file's own scope):
 *
 *   S1  popup.js  — the staging state machine and what saveToNotion puts on the
 *                   wire. Proves the switch sends nothing on flip, that the
 *                   interval is resolved at SAVE time, and that a failed save
 *                   leaves the flip staged.
 *   S2  background.js — buildProperties' four-way date precedence including the
 *                   new "staged on, interval 0 → today" arm, plus an end-to-end
 *                   save through the message router so the flag is proven to
 *                   survive saveToNotion → updatePageContent → buildProperties.
 *
 * Usage:  node docs/super-board/runs/issue-20-build/harness/stage-check.js
 *         (run from the repo root; TZ_NAME overrides the frozen zone)
 */
process.env.TZ = process.env.TZ_NAME || "America/New_York";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "../../../../..");
const ISO_NOW = "2026-08-22T15:00:00Z"; // 11:00 local in America/New_York
const TODAY = "2026-08-22";

let failures = 0;

function eq(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) {
    console.log(`        expected ${JSON.stringify(expected)}`);
    console.log(`        actual   ${JSON.stringify(actual)}`);
  }
}

function ok(label, cond) {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
}

function head(t) {
  console.log(`\n${t}\n${"-".repeat(t.length)}`);
}

function frozenDateAt(isoNow) {
  return class FrozenDate extends Date {
    constructor(...args) {
      if (args.length === 0) super(isoNow);
      else super(...args);
    }
    static now() {
      return new Date(isoNow).getTime();
    }
  };
}

// ---------------------------------------------------------------------------
// S1 — popup.js in a DOM sandbox
// ---------------------------------------------------------------------------

/** Minimal element double: enough surface for the popup's own DOM writes. */
function makeElement(id) {
  const classes = new Set();
  return {
    id,
    checked: id === "input-spaced-repetition" || id === "input-done",
    value: "",
    textContent: "",
    innerHTML: "",
    title: "",
    disabled: false,
    classList: {
      add: (...c) => c.forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      toggle: (c, force) => {
        const on = force === undefined ? !classes.has(c) : !!force;
        if (on) classes.add(c);
        else classes.delete(c);
        return on;
      },
      contains: (c) => classes.has(c),
    },
    addEventListener: () => {},
    querySelector: () => null,
    querySelectorAll: () => [],
    focus: () => {},
    blur: () => {},
    select: () => {},
    click: () => {},
  };
}

function loadPopup({ sendMessage, sync }) {
  const src = fs.readFileSync(path.join(ROOT, "popup.js"), "utf8");
  const els = new Map();
  const el = (id) => {
    if (!els.has(id)) els.set(id, makeElement(id));
    return els.get(id);
  };

  const documentStub = {
    getElementById: el,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    createElement: () => makeElement("created"),
    body: makeElement("body"),
  };

  const chromeStub = {
    runtime: { sendMessage, getURL: (p) => p, lastError: null },
    storage: {
      sync: { get: async () => ({ ...sync }), set: async () => {} },
      local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
    },
    tabs: { query: async () => [], create: () => {}, sendMessage: async () => {} },
    scripting: { executeScript: async () => [{ result: null }] },
  };

  const windowStub = { close: () => {}, addEventListener: () => {} };

  const factory = new Function(
    "document",
    "chrome",
    "window",
    "navigator",
    "Date",
    `${src}
; return {
  DOM,
  el: (id) => document.getElementById(id),
  effectiveSpacedRepetitionOn,
  setSpacedRepetitionToggle,
  stageSpacedRepetition,
  saveToNotion,
  peek: () => ({
    pending: pendingSpacedRepetition,
    stored: notionSpacedRepetitionOn,
  }),
  setState: (s) => {
    if ("existingPageId" in s) existingPageId = s.existingPageId;
    if ("selectedExpertise" in s) selectedExpertise = s.selectedExpertise;
    if ("title" in s) problemData.title = s.title;
    if ("number" in s) problemData.number = s.number;
  },
};`,
  );

  return factory(
    documentStub,
    chromeStub,
    windowStub,
    { userAgent: "node" },
    frozenDateAt(ISO_NOW),
  );
}

/** Fresh popup + message spy, hydrated to a known stored state. */
function popupAt(storedOn, { expertise = "Medium", intervals, saveResponse } = {}) {
  const sent = [];
  const reply =
    saveResponse ||
    ((msg) => ({ success: true, updated: true, pageId: "page-1", attempts: 4 }));
  const pop = loadPopup({
    sendMessage: async (msg) => {
      sent.push(msg);
      return reply(msg);
    },
    sync: {
      notionApiKey: "secret_k",
      notionDatabaseId: "db_1",
      spacedRepetitionIntervals: intervals || { Low: 1, Medium: 3, High: 7 },
    },
  });
  pop.setState({
    existingPageId: "page-1",
    selectedExpertise: expertise,
    title: "Two Sum",
    number: 1,
  });
  pop.setSpacedRepetitionToggle(storedOn);
  sent.length = 0; // hydration is not user traffic
  return { pop, sent };
}

const hint = (pop) => pop.el("spaced-repetition-hint").textContent;
const isStaged = (pop) =>
  pop.el("spaced-repetition-row").classList.contains("is-staged");
const flip = (pop, to) => {
  // The browser flips the checkbox before the change handler runs.
  pop.el("input-spaced-repetition").checked = to;
  pop.stageSpacedRepetition();
};
const lastSave = (sent) => sent.filter((m) => m.action === "saveToNotion").pop();

async function s1() {
  head("S1 · popup.js — the switch stages, and the save reads it");

  // AC1 + AC2 — flipping writes nothing and reads as unsaved.
  {
    const { pop, sent } = popupAt(true);
    flip(pop, false);
    eq("flip off sends no message at all", sent, []);
    ok("flip off marks the row staged", isStaged(pop));
    eq("hint says what the update will do", hint(pop), "Will clear on update");
    eq("the switch shows the staged position", pop.el("input-spaced-repetition").checked, false);
    eq("state: pending off over stored on", pop.peek(), { pending: false, stored: true });
  }
  {
    const { pop, sent } = popupAt(false);
    flip(pop, true);
    eq("flip on sends no message at all", sent, []);
    eq("hint on staged on", hint(pop), "Will schedule on update");
  }

  // AC6 — staging back to the stored state is not a queued no-op.
  {
    const { pop } = popupAt(true);
    flip(pop, false);
    flip(pop, true);
    eq("off → on → off round trip unstages", pop.peek(), { pending: null, stored: true });
    ok("row is no longer staged", !isStaged(pop));
    eq("hint is back to stored state", hint(pop), "Due date set");
  }

  // AC3 — staged off clears through the existing flag.
  {
    const { pop, sent } = popupAt(true);
    flip(pop, false);
    await pop.saveToNotion();
    const save = lastSave(sent);
    eq("staged off → clearSpacedRepetition", save.data.clearSpacedRepetition, true);
    eq("staged off → no today fallback", save.data.scheduleSpacedRepetitionToday, false);
    eq("after a successful clear the switch reads off, unstaged", pop.peek(), {
      pending: null,
      stored: false,
    });
    ok("staged flag dropped", !isStaged(pop));
  }

  // AC4 — staged on writes today + the expertise interval, resolved at save time.
  {
    const { pop, sent } = popupAt(false, { expertise: "Medium" });
    flip(pop, true);
    await pop.saveToNotion();
    let save = lastSave(sent);
    eq("staged on (Medium) → days 3", save.data.spacedRepetitionDays, 3);
    eq("staged on → not a clear", save.data.clearSpacedRepetition, false);
    eq("staged on → no today fallback when the interval is real", save.data.scheduleSpacedRepetitionToday, false);
    eq("after a successful schedule the switch reads on, unstaged", pop.peek(), {
      pending: null,
      stored: true,
    });
  }
  {
    // Expertise changed AFTER staging: the interval must be read at save time.
    const { pop, sent } = popupAt(false, { expertise: "Medium" });
    flip(pop, true);
    pop.setState({ selectedExpertise: "High" });
    await pop.saveToNotion();
    eq("expertise changed after staging → High's 7 days", lastSave(sent).data.spacedRepetitionDays, 7);
  }

  // AC5 — interval 0 for the selected level: fall back to today, never a lie.
  {
    const { pop, sent } = popupAt(false, {
      expertise: "High",
      intervals: { Low: 1, Medium: 3, High: 0 },
    });
    flip(pop, true);
    await pop.saveToNotion();
    const save = lastSave(sent);
    eq("staged on + interval 0 → today fallback", save.data.scheduleSpacedRepetitionToday, true);
    eq("staged on + interval 0 → days still 0", save.data.spacedRepetitionDays, 0);
    eq("the switch is left reading on, because a date WAS written", pop.peek(), {
      pending: null,
      stored: true,
    });
  }
  {
    // The fallback is for an EXPLICIT staging only: an ordinary save on a level
    // with reviews disabled still leaves the stored date alone (issue #3).
    const { pop, sent } = popupAt(true, {
      expertise: "High",
      intervals: { Low: 1, Medium: 3, High: 0 },
    });
    await pop.saveToNotion();
    const save = lastSave(sent);
    eq("unstaged on + interval 0 → no today fallback", save.data.scheduleSpacedRepetitionToday, false);
    eq("unstaged on + interval 0 → no clear", save.data.clearSpacedRepetition, false);
    eq("switch untouched, because nothing was written", pop.peek(), {
      pending: null,
      stored: true,
    });
  }

  // AC7 — a failed save leaves the flip staged so it can be retried.
  {
    const { pop, sent } = popupAt(true, {
      saveResponse: () => ({ success: false, error: "Notion is unavailable" }),
    });
    flip(pop, false);
    await pop.saveToNotion();
    ok("the save was attempted", !!lastSave(sent));
    eq("a failed save keeps the flip staged", pop.peek(), { pending: false, stored: true });
    ok("row still reads staged", isStaged(pop));
  }

  // AC9 — a quick action discards a staged flip (it just wrote a real date).
  {
    const { pop } = popupAt(false);
    flip(pop, true); // stage ON over a cleared problem
    pop.setSpacedRepetitionToggle(true); // what revisitProblem() does on success
    eq("Review Today drops the staged flip", pop.peek(), { pending: null, stored: true });

    const { pop: p2 } = popupAt(true);
    flip(p2, false); // a staged OFF must not survive to clear tomorrow's date
    p2.setSpacedRepetitionToggle(true); // what markForReviewTomorrow() does
    eq("Review Tomorrow drops a staged off", p2.peek(), { pending: null, stored: true });
  }

  // AC10 — the issue #11 guarantee survives with nothing staged.
  {
    const { pop, sent } = popupAt(false);
    await pop.saveToNotion();
    eq("unstaged off still clears on a plain update", lastSave(sent).data.clearSpacedRepetition, true);
  }

  // AC8 — hydration drives the switch and stages nothing.
  {
    const { pop } = popupAt(true);
    eq("hydrated on", [pop.effectiveSpacedRepetitionOn(), hint(pop), isStaged(pop)], [true, "Due date set", false]);
    pop.setSpacedRepetitionToggle(false);
    eq("hydrated off", [pop.effectiveSpacedRepetitionOn(), hint(pop), isStaged(pop)], [false, "No reviews", false]);
  }
}

// ---------------------------------------------------------------------------
// S2 — background.js
// ---------------------------------------------------------------------------

function loadBackground(fetchStub) {
  const src = fs.readFileSync(path.join(ROOT, "background.js"), "utf8");
  const noop = () => {};
  const chromeStub = {
    runtime: {
      onMessage: { addListener: noop },
      onStartup: { addListener: noop },
      onInstalled: { addListener: noop },
      getURL: (p) => p,
      lastError: null,
    },
    alarms: { create: noop, clear: noop, onAlarm: { addListener: noop } },
    storage: { sync: { get: async () => ({}) }, local: { get: async () => ({}), set: noop } },
    tabs: { create: noop, onUpdated: { addListener: noop }, query: async () => [] },
    notifications: { create: noop, onClicked: { addListener: noop } },
    action: { setBadgeText: noop, setBadgeBackgroundColor: noop },
  };
  const factory = new Function(
    "chrome",
    "fetch",
    "Date",
    `${src}
; return { DATABASE_SCHEMA, buildProperties, saveToNotion, localDateString, localDateInDays };`,
  );
  return factory(chromeStub, fetchStub, frozenDateAt(ISO_NOW));
}

async function s2() {
  head("S2 · background.js — the date branch and its threading");

  const requests = [];
  let schemaProps = {};
  async function fetchStub(url, options = {}) {
    const body = options.body ? JSON.parse(options.body) : null;
    requests.push({ url, method: options.method, body });
    const okRes = (json) => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => json,
    });
    if (/\/databases\/[^/]+\/query$/.test(url)) return okRes({ results: [], has_more: false });
    if (/\/databases\/[^/]+$/.test(url)) return okRes({ properties: schemaProps });
    if (/\/blocks\/[^/]+\/children/.test(url)) return okRes({ results: [], has_more: false });
    return okRes({ id: "page-1", properties: { Attempts: { number: 3 } } });
  }

  const bg = loadBackground(fetchStub);
  schemaProps = Object.fromEntries(
    Object.entries(bg.DATABASE_SCHEMA).map(([name, cfg]) => [
      name,
      { id: name, name, type: cfg.type },
    ]),
  );

  const PROBLEM = { title: "Two Sum", number: 1, difficulty: "Easy", tags: [] };
  const dateOf = (props) => props["Spaced Repetition"];

  // The four-way precedence, as one table.
  eq(
    "clear beats the today fallback",
    dateOf(bg.buildProperties(PROBLEM, "page-1", 7, "Question", true, true)),
    { date: null },
  );
  eq(
    "staged on + interval 0 → today",
    dateOf(bg.buildProperties(PROBLEM, "page-1", 0, "Question", false, true)),
    { date: { start: TODAY } },
  );
  eq(
    "ordinary schedule → today + days",
    dateOf(bg.buildProperties(PROBLEM, "page-1", 3, "Question", false, false)),
    { date: { start: "2026-08-25" } },
  );
  eq(
    "interval 0, nothing staged → date left alone",
    dateOf(bg.buildProperties(PROBLEM, "page-1", 0, "Question", false, false)),
    undefined,
  );

  // End-to-end: the flag has to survive saveToNotion → updatePageContent →
  // buildProperties, which is three positional argument lists.
  requests.length = 0;
  const res = await bg.saveToNotion({
    apiKey: "secret_k",
    databaseId: "db_1",
    existingPageId: "page-1",
    spacedRepetitionDays: 0,
    clearSpacedRepetition: false,
    scheduleSpacedRepetitionToday: true,
    incrementAttempts: false,
    problem: { ...PROBLEM, code: "", language: "python", notes: "", remark: "" },
  });
  ok("the save reported success", res && res.success !== false);
  const patch = requests.filter(
    (r) => r.method === "PATCH" && r.body && r.body.properties,
  );
  const written = patch
    .map((r) => r.body.properties["Spaced Repetition"])
    .filter(Boolean)
    .pop();
  eq("save with the today flag PATCHes today's date", written, {
    date: { start: TODAY },
  });
}

(async () => {
  console.log(`TZ=${process.env.TZ}  frozen at ${ISO_NOW}  (local day ${TODAY})`);
  await s1();
  await s2();
  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
  process.exit(failures === 0 ? 0 : 1);
})();
