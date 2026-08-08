/**
 * Builder evidence harness for issue #3 — per-expertise spaced-repetition intervals.
 *
 * The repo has no test framework (see docs/super-board/PROJECT.md), so this
 * script loads the REAL popup.js / background.js sources into a `vm` context
 * with minimal chrome/DOM stubs and exercises the interval logic directly.
 * It asserts against the shipped functions, not a copy of them.
 *
 * Run from the repo root:  node docs/super-board/runs/issue-3-build-v1/verify-intervals.mjs
 * Exit code 0 = all assertions passed.
 */

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

let passed = 0;
const failures = [];

function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failures.push(`${name}\n          expected ${e}\n          actual   ${a}`);
    console.log(`  FAIL  ${name}\n          expected ${e}\n          actual   ${a}`);
  }
}

/** today + n days, formatted the same way the extension formats it (UTC date part). */
function dayOffset(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().split("T")[0];
}

function fakeElement() {
  return {
    value: "",
    checked: false,
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {},
    querySelectorAll: () => [],
    dataset: {},
  };
}

function loadScript(file, extraGlobals = {}) {
  const src = fs.readFileSync(path.join(REPO_ROOT, file), "utf8");
  const ctx = vm.createContext({
    console: { log() {}, error() {}, warn() {} },
    document: {
      getElementById: () => fakeElement(),
      querySelector: () => fakeElement(),
      querySelectorAll: () => [],
      addEventListener() {},
    },
    chrome: {
      runtime: {
        onMessage: { addListener() {} },
        onInstalled: { addListener() {} },
        onStartup: { addListener() {} },
        sendMessage: async () => ({}),
        getURL: (p) => p,
        lastError: null,
      },
      storage: {
        sync: { get: async () => ({}), set: async () => {}, remove: async () => {} },
        local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
      },
      alarms: { create() {}, onAlarm: { addListener() {} }, get: async () => null },
      notifications: {
        create() {},
        onClicked: { addListener() {} },
        onButtonClicked: { addListener() {} },
      },
      tabs: {
        query: async () => [],
        create() {},
        sendMessage() {},
        onUpdated: { addListener() {} },
        onActivated: { addListener() {} },
        onRemoved: { addListener() {} },
      },
      action: { onClicked: { addListener() {} } },
      scripting: { executeScript: async () => [] },
      windows: { create() {} },
    },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    ...extraGlobals,
  });
  vm.runInContext(src, ctx, { filename: file });
  return ctx;
}

console.log("Issue #3 — per-expertise spaced-repetition intervals\n");

// ---------------------------------------------------------------------------
console.log("popup.js — resolveReviewIntervals (storage shape + migration)");
// ---------------------------------------------------------------------------
const popup = loadScript("popup.js");

check("fresh profile falls back to 1/3/7 defaults", popup.resolveReviewIntervals({}), {
  Low: 1,
  Medium: 3,
  High: 7,
});

check(
  "legacy scalar (30) seeds all three levels",
  popup.resolveReviewIntervals({ spacedRepetitionDays: 30 }),
  { Low: 30, Medium: 30, High: 30 },
);

check(
  "legacy scalar 0 (reviews disabled) stays disabled on all levels",
  popup.resolveReviewIntervals({ spacedRepetitionDays: 0 }),
  { Low: 0, Medium: 0, High: 0 },
);

check(
  "new object wins over a leftover legacy scalar",
  popup.resolveReviewIntervals({
    spacedRepetitionIntervals: { Low: 2, Medium: 5, High: 14 },
    spacedRepetitionDays: 30,
  }),
  { Low: 2, Medium: 5, High: 14 },
);

check(
  "partial object: missing level falls back to legacy scalar",
  popup.resolveReviewIntervals({
    spacedRepetitionIntervals: { Low: 2 },
    spacedRepetitionDays: 30,
  }),
  { Low: 2, Medium: 30, High: 30 },
);

check(
  "partial object with no legacy: missing levels fall back to defaults",
  popup.resolveReviewIntervals({ spacedRepetitionIntervals: { High: 10 } }),
  { Low: 1, Medium: 3, High: 10 },
);

check(
  "garbage values are sanitized (negative/NaN -> fallback, >365 clamped)",
  popup.resolveReviewIntervals({
    spacedRepetitionIntervals: { Low: -5, Medium: "abc", High: 9999 },
  }),
  { Low: 1, Medium: 3, High: 365 },
);

check(
  "explicit per-level 0 is preserved (not treated as missing)",
  popup.resolveReviewIntervals({
    spacedRepetitionIntervals: { Low: 0, Medium: 3, High: 7 },
  }),
  { Low: 0, Medium: 3, High: 7 },
);

// ---------------------------------------------------------------------------
console.log("\npopup.js — intervalForExpertise (AC2 / AC3 resolution)");
// ---------------------------------------------------------------------------
const defaults = popup.resolveReviewIntervals({});
check("Low -> 1", popup.intervalForExpertise(defaults, "Low"), 1);
check("Medium -> 3", popup.intervalForExpertise(defaults, "Medium"), 3);
check("High -> 7", popup.intervalForExpertise(defaults, "High"), 7);
check(
  "unknown expertise falls back to Medium",
  popup.intervalForExpertise(defaults, "Expert"),
  3,
);
check(
  "null expertise falls back to Medium",
  popup.intervalForExpertise(defaults, null),
  3,
);
check(
  "custom intervals are honoured",
  popup.intervalForExpertise(
    popup.resolveReviewIntervals({
      spacedRepetitionIntervals: { Low: 2, Medium: 5, High: 21 },
    }),
    "High",
  ),
  21,
);

// ---------------------------------------------------------------------------
console.log("\nbackground.js — buildProperties (save path writes the right date)");
// ---------------------------------------------------------------------------
const bg = loadScript("background.js");

for (const [expertise, days] of [
  ["Low", 1],
  ["Medium", 3],
  ["High", 7],
]) {
  const props = bg.buildProperties(
    { title: "Two Sum", number: 1, expertise },
    null,
    days,
  );
  check(
    `${expertise} save (+${days}d) writes Spaced Repetition = ${dayOffset(days)}`,
    props["Spaced Repetition"],
    { date: { start: dayOffset(days) } },
  );
  check(
    `${expertise} save still writes My Expertise`,
    props["My Expertise"],
    { select: { name: expertise } },
  );
}

check(
  "interval 0 writes no Spaced Repetition property (AC5)",
  Object.prototype.hasOwnProperty.call(
    bg.buildProperties({ title: "Two Sum", expertise: "High" }, null, 0),
    "Spaced Repetition",
  ),
  false,
);

// ---------------------------------------------------------------------------
console.log("\nbackground.js — updateSpacedRepetition (Revisit / Tomorrow path)");
// ---------------------------------------------------------------------------
let lastRequest = null;
bg.notionRequest = async (endpoint, apiKey, method, body) => {
  lastRequest = { endpoint, method, body };
  return {};
};

lastRequest = null;
let res = await bg.updateSpacedRepetition({
  apiKey: "k",
  pageId: "p",
  days: 7,
  attempts: 4,
});
check("Revisit (High, 7d) succeeds", res.success, true);
check(
  "Revisit (High, 7d) writes today+7",
  lastRequest.body.properties["Spaced Repetition"],
  { date: { start: dayOffset(7) } },
);
check(
  "Revisit still writes Attempts",
  lastRequest.body.properties["Attempts"],
  { number: 4 },
);

lastRequest = null;
res = await bg.updateSpacedRepetition({
  apiKey: "k",
  pageId: "p",
  days: 1,
  attempts: undefined,
});
check(
  'Tomorrow (days: 1) still writes today+1 regardless of expertise (AC4)',
  lastRequest.body.properties["Spaced Repetition"],
  { date: { start: dayOffset(1) } },
);
check(
  "Tomorrow leaves Attempts untouched",
  Object.prototype.hasOwnProperty.call(lastRequest.body.properties, "Attempts"),
  false,
);

lastRequest = null;
res = await bg.updateSpacedRepetition({
  apiKey: "k",
  pageId: "p",
  days: 0,
  attempts: 9,
});
check(
  "Revisit on a 0-day level writes no review date (AC5)",
  Object.prototype.hasOwnProperty.call(
    lastRequest.body.properties,
    "Spaced Repetition",
  ),
  false,
);
check(
  "Revisit on a 0-day level still logs the attempt",
  lastRequest.body.properties["Attempts"],
  { number: 9 },
);

lastRequest = null;
res = await bg.updateSpacedRepetition({ apiKey: "k", pageId: "p", days: 0 });
check("0 days + no attempts sends no Notion request", lastRequest, null);
check("0 days + no attempts reports skipped", res, {
  success: true,
  date: null,
  skipped: true,
});

// ---------------------------------------------------------------------------
console.log(
  `\n${passed} passed, ${failures.length} failed (${passed + failures.length} assertions)`,
);
if (failures.length) {
  console.log("\nFailures:\n  - " + failures.join("\n  - "));
  process.exit(1);
}
