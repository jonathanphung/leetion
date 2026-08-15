/**
 * Builder-side local check for issue #11 — "clear Spaced Repetition".
 *
 * Loads the real background.js in a sandbox (chrome + fetch + Date injected as
 * Function params so they shadow the globals inside the file's scope) and
 * asserts the exact JSON that reaches the Notion API for every path the card
 * touches:
 *
 *   AC1  updateSpacedRepetition({ clear: true })  → { date: null }
 *   AC2  checkExistingProblem surfaces the stored date (or null) to the popup
 *   AC5  checkDueReviews' filter cannot match an empty date
 *   AC6  a plain save on a cleared problem does not re-add a date
 *   +    regression: days / setToday / days:0 semantics are unchanged
 *
 * Usage: node clear-check.js <path-to-background.js>
 */
process.env.TZ = process.env.TZ_NAME || "America/New_York";

const fs = require("fs");

const src = fs.readFileSync(process.argv[2], "utf8");

// --- sandbox doubles ---------------------------------------------------------

const noop = () => {};

// The page checkExistingProblem will "find". `spacedRepetition` is read off
// this shape, so it doubles as the AC2 fixture.
let fixturePage = {
  id: "page-1",
  last_edited_time: "2026-08-15T10:00:00.000Z",
  properties: {
    "S No.": { number: 1 },
    Done: { checkbox: true },
    Attempts: { number: 3 },
    "Spaced Repetition": { date: { start: "2026-08-20" } },
  },
};

const settingsStub = {
  notionApiKey: "secret_k",
  notionDatabaseId: "db_1",
};

const chromeStub = {
  runtime: {
    onMessage: { addListener: noop },
    onStartup: { addListener: noop },
    onInstalled: { addListener: noop },
    getURL: (p) => p,
    lastError: null,
  },
  alarms: { create: noop, onAlarm: { addListener: noop } },
  storage: { sync: { get: async () => settingsStub } },
  tabs: { create: noop, onUpdated: { addListener: noop }, query: async () => [] },
  notifications: { create: noop, onClicked: { addListener: noop } },
  action: { setBadgeText: noop, setBadgeBackgroundColor: noop },
};

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

const requests = [];
let notified = null;

async function fetchStub(url, options) {
  const body = options.body ? JSON.parse(options.body) : null;
  requests.push({ url, method: options.method, body });

  const ok = (json) => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => json,
  });

  if (/\/databases\/[^/]+\/query$/.test(url)) {
    return ok({ results: fixturePage ? [fixturePage] : [], has_more: false });
  }
  if (/\/databases\/[^/]+$/.test(url)) {
    return ok({ properties: {} });
  }
  if (/\/blocks\/[^/]+\/children/.test(url)) {
    return ok({ results: [], has_more: false });
  }
  return ok({ id: "page-1", properties: fixturePage?.properties || {} });
}

function load(isoNow) {
  const factory = new Function(
    "chrome",
    "fetch",
    "Date",
    `${src}\n; return { localDateString, localDateInDays, updateSpacedRepetition, buildProperties, checkExistingProblem, checkDueReviews };`,
  );
  chromeStub.notifications.create = (id, opts) => {
    notified = { id, opts };
  };
  return factory(chromeStub, fetchStub, frozenDateAt(isoNow));
}

// --- assertions --------------------------------------------------------------

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${label}\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`,
  );
}

const lastBody = () => requests[requests.length - 1]?.body ?? null;
const reset = () => {
  requests.length = 0;
  notified = null;
};

(async () => {
  const isoNow = "2026-08-15T15:00:00Z"; // 11:00 local in America/New_York
  const today = "2026-08-15";
  const bg = load(isoNow);

  console.log(`TZ=${process.env.TZ}  frozen at ${isoNow}  (local day ${today})\n`);

  // --- AC1 — the clear intent writes an empty date ---------------------------
  reset();
  let res = await bg.updateSpacedRepetition({
    apiKey: "k",
    pageId: "p",
    clear: true,
  });
  check("AC1 clear:true PATCHes date:null", lastBody().properties, {
    "Spaced Repetition": { date: null },
  });
  check("AC1 clear reports success + cleared", [res.success, res.cleared, res.date], [
    true,
    true,
    null,
  ]);

  // Clear is the highest-precedence intent: a stale `days`/`setToday` riding
  // along in the same message must never resurrect a date.
  reset();
  await bg.updateSpacedRepetition({
    apiKey: "k",
    pageId: "p",
    clear: true,
    setToday: true,
    days: 7,
  });
  check(
    "AC1 clear wins over setToday + days",
    lastBody().properties["Spaced Repetition"],
    { date: null },
  );

  // Attempts still rides along untouched when both are sent.
  reset();
  await bg.updateSpacedRepetition({
    apiKey: "k",
    pageId: "p",
    clear: true,
    attempts: 5,
  });
  check("clear + attempts write in one PATCH", lastBody().properties, {
    "Spaced Repetition": { date: null },
    Attempts: { number: 5 },
  });

  // --- regression — the pre-existing intents are unchanged --------------------
  reset();
  await bg.updateSpacedRepetition({ apiKey: "k", pageId: "p", setToday: true });
  check("regression setToday still writes today", lastBody().properties, {
    "Spaced Repetition": { date: { start: today } },
  });

  reset();
  await bg.updateSpacedRepetition({ apiKey: "k", pageId: "p", days: 1 });
  check("regression days:1 still writes tomorrow", lastBody().properties, {
    "Spaced Repetition": { date: { start: "2026-08-16" } },
  });

  reset();
  res = await bg.updateSpacedRepetition({ apiKey: "k", pageId: "p", days: 0 });
  check(
    "regression days:0 alone still skips the request (NOT a clear)",
    [res.skipped, requests.length],
    [true, 0],
  );

  // --- AC6 — a plain save must not re-add a date on a cleared problem --------
  const problem = { title: "Two Sum", number: 1, expertise: "Medium" };

  const cleared = bg.buildProperties(problem, "page-1", 3, "Question", true);
  check("AC6 save with the switch off writes date:null", cleared["Spaced Repetition"], {
    date: null,
  });

  const scheduled = bg.buildProperties(problem, "page-1", 3, "Question", false);
  check(
    "AC6 regression: switch on still schedules today+interval",
    scheduled["Spaced Repetition"],
    { date: { start: "2026-08-18" } },
  );

  const disabledInterval = bg.buildProperties(problem, "page-1", 0, "Question", false);
  check(
    "AC6 regression: days:0 without the flag still omits the property",
    disabledInterval["Spaced Repetition"],
    undefined,
  );

  const clearedBeatsInterval = bg.buildProperties(problem, "page-1", 7, "Question", true);
  check(
    "AC6 clear flag wins over a non-zero interval",
    clearedBeatsInterval["Spaced Repetition"],
    { date: null },
  );

  // --- AC2 — the popup gets the real stored state ----------------------------
  reset();
  let existing = await bg.checkExistingProblem({
    apiKey: "k",
    databaseId: "db_1",
    problemNumber: 1,
  });
  check("AC2 a scheduled entry reports its date", existing.spacedRepetition, "2026-08-20");

  fixturePage = {
    ...fixturePage,
    properties: { ...fixturePage.properties, "Spaced Repetition": { date: null } },
  };
  reset();
  existing = await bg.checkExistingProblem({
    apiKey: "k",
    databaseId: "db_1",
    problemNumber: 1,
  });
  check("AC2 a cleared entry reports null", existing.spacedRepetition, null);

  // --- AC5 — the due query cannot match an empty date ------------------------
  reset();
  await bg.checkDueReviews();
  const dueFilter = requests.find((r) => /\/query$/.test(r.url))?.body?.filter;
  check("AC5 due query filters out empty dates", dueFilter, {
    and: [
      { property: "Spaced Repetition", date: { is_not_empty: true } },
      { property: "Spaced Repetition", date: { on_or_before: today } },
    ],
  });

  console.log(
    failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`,
  );
  process.exit(failures === 0 ? 0 : 1);
})();
