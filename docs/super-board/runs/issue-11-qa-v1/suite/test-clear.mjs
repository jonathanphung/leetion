/**
 * super-board QA — issue #11 · "clear Spaced Repetition for a single problem".
 *
 *   node docs/super-board/runs/issue-11-qa-v1/suite/test-clear.mjs
 *
 * Runs the REAL, unmodified background.js (loaded with `chrome`/`fetch`/`Date`
 * shadowed — see load-background.mjs) against a stateful Notion double, and
 * drives it through `chrome.runtime.onMessage`, the popup's real entry point.
 * Every assertion about "what Notion holds" is a read-back from the double
 * after the write, not an inspection of the request body — except where the
 * exact PATCH shape IS the acceptance criterion (AC1 names the payload).
 *
 * Point it at another background.js for the negative control:
 *   QA_BACKGROUND=/tmp/background.prefix.js node .../test-clear.mjs
 */
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { loadBackground } from "./load-background.mjs";
import { createNotionMock } from "./notion-mock.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, "../../../../..");
const BACKGROUND = process.env.QA_BACKGROUND || path.join(REPO, "background.js");

// Frozen at an instant where the local day (America/Chicago, UTC-5 in August)
// and the UTC day disagree — inherited from issue #10's harness so a
// regression there would surface here too.
const NOW = "2026-08-16T02:00:00Z"; // → local 2026-08-15 21:00
const PAGE = "qa-page-1";
const FAR_FUTURE = "2026-09-30";

let pass = 0;
const failures = [];
let section = "";

const j = (v) => JSON.stringify(v);

function ok(name, cond, detail = "") {
  if (cond) {
    pass += 1;
  } else {
    failures.push(`${section} · ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
function eq(name, actual, expected) {
  ok(name, j(actual) === j(expected), `expected ${j(expected)}, got ${j(actual)}`);
}
function head(title) {
  section = title;
  console.log(`\n── ${title}`);
}

/** Sentinel for "this page never had the Spaced Repetition property at all". */
const NO_PROPERTY = Symbol("no-spaced-repetition-property");

/** Fresh background + Notion double, seeded with one existing page. */
function boot({ review = { date: { start: FAR_FUTURE } }, extra = {}, sync } = {}) {
  const props = {
    "S No.": { number: 1 },
    Question: { title: [{ text: { content: "Two Sum" } }] },
    Attempts: { number: 3 },
    "My Expertise": { select: { name: "Medium" } },
    Level: { select: { name: "Easy" } },
    Done: { checkbox: false },
    ...extra,
  };
  if (review !== NO_PROPERTY) props["Spaced Repetition"] = review;

  const notion = createNotionMock({ [PAGE]: props });
  const ctx = loadBackground({
    file: BACKGROUND,
    isoNow: NOW,
    fetch: notion.fetch,
    sync: sync ?? { notionApiKey: "qa-key", notionDatabaseId: "qa-db" },
  });
  return { notion, ...ctx };
}

const KEY = { apiKey: "qa-key", pageId: PAGE };

const PROBLEM = {
  number: 1,
  title: "Two Sum",
  difficulty: "Easy",
  url: "https://leetcode.com/problems/two-sum/",
  tags: ["Array"],
  expertise: "Medium",
  done: false,
  code: "def twoSum(): pass",
  language: "Python3",
  snapshots: [],
  notes: "",
};

const today = () => {
  const { api } = boot();
  return api.localDateString();
};
const TODAY = today();
const UTC_DAY = new Date(NOW).toISOString().split("T")[0];

console.log(`background.js : ${BACKGROUND}`);
console.log(`frozen clock  : ${NOW}`);
console.log(`local day     : ${TODAY}   (UTC day ${UTC_DAY})`);

// ───────────────────────────────────────────────────────────────────────────
head("S1 · AC1 — clear writes an explicit empty date, and only that");
{
  const { send, notion } = boot();
  const res = await send({
    action: "updateSpacedRepetition",
    data: { ...KEY, clear: true },
  });

  const patches = notion.requestsFor(/^pages\//).filter((r) => r.method === "PATCH");
  eq("exactly one PATCH", patches.length, 1);
  eq(
    "PATCH body is the payload the card names",
    patches[0]?.body,
    { properties: { "Spaced Repetition": { date: null } } },
  );

  eq("stored property is {date:null}", notion.rawReview(PAGE), { date: null });
  eq("page holds no review date", notion.reviewDate(PAGE), null);
  ok("the property still exists (emptied, not deleted)", notion.hasReviewProp(PAGE));
  eq("seeded date is gone", notion.reviewDate(PAGE) === FAR_FUTURE, false);

  eq("Attempts untouched", notion.attempts(PAGE), 3);
  eq("Done untouched", notion.done(PAGE), false);
  eq("Level untouched", notion.prop(PAGE, "Level"), { select: { name: "Easy" } });

  eq("response.success", res?.success, true);
  eq("response.cleared", res?.cleared, true);
  eq("response.date is null (nothing was scheduled)", res?.date, null);
}

// ───────────────────────────────────────────────────────────────────────────
head("S2 · AC3 + #3/#10 regressions — intent precedence");
{
  const cases = [
    ["clear alone", { clear: true }, null],
    ["clear beats setToday", { clear: true, setToday: true }, null],
    ["clear beats days:7", { clear: true, days: 7 }, null],
    ["clear beats both", { clear: true, setToday: true, days: 7 }, null],
    ["clear:false falls through to setToday", { clear: false, setToday: true }, TODAY],
    ["clear:false + days:1", { clear: false, days: 1 }, "2026-08-16"],
    ["setToday alone (#10 regression)", { setToday: true }, TODAY],
    ["days:1 (#10 regression)", { days: 1 }, "2026-08-16"],
    ["days:0 leaves the date alone (#3 regression)", { days: 0 }, FAR_FUTURE],
    ["no intent leaves the date alone", {}, FAR_FUTURE],
  ];

  for (const [name, data, expected] of cases) {
    const { send, notion } = boot();
    await send({ action: "updateSpacedRepetition", data: { ...KEY, ...data } });
    eq(name, notion.reviewDate(PAGE), expected);
  }

  // A clear that also carries an Attempts write must send both in one PATCH —
  // the popup does not use this today, but the handler's contract allows it
  // and a silently-dropped property would be a real defect.
  {
    const { send, notion } = boot();
    await send({
      action: "updateSpacedRepetition",
      data: { ...KEY, clear: true, attempts: 5 },
    });
    eq("clear + attempts → both written", notion.lastRequest()?.body, {
      properties: {
        "Spaced Repetition": { date: null },
        Attempts: { number: 5 },
      },
    });
    eq("clear + attempts → date empty", notion.reviewDate(PAGE), null);
    eq("clear + attempts → Attempts 5", notion.attempts(PAGE), 5);
  }

  // `days: 0` with nothing else still short-circuits before the HTTP call.
  {
    const { send, notion } = boot();
    const res = await send({
      action: "updateSpacedRepetition",
      data: { ...KEY, days: 0 },
    });
    eq("days:0 sends no PATCH", notion.requestsFor(/^pages\//).length, 0);
    eq("days:0 reports skipped", res?.skipped, true);
  }
}

// ───────────────────────────────────────────────────────────────────────────
head("S3 · AC2 — the popup's hydration source reports real Notion state");
{
  const withDate = boot({ review: { date: { start: FAR_FUTURE } } });
  const a = await withDate.send({
    action: "checkExisting",
    data: { apiKey: "qa-key", databaseId: "qa-db", problemNumber: 1 },
  });
  eq("entry with a date → the date", a?.spacedRepetition, FAR_FUTURE);
  eq("…and it is truthy, so the switch reads on", !!a?.spacedRepetition, true);

  const emptied = boot({ review: { date: null } });
  const b = await emptied.send({
    action: "checkExisting",
    data: { apiKey: "qa-key", databaseId: "qa-db", problemNumber: 1 },
  });
  eq("entry with an emptied date → null", b?.spacedRepetition, null);
  eq("…and it is falsy, so the switch reads off", !!b?.spacedRepetition, false);

  const never = boot({ review: NO_PROPERTY });
  const c = await never.send({
    action: "checkExisting",
    data: { apiKey: "qa-key", databaseId: "qa-db", problemNumber: 1 },
  });
  eq("entry that never had the property → null", c?.spacedRepetition, null);

  // Read back through the real query path after a real clear — the case the
  // card describes as "reopen the popup".
  const trip = boot();
  await trip.send({ action: "updateSpacedRepetition", data: { ...KEY, clear: true } });
  const d = await trip.send({
    action: "checkExisting",
    data: { apiKey: "qa-key", databaseId: "qa-db", problemNumber: 1 },
  });
  eq("after a clear, a reopen hydrates off", d?.spacedRepetition, null);
  eq("…and the rest of the entry still hydrates", d?.attempts, 3);
  eq("…and the entry is still found", d?.exists, true);
}

// ───────────────────────────────────────────────────────────────────────────
head("S4 · AC6 — a later plain save does not re-add a review date");
{
  // The popup sends clearSpacedRepetition alongside the expertise interval;
  // the flag must win.
  {
    const { send, notion } = boot({ review: { date: null } });
    await send({
      action: "saveToNotion",
      data: {
        apiKey: "qa-key",
        databaseId: "qa-db",
        problem: PROBLEM,
        existingPageId: PAGE,
        spacedRepetitionDays: 3,
        clearSpacedRepetition: true,
        confirmSchemaChanges: true,
      },
    });
    const patch = notion
      .requestsFor(/^pages\//)
      .filter((r) => r.method === "PATCH")
      .pop();
    eq(
      "save writes an empty date, not today+3",
      patch?.body?.properties?.["Spaced Repetition"],
      { date: null },
    );
    eq("page still has no review date", notion.reviewDate(PAGE), null);
  }

  // Same save without the flag — proves the flag is what does the work, and
  // that the ordinary scheduling path is untouched.
  {
    const { send, notion } = boot({ review: { date: null } });
    await send({
      action: "saveToNotion",
      data: {
        apiKey: "qa-key",
        databaseId: "qa-db",
        problem: PROBLEM,
        existingPageId: PAGE,
        spacedRepetitionDays: 3,
        confirmSchemaChanges: true,
      },
    });
    eq("without the flag the save schedules as before", notion.reviewDate(PAGE), "2026-08-18");
  }

  // A cleared problem whose expertise level has reviews disabled: the flag
  // must still write the empty date rather than falling into `days: 0`'s
  // "leave it alone".
  {
    const { send, notion } = boot();
    await send({
      action: "saveToNotion",
      data: {
        apiKey: "qa-key",
        databaseId: "qa-db",
        problem: PROBLEM,
        existingPageId: PAGE,
        spacedRepetitionDays: 0,
        clearSpacedRepetition: true,
        confirmSchemaChanges: true,
      },
    });
    eq("clear + interval 0 → emptied, not left alone", notion.reviewDate(PAGE), null);
  }

  // The create path is untouched: the popup never sends the flag for a new
  // page, and a first save still schedules from the interval.
  {
    const { send, notion } = boot({ review: NO_PROPERTY });
    await send({
      action: "saveToNotion",
      data: {
        apiKey: "qa-key",
        databaseId: "qa-db",
        problem: { ...PROBLEM, number: 42, title: "New One" },
        spacedRepetitionDays: 3,
        confirmSchemaChanges: true,
      },
    });
    const created = notion.requests.find((r) => r.endpoint === "pages" && r.method === "POST");
    eq(
      "new page still gets today+3",
      created?.body?.properties?.["Spaced Repetition"],
      { date: { start: "2026-08-18" } },
    );
  }

  // buildProperties directly — the guard the card called out by file:line.
  {
    const { api } = boot();
    const cleared = api.buildProperties(PROBLEM, PAGE, 7, "Question", true);
    eq("buildProperties: clear wins over days 7", cleared["Spaced Repetition"], { date: null });
    const scheduled = api.buildProperties(PROBLEM, PAGE, 7, "Question", false);
    eq("buildProperties: no clear → today+7", scheduled["Spaced Repetition"], {
      date: { start: "2026-08-22" },
    });
    const disabled = api.buildProperties(PROBLEM, PAGE, 0, "Question", false);
    eq(
      "buildProperties: days 0 omits the property (#3)",
      disabled["Spaced Repetition"],
      undefined,
    );
    const legacy = api.buildProperties(PROBLEM, PAGE, 7);
    eq("buildProperties: 4-arg callers unchanged", legacy["Spaced Repetition"], {
      date: { start: "2026-08-22" },
    });
  }
}

// ───────────────────────────────────────────────────────────────────────────
head("S5 · AC5 — a cleared problem never appears in the due query or notifies");
{
  const notion = createNotionMock({
    "page-cleared": {
      "S No.": { number: 1 },
      Question: { title: [{ text: { content: "Two Sum" } }] },
      "Spaced Repetition": { date: null },
      Level: { select: { name: "Easy" } },
    },
    "page-due": {
      "S No.": { number: 2 },
      Question: { title: [{ text: { content: "Add Two Numbers" } }] },
      "Spaced Repetition": { date: { start: TODAY } },
      Level: { select: { name: "Medium" } },
    },
    "page-overdue": {
      "S No.": { number: 3 },
      Question: { title: [{ text: { content: "LRU Cache" } }] },
      "Spaced Repetition": { date: { start: "2026-01-01" } },
      Level: { select: { name: "Hard" } },
    },
    "page-future": {
      "S No.": { number: 4 },
      Question: { title: [{ text: { content: "N-Queens" } }] },
      "Spaced Repetition": { date: { start: FAR_FUTURE } },
      Level: { select: { name: "Hard" } },
    },
    "page-never": {
      "S No.": { number: 5 },
      Question: { title: [{ text: { content: "Never Scheduled" } }] },
      Level: { select: { name: "Easy" } },
    },
  });
  const { api, notifications } = loadBackground({
    file: BACKGROUND,
    isoNow: NOW,
    fetch: notion.fetch,
    sync: { notionApiKey: "qa-key", notionDatabaseId: "qa-db" },
  });

  await api.checkDueReviews();
  const query = notion.requestsFor(/\/query$/).pop();

  ok(
    "the due filter guards on a non-empty date",
    JSON.stringify(query?.body?.filter).includes('"is_not_empty":true'),
    `filter was ${j(query?.body?.filter)}`,
  );
  eq("the due filter is the documented compound shape", query?.body?.filter, {
    and: [
      { property: "Spaced Repetition", date: { is_not_empty: true } },
      { property: "Spaced Repetition", date: { on_or_before: TODAY } },
    ],
  });
  eq("the due filter uses the LOCAL day", query?.body?.filter?.and?.[1]?.date?.on_or_before, TODAY);

  eq("2 problems are due (today + overdue)", notifications.length, 1);
  eq(
    "the notification counts only the real ones",
    notifications[0]?.message,
    "You have 2 problems due for review today.",
  );
  eq("notification title unchanged", notifications[0]?.title, "LeetCode Review Due");

  // The cleared page is provably excluded, not merely absent from a count.
  const returned = await notion.fetch("https://api.notion.com/v1/databases/qa-db/query", {
    method: "POST",
    body: JSON.stringify({ filter: query.body.filter }),
  });
  const ids = (await returned.json()).results.map((p) => p.id).sort();
  eq("the query returns exactly the due pages", ids, ["page-due", "page-overdue"]);
  ok("the cleared page is not in the result set", !ids.includes("page-cleared"));
  ok("a never-scheduled page is not in the result set", !ids.includes("page-never"));

  // Clear the two due pages through the real handler, then re-run the alarm.
  const ctx2 = loadBackground({
    file: BACKGROUND,
    isoNow: NOW,
    fetch: notion.fetch,
    sync: { notionApiKey: "qa-key", notionDatabaseId: "qa-db" },
  });
  for (const pageId of ["page-due", "page-overdue"]) {
    await ctx2.send({
      action: "updateSpacedRepetition",
      data: { apiKey: "qa-key", pageId, clear: true },
    });
  }
  await ctx2.api.checkDueReviews();
  eq("after clearing both, the alarm fires nothing", ctx2.notifications.length, 0);

  // The stats badge counts the same way.
  const stats = await ctx2.send({
    action: "getStats",
    data: { apiKey: "qa-key", databaseId: "qa-db" },
  });
  eq("getStats counts no reviews due", stats?.dueForReview, 0);
  eq("…while still counting the problems themselves", stats?.total ?? stats?.easy + stats?.medium + stats?.hard, 5);
}

// ───────────────────────────────────────────────────────────────────────────
head("S6 · the card's manual round-trip: set → clear → reopen → re-enable");
{
  const { send, notion, api, notifications } = boot({ review: { date: null } });
  const query = { apiKey: "qa-key", databaseId: "qa-db", problemNumber: 1 };

  const step0 = await send({ action: "checkExisting", data: query });
  eq("0 · starts off", !!step0.spacedRepetition, false);

  await send({ action: "updateSpacedRepetition", data: { ...KEY, setToday: true } });
  const step1 = await send({ action: "checkExisting", data: query });
  eq("1 · switched on → due today", step1.spacedRepetition, TODAY);
  await api.checkDueReviews();
  eq("1 · the alarm sees it", notifications.length, 1);

  await send({ action: "updateSpacedRepetition", data: { ...KEY, clear: true } });
  const step2 = await send({ action: "checkExisting", data: query });
  eq("2 · switched off → no date on the page", notion.reviewDate(PAGE), null);
  eq("2 · a reopened popup reads off", !!step2.spacedRepetition, false);
  notifications.length = 0;
  await api.checkDueReviews();
  eq("2 · the alarm no longer sees it", notifications.length, 0);

  await send({
    action: "saveToNotion",
    data: {
      apiKey: "qa-key",
      databaseId: "qa-db",
      problem: PROBLEM,
      existingPageId: PAGE,
      spacedRepetitionDays: 3,
      clearSpacedRepetition: true,
      confirmSchemaChanges: true,
    },
  });
  eq("3 · an ordinary save keeps it out of the rotation", notion.reviewDate(PAGE), null);

  await send({ action: "updateSpacedRepetition", data: { ...KEY, setToday: true } });
  const step4 = await send({ action: "checkExisting", data: query });
  eq("4 · switched back on → due today again", step4.spacedRepetition, TODAY);
  eq("4 · …on the page too", notion.reviewDate(PAGE), TODAY);
  notifications.length = 0;
  await api.checkDueReviews();
  eq("4 · the alarm sees it again", notifications.length, 1);
  eq("Attempts survived the whole trip", notion.attempts(PAGE), 3);
}

// ───────────────────────────────────────────────────────────────────────────
head("S7 · AC7 — a Notion failure leaves the page alone and reports the error");
{
  const { send, notion } = boot();
  notion.failNextWith(500, "QA forced failure");
  const res = await send({
    action: "updateSpacedRepetition",
    data: { ...KEY, clear: true },
  });
  eq("clear reports failure", res?.success, false);
  ok("…with an error string for showStatus", typeof res?.error === "string" && res.error.length > 0);
  eq("the page keeps its date", notion.reviewDate(PAGE), FAR_FUTURE);
  eq("nothing was cleared", notion.rawReview(PAGE), { date: { start: FAR_FUTURE } });

  // 401 is the shape the popup's "blank the API key" repro produces.
  const auth = boot();
  auth.notion.failNextWith(401, "API token is invalid.");
  const res2 = await auth.send({
    action: "updateSpacedRepetition",
    data: { ...KEY, clear: true },
  });
  eq("401 also reports failure", res2?.success, false);
  eq("…and the page is untouched", auth.notion.reviewDate(PAGE), FAR_FUTURE);
}

// ───────────────────────────────────────────────────────────────────────────
console.log(`\n${"─".repeat(70)}`);
if (failures.length === 0) {
  console.log(`PASS — ${pass}/${pass} assertions green`);
  process.exit(0);
}
console.log(`FAIL — ${pass}/${pass + failures.length} assertions green, ${failures.length} failed:\n`);
for (const f of failures) console.log(`  ✗ ${f}`);
process.exit(1);
