/**
 * super-board QA — issue #20, background-contract layer.
 *
 * The popup layer (suite/browser/) is where the staging behaviour itself is
 * observed, in a real browser against the real popup. This file covers the
 * half of the card that lives BELOW the popup: the new
 * `scheduleSpacedRepetitionToday` flag, the precedence it was given, and the
 * three positional argument lists it has to survive
 * (`saveToNotion` → `updatePageContent` → `buildProperties`).
 *
 * Everything runs against the REAL background.js — loaded in a `Function`
 * whose `chrome` / `fetch` / `Date` parameters shadow the globals it touches,
 * so no product file is rewritten — and against the stateful Notion double,
 * so "what the page holds" is a read-back and not a request log.
 *
 * Clock frozen at 2026-08-16T02:00:00Z. On this host (America/Chicago, UTC-5
 * in August) that is 2026-08-15 21:00 local, so the local day (2026-08-15) and
 * the UTC day (2026-08-16) disagree: any assertion on "today" would catch a
 * UTC regression, not just a wrong-by-days one.
 *
 *   node docs/super-board/runs/issue-20-qa-v1/suite/test-stage.mjs
 *
 * BACKGROUND=<path> points it at a different background.js (used by the
 * negative control to prove these assertions fail on pre-fix code).
 */
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createNotionMock } from "./notion-mock.mjs";
import { loadBackground } from "./load-background.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../../../..");
const BACKGROUND = process.env.BACKGROUND || path.join(root, "background.js");

const NOW = "2026-08-16T02:00:00Z";
const LOCAL_TODAY = "2026-08-15";
const UTC_TODAY = "2026-08-16";
const PAGE = "qa-page-1";
const DB = "qa-db-1";
const KEY = "qa-test-key";
const FAR_FUTURE = "2026-09-30";

// ── tiny assertion harness ────────────────────────────────────────────────
const results = [];
let group = "—";
const g = (name) => {
  group = name;
  console.log(`\n${name}`);
};
const rec = (ok, label, expected, actual) => {
  results.push({ ac: group, label, ok, expected, actual });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) {
    console.log(`        expected  ${JSON.stringify(expected)}`);
    console.log(`        actual    ${JSON.stringify(actual)}`);
  }
};
const eq = (label, actual, expected) =>
  rec(JSON.stringify(actual) === JSON.stringify(expected), label, expected, actual);
const ok = (label, actual) => rec(actual === true, label, true, actual);

// ── fixtures ──────────────────────────────────────────────────────────────
const basePage = () => ({
  "S No.": { number: 1 },
  Question: { title: [{ text: { content: "Two Sum" } }] },
  Attempts: { number: 3 },
  "My Expertise": { select: { name: "Medium" } },
  Level: { select: { name: "Easy" } },
  Done: { checkbox: false },
  "Spaced Repetition": { date: { start: FAR_FUTURE } },
});

const problem = {
  number: 1,
  title: "Two Sum",
  difficulty: "Easy",
  code: "def twoSum(nums, target):\n    return []",
  language: "Python3",
  url: "https://leetcode.com/problems/two-sum/",
  tags: ["Array"],
  questionContent: "Given an array of integers…",
};

/** A fresh background + Notion double per scenario — no cross-test bleed. */
function boot({ review = { date: { start: FAR_FUTURE } } } = {}) {
  const props = basePage();
  if (review === undefined) delete props["Spaced Repetition"];
  else props["Spaced Repetition"] = review;
  const notion = createNotionMock({ [PAGE]: props });
  const bg = loadBackground({
    file: BACKGROUND,
    isoNow: NOW,
    fetch: notion.fetch,
    sync: {
      notionApiKey: KEY,
      notionDatabaseId: DB,
      spacedRepetitionIntervals: { Low: 1, Medium: 3, High: 7 },
    },
  });
  return { notion, bg };
}

/** The message the popup sends on "Update in Notion", with overrides. */
const saveMessage = (over = {}) => ({
  action: "saveToNotion",
  data: {
    apiKey: KEY,
    databaseId: DB,
    existingPageId: PAGE,
    spacedRepetitionDays: 3,
    clearSpacedRepetition: false,
    scheduleSpacedRepetitionToday: false,
    confirmSchemaChanges: false,
    problem,
    expertise: "Medium",
    done: false,
    remark: "",
    snapshots: [],
    ...over,
  },
});

// ═══════════════════════════════════════════════════════════════════════════
// AC4 / AC5 — buildProperties: the new flag and where it ranks
// ═══════════════════════════════════════════════════════════════════════════
g("AC5 — buildProperties precedence for scheduleSpacedRepetitionToday");
{
  const { bg } = boot();
  const build = bg.api.buildProperties;
  ok("background.js still exports buildProperties", typeof build === "function");

  if (typeof build === "function") {
    // staged ON at interval 0 → today, not "nothing at all".
    const onZero = build(problem, "Medium", 0, "Question", false, true);
    eq(
      "staged on + interval 0 writes TODAY (the AC5 fallback)",
      onZero["Spaced Repetition"],
      { date: { start: LOCAL_TODAY } },
    );
    rec(
      onZero["Spaced Repetition"]?.date?.start !== UTC_TODAY,
      "…and it is the LOCAL day, not UTC's",
      `!= ${UTC_TODAY}`,
      onZero["Spaced Repetition"]?.date?.start,
    );

    // Nothing staged at interval 0 keeps issue #3: leave the stored date alone.
    const offZero = build(problem, "Medium", 0, "Question", false, false);
    eq(
      "interval 0 with nothing staged still writes NO date (issue #3 intact)",
      Object.prototype.hasOwnProperty.call(offZero, "Spaced Repetition"),
      false,
    );

    // An explicit clear outranks the fallback — the documented order.
    const both = build(problem, "Medium", 0, "Question", true, true);
    eq(
      "clear outranks scheduleToday when both are somehow set",
      both["Spaced Repetition"],
      { date: null },
    );

    // The fallback outranks a positive interval. days is 0 by construction in
    // the popup, so this pins the documented rank rather than a live path.
    const overDays = build(problem, "Medium", 7, "Question", false, true);
    eq(
      "scheduleToday outranks days > 0",
      overDays["Spaced Repetition"],
      { date: { start: LOCAL_TODAY } },
    );

    // Untouched behaviour: a plain interval save is still today + days.
    const plain = build(problem, "Medium", 3, "Question", false, false);
    eq(
      "a plain interval save is unchanged (today + 3)",
      plain["Spaced Repetition"],
      { date: { start: "2026-08-18" } },
    );

    // Default parameter: old callers that pass 5 args must not change meaning.
    const fiveArg = build(problem, "Medium", 3, "Question", false);
    eq(
      "5-argument callers are unaffected (flag defaults to false)",
      fiveArg["Spaced Repetition"],
      { date: { start: "2026-08-18" } },
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// AC3 / AC4 — end to end through the real message router
// ═══════════════════════════════════════════════════════════════════════════
g("AC3 — a staged-off save empties the date on the Notion page");
{
  const { notion, bg } = boot();
  const res = await bg.send(saveMessage({ clearSpacedRepetition: true }));
  ok("save succeeded", res?.success === true);
  eq(
    'the page now holds an explicit empty date, not a missing property',
    notion.rawReview(PAGE),
    { date: null },
  );
  const patch = notion
    .requestsFor(/^pages\//)
    .filter((r) => r.method === "PATCH")
    .pop();
  eq(
    "the PATCH body carries {date: null}",
    patch?.body?.properties?.["Spaced Repetition"],
    { date: null },
  );
}

g("AC4 — a staged-on save writes today + the expertise interval");
{
  for (const [expertise, days, expected] of [
    ["Low", 1, "2026-08-16"],
    ["Medium", 3, "2026-08-18"],
    ["High", 7, "2026-08-22"],
  ]) {
    const { notion, bg } = boot({ review: { date: null } });
    const res = await bg.send(
      saveMessage({ expertise, spacedRepetitionDays: days }),
    );
    ok(`${expertise}: save succeeded`, res?.success === true);
    eq(
      `${expertise} (interval ${days}) → ${expected}`,
      notion.reviewDate(PAGE),
      expected,
    );
  }
}

g("AC5 — the interval-0 fallback survives the whole message path");
{
  const { notion, bg } = boot({ review: { date: null } });
  const res = await bg.send(
    saveMessage({
      expertise: "High",
      spacedRepetitionDays: 0,
      scheduleSpacedRepetitionToday: true,
    }),
  );
  ok("save succeeded", res?.success === true);
  eq(
    "the flag survives saveToNotion → updatePageContent → buildProperties",
    notion.reviewDate(PAGE),
    LOCAL_TODAY,
  );
}

g("AC5 (negative) — interval 0 WITHOUT the flag leaves the stored date alone");
{
  const { notion, bg } = boot();
  const res = await bg.send(
    saveMessage({
      expertise: "High",
      spacedRepetitionDays: 0,
      scheduleSpacedRepetitionToday: false,
    }),
  );
  ok("save succeeded", res?.success === true);
  eq(
    "the far-future date the page already had is untouched (issue #3)",
    notion.reviewDate(PAGE),
    FAR_FUTURE,
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// AC9 — the two quick actions keep writing immediately
// ═══════════════════════════════════════════════════════════════════════════
g("AC9 — Review Today / Review Tomorrow are untouched by this card");
{
  const { notion, bg } = boot({ review: { date: null } });
  const today = await bg.send({
    action: "updateSpacedRepetition",
    data: { apiKey: KEY, pageId: PAGE, setToday: true },
  });
  ok("Review Today succeeded", today?.success === true);
  eq("Review Today writes the local today", notion.reviewDate(PAGE), LOCAL_TODAY);

  const tomorrow = await bg.send({
    action: "updateSpacedRepetition",
    data: { apiKey: KEY, pageId: PAGE, days: 1 },
  });
  ok("Review Tomorrow succeeded", tomorrow?.success === true);
  eq("Review Tomorrow writes today + 1", notion.reviewDate(PAGE), "2026-08-16");
}

// ═══════════════════════════════════════════════════════════════════════════
// Regression — issue #11's guarantees, re-checked under the new semantics
// ═══════════════════════════════════════════════════════════════════════════
g("REG (#11) — a cleared problem stays out of the due query and never notifies");
{
  const { notion, bg } = boot();
  await bg.send(saveMessage({ clearSpacedRepetition: true }));
  bg.notifications.length = 0;
  await bg.api.checkDueReviews();
  eq(
    "the hourly alarm raises no notification for the cleared page",
    bg.notifications.length,
    0,
  );
  const query = notion
    .requestsFor(/^databases\/[^/]+\/query$/)
    .pop();
  ok(
    "the due query still filters on Spaced Repetition",
    JSON.stringify(query?.body?.filter || {}).includes("Spaced Repetition"),
  );
}

g("REG (#11) — the `clear` arm of updateSpacedRepetition still works");
{
  const { notion, bg } = boot();
  const res = await bg.send({
    action: "updateSpacedRepetition",
    data: { apiKey: KEY, pageId: PAGE, clear: true },
  });
  ok(
    "kept-on-purpose callerless arm still answers (PR decision 3)",
    res?.success === true,
  );
  eq("…and still empties the date", notion.rawReview(PAGE), { date: null });
}

// ═══════════════════════════════════════════════════════════════════════════
// AC1 / AC11 — static audit of the popup source
// ═══════════════════════════════════════════════════════════════════════════
g("AC1/AC11 — static audit of popup.js");
{
  const popup = fs.readFileSync(
    process.env.POPUP || path.join(root, "popup.js"),
    "utf8",
  );

  // AC1: the switch's own handler must not be able to reach the background.
  const handler = popup.match(
    /function stageSpacedRepetition\s*\([^)]*\)\s*\{[\s\S]*?\n\}/,
  )?.[0];
  ok("a stageSpacedRepetition handler exists", !!handler);
  ok(
    "…and its body contains no sendMessage call",
    !!handler && !/sendMessage/.test(handler),
  );
  ok(
    "the old immediate-write toggleSpacedRepetition is gone",
    !/function\s+toggleSpacedRepetition/.test(popup),
  );
  ok(
    'popup.js no longer sends action "updateSpacedRepetition" with clear:true',
    !/clear:\s*true/.test(popup),
  );

  // AC11: session-only. The staged flip must not reach the form draft.
  const persist = popup.match(
    /function persistFormState\s*\([^)]*\)\s*\{[\s\S]*?\n\}/,
  )?.[0];
  ok("persistFormState exists", !!persist);
  ok(
    "…and never persists the staged switch (AC11 — session-only)",
    !!persist && !/[Ss]pacedRepetition/.test(persist),
  );
  // The restore half is `loadPersistedFormState` (the issue and the PR both
  // call it "restoreFormState"; the shipped name is this one).
  const restore = popup.match(
    /function loadPersistedFormState\s*\([^)]*\)\s*\{[\s\S]*?\n\}/,
  )?.[0];
  ok("loadPersistedFormState exists", !!restore);
  ok(
    "…and never restores a staged switch either (AC11)",
    !!restore && !/[Ss]pacedRepetition/.test(restore),
  );
}

// ── report ────────────────────────────────────────────────────────────────
const byAc = new Map();
for (const r of results) {
  const e = byAc.get(r.ac) || { pass: 0, fail: 0 };
  e[r.ok ? "pass" : "fail"] += 1;
  byAc.set(r.ac, e);
}
console.log("\n" + "─".repeat(74));
for (const [ac, e] of byAc) {
  console.log(`  ${e.fail ? "FAIL" : "ok  "}  ${ac}  —  ${e.pass} pass, ${e.fail} fail`);
}
const failed = results.filter((r) => !r.ok).length;
console.log("─".repeat(74));
console.log(
  failed === 0
    ? `PASS — ${results.length}/${results.length} assertions green`
    : `FAIL — ${failed}/${results.length} assertions red`,
);

if (process.env.QA_JSON) {
  fs.writeFileSync(
    process.env.QA_JSON,
    JSON.stringify(
      { background: BACKGROUND, now: NOW, total: results.length, failed, results },
      null,
      2,
    ),
  );
}
process.exit(failed === 0 ? 0 : 1);
