/**
 * Builder-side local check for issue #10.
 *
 * Loads the real background.js in a sandbox (chrome + fetch + Date injected as
 * Function params, so they shadow the globals inside the file's scope) and
 * exercises:
 *   1. localDateString / localDateInDays under a negative and a positive UTC
 *      offset, at a wall-clock time where the UTC day differs from the local day.
 *   2. updateSpacedRepetition's three date intents, asserting the exact JSON
 *      body that reaches the Notion PATCH.
 *
 * Usage: node tz-check.js <path-to-background.js>
 */
// Set the timezone before anything reads a Date. Node applies a runtime
// process.env.TZ change; an inherited TZ env var does not survive on Windows.
process.env.TZ = process.env.TZ_NAME;

const fs = require("fs");

const src = fs.readFileSync(process.argv[2], "utf8");

// --- sandbox doubles ---------------------------------------------------------

const noop = () => {};
const chromeStub = {
  runtime: { onMessage: { addListener: noop }, onStartup: { addListener: noop }, onInstalled: { addListener: noop }, getURL: (p) => p, lastError: null },
  alarms: { create: noop, onAlarm: { addListener: noop } },
  storage: { sync: { get: async () => ({}) } },
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

let lastRequest = null;
async function fetchStub(url, options) {
  lastRequest = { url, method: options.method, body: options.body ? JSON.parse(options.body) : null };
  return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ id: "page-stub" }) };
}

function load(isoNow) {
  const factory = new Function(
    "chrome",
    "fetch",
    "Date",
    `${src}\n; return { localDateString, localDateInDays, updateSpacedRepetition };`,
  );
  return factory(chromeStub, fetchStub, frozenDateAt(isoNow));
}

// --- assertions --------------------------------------------------------------

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`);
}

(async () => {
  console.log(`TZ=${process.env.TZ}  offset=${-new Date().getTimezoneOffset() / 60}h`);

  // A wall-clock instant chosen so the UTC day and the local day disagree.
  // TZ=America/New_York (UTC-4 in Aug): 2026-08-11T01:00Z === Aug 10, 21:00 local
  // TZ=Asia/Tokyo       (UTC+9):        2026-08-10T22:00Z === Aug 11, 07:00 local
  const isoNow = process.env.ISO_NOW;
  const expectedLocalToday = process.env.EXPECT_TODAY;
  const expectedTomorrow = process.env.EXPECT_TOMORROW;

  const bg = load(isoNow);

  console.log(`  instant ${isoNow}  → UTC day ${new Date(isoNow).toISOString().split("T")[0]}, local day ${expectedLocalToday}`);

  check("localDateString() is the LOCAL calendar day", bg.localDateString(), expectedLocalToday);
  check("localDateInDays(0) === today", bg.localDateInDays(0), expectedLocalToday);
  check("localDateInDays(1) === tomorrow", bg.localDateInDays(1), expectedTomorrow);

  // AC1/AC3/AC5 — Revisit: setToday writes today + bumps Attempts, no interval involved.
  lastRequest = null;
  let res = await bg.updateSpacedRepetition({ apiKey: "k", pageId: "p", setToday: true, attempts: 4 });
  check("setToday writes local today + Attempts", lastRequest.body.properties, {
    "Spaced Repetition": { date: { start: expectedLocalToday } },
    Attempts: { number: 4 },
  });
  check("setToday returns the written date", res.date, expectedLocalToday);

  // AC3 — setToday ignores any interval, including a disabled (0) one.
  lastRequest = null;
  await bg.updateSpacedRepetition({ apiKey: "k", pageId: "p", setToday: true, days: 0, attempts: 1 });
  check("setToday wins over days:0 (interval disabled)", lastRequest.body.properties["Spaced Repetition"], {
    date: { start: expectedLocalToday },
  });
  lastRequest = null;
  await bg.updateSpacedRepetition({ apiKey: "k", pageId: "p", setToday: true, days: 7, attempts: 1 });
  check("setToday wins over days:7", lastRequest.body.properties["Spaced Repetition"], {
    date: { start: expectedLocalToday },
  });

  // AC7 — Review Tomorrow is unchanged (+1 day), still local.
  lastRequest = null;
  res = await bg.updateSpacedRepetition({ apiKey: "k", pageId: "p", days: 1 });
  check("days:1 (Review Tomorrow) still writes today+1", lastRequest.body.properties, {
    "Spaced Repetition": { date: { start: expectedTomorrow } },
  });

  // Regression — days:0 with no setToday still means "leave the date untouched".
  lastRequest = null;
  res = await bg.updateSpacedRepetition({ apiKey: "k", pageId: "p", days: 0, attempts: 9 });
  check("days:0 alone leaves the date untouched", lastRequest.body.properties, { Attempts: { number: 9 } });
  lastRequest = null;
  res = await bg.updateSpacedRepetition({ apiKey: "k", pageId: "p", days: 0 });
  check("days:0 with nothing else skips the request entirely", [res.skipped, lastRequest], [true, null]);

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
