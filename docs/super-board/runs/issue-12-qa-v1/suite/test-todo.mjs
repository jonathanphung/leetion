/**
 * super-board QA — issue #12 · "Mark to-do" button.
 *
 *   node docs/super-board/runs/issue-12-qa-v1/suite/test-todo.mjs
 *
 * Runs the REAL background.js (see load-background.mjs) against a stateful
 * Notion double (notion-mock.mjs), entering through `chrome.runtime.onMessage`
 * exactly as the popup does. Every scenario runs in its own child process
 * because a process must pick its timezone before anything reads a `Date`, and
 * the card's crux — "today, the user's LOCAL calendar day" — is only
 * observable where the local day and the UTC day disagree.
 *
 * Point it at a different background.js with QA_BACKGROUND=<path> (used for
 * the negative control against pre-fix `main`).
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadBackground } from "./load-background.mjs";
import { createNotionMock, FULL_SCHEMA } from "./notion-mock.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../../..");
const BACKGROUND = process.env.QA_BACKGROUND || path.join(repoRoot, "background.js");

const API = { apiKey: "qa-key", databaseId: "qa-db-1" };

const PROBLEM = {
  number: 704,
  title: "Binary Search",
  difficulty: "Easy",
  url: "https://leetcode.com/problems/binary-search/",
  tags: ["Array", "Binary Search"],
};

/**
 * Eight clock/timezone scenarios. In seven of them the UTC day and the local
 * day are different dates, so "Spaced Repetition = today" has two possible
 * answers and only one of them is right.
 */
const SCENARIOS = [
  { name: "new-york-evening", tz: "America/New_York", now: "2026-08-11T01:00:00Z" },
  { name: "tokyo-morning", tz: "Asia/Tokyo", now: "2026-08-10T22:00:00Z" },
  { name: "midway-late", tz: "Pacific/Midway", now: "2026-08-11T10:00:00Z" },
  { name: "kiritimati-early", tz: "Pacific/Kiritimati", now: "2026-08-10T11:00:00Z" },
  { name: "utc-control", tz: "UTC", now: "2026-08-10T12:00:00Z" },
  { name: "ny-dst-spring", tz: "America/New_York", now: "2026-03-08T04:30:00Z" },
  { name: "ny-dst-fall", tz: "America/New_York", now: "2026-11-01T05:30:00Z" },
  { name: "ny-year-rollover", tz: "America/New_York", now: "2027-01-01T02:00:00Z" },
];

// ---------------------------------------------------------------- assertions

function makeReporter(scenario) {
  const rows = [];
  let section = "";
  return {
    section(name) {
      section = name;
    },
    is(ac, label, actual, expected) {
      const pass = JSON.stringify(actual) === JSON.stringify(expected);
      rows.push({ scenario, section, ac, label, pass, actual, expected });
      return pass;
    },
    ok(ac, label, cond, detail = "") {
      rows.push({
        scenario,
        section,
        ac,
        label,
        pass: !!cond,
        actual: cond ? "true" : `false ${detail}`,
        expected: "true",
      });
      return !!cond;
    },
    rows,
  };
}

// ---------------------------------------------------------------- helpers

function freshMock(seed = {}, opts = {}) {
  return createNotionMock(seed, opts);
}

function bootWith(mock, isoNow) {
  return loadBackground({
    file: BACKGROUND,
    isoNow,
    fetch: mock.fetch,
    sync: { notionApiKey: API.apiKey, notionDatabaseId: API.databaseId },
  });
}

const markTodoMessage = (extra = {}) => ({
  action: "markTodo",
  data: { ...API, problem: { ...PROBLEM }, confirmSchemaChanges: false, ...extra },
});

/** The payload popup.js sends for "Update in Notion" on a queued row. */
const updateMessage = (pageId, extra = {}) => ({
  action: "saveToNotion",
  data: {
    ...API,
    existingPageId: pageId,
    incrementAttempts: true,
    backfillFirstAttemptDate: true,
    spacedRepetitionDays: 3,
    confirmSchemaChanges: false,
    problem: {
      ...PROBLEM,
      code: "def search(nums, target):\n    return -1",
      language: "Python3",
      expertise: "Medium",
      notes: "binary search notes",
      remark: "tricky bounds",
      altMethods: "recursive",
      done: true,
      timeComplexity: "O(log n)",
      spaceComplexity: "O(1)",
      snapshots: [
        { type: "solution", language: "Python3", code: "def search(): pass", timestamp: 1 },
      ],
      saveQuestion: false,
      questionContent: { content: "", description: "", examples: [], constraints: [] },
    },
    ...extra,
  },
});

// ---------------------------------------------------------------- one scenario

async function runScenario(scenario) {
  const r = makeReporter(scenario.name);
  const localDay = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(scenario.now));
  const utcDay = new Date(scenario.now).toISOString().split("T")[0];

  /**
   * Sections are isolated: a section that throws records ONE failure row and
   * the run continues. Without this the negative control (pre-fix
   * background.js, where `markTodo` is an unknown action) would abort on the
   * first missing pageId and prove nothing about the remaining ACs.
   */
  const safe = async (label, fn) => {
    try {
      await fn();
    } catch (err) {
      r.ok("-", `${label} · section threw`, false, String(err?.message ?? err));
    }
  };

  // ============================================================ S1 · the row
  // AC3 — the six property values a queued row must hold, read back off the
  // stored page rather than off the request body.
  r.section("S1 · created row properties");
  await safe("S1", async () => {
    const mock = freshMock();
    const { send } = bootWith(mock, scenario.now);
    const res = await send(markTodoMessage());

    r.ok("AC3", "markTodo succeeded", res?.success === true, JSON.stringify(res));
    r.is("AC3", "exactly one page created", mock.createCount(), 1);

    const page = mock.onlyCreated();
    r.ok("AC3", "row exists in Notion", !!page);
    const p = page?.properties || {};

    r.is("AC3a", "Spaced Repetition = local today", p["Spaced Repetition"]?.date?.start, localDay);
    r.ok(
      "AC3a",
      "Spaced Repetition is NOT the UTC day when they differ",
      localDay === utcDay || p["Spaced Repetition"]?.date?.start !== utcDay,
      `utcDay=${utcDay}`,
    );
    r.is("AC3b", "Attempts = 0", p["Attempts"]?.number, 0);
    r.is("AC3c", "Date (of first attempt) absent", p["Date (of first attempt)"], undefined);
    r.is("AC3d", "Done = false", p["Done"]?.checkbox, false);
    r.ok("AC3d", "Done is written explicitly, not left to a Notion default", "Done" in p);
    r.is("AC3e", "My Expertise absent", p["My Expertise"], undefined);

    r.is("AC3f", "title populated", p["Question"]?.title?.[0]?.text?.content, PROBLEM.title);
    r.is("AC3f", "S No. populated", p["S No."]?.number, PROBLEM.number);
    r.is("AC3f", "Level populated", p["Level"]?.select?.name, PROBLEM.difficulty);
    r.is("AC3f", "Question Link populated", p["Question Link"]?.url, PROBLEM.url);
    r.is(
      "AC3f",
      "Tag populated from scraped tags",
      p["Tag"]?.multi_select?.map((t) => t.name),
      PROBLEM.tags,
    );

    // AC4 — no solution content, in properties or page body.
    r.section("S2 · no solution content");
    r.is("AC4", "page body is empty (no children)", page?.children?.length, 0);
    for (const prop of [
      "Remark",
      "Alternative Method Tags",
      "Time Complexity",
      "Space Complexity",
    ]) {
      r.is("AC4", `${prop} not written`, p[prop], undefined);
    }
    r.is(
      "AC4",
      "property set is exactly the queue set",
      Object.keys(p).sort(),
      ["Attempts", "Done", "Level", "Question", "Question Link", "S No.", "Spaced Repetition", "Tag"],
    );
    r.is(
      "AC4",
      "no block-append call was made",
      mock.requestsFor(/^blocks\//).filter((q) => q.method === "PATCH").length,
      0,
    );

    // Response contract the popup depends on for AC5's UI transition.
    r.section("S3 · response contract");
    r.is("AC5", "response.pageId is the created row", res?.pageId, page?.id);
    r.is("AC5", "response.attempts = 0", res?.attempts, 0);
    r.is("AC5", "response.updated = false", res?.updated, false);
    r.is("AC5", "response.todo = true", res?.todo, true);
    r.is("AC5", "response.contentUpdated = false", res?.contentUpdated, false);
  });

  // ============================================================ S4 · duplicates
  r.section("S4 · duplicate guard");
  await safe("S4", async () => {
    const mock = freshMock({
      "existing-page": {
        "S No.": { number: PROBLEM.number },
        Question: { title: [{ text: { content: PROBLEM.title } }] },
        Attempts: { number: 4 },
        "Spaced Repetition": { date: { start: "2026-12-01" } },
      },
    });
    const { send } = bootWith(mock, scenario.now);
    const res = await send(markTodoMessage());

    r.is("AC9", "no second row created", mock.createCount(), 0);
    r.is("AC9", "reports alreadyExists", res?.alreadyExists, true);
    r.is("AC9", "hands back the existing pageId", res?.pageId, "existing-page");
    r.is(
      "AC9",
      "existing row untouched (Attempts)",
      mock.attempts("existing-page"),
      4,
    );
    r.is(
      "AC9",
      "existing row untouched (Spaced Repetition)",
      mock.reviewDate("existing-page"),
      "2026-12-01",
    );

    // The stale-popup case: popup thought there was no row, but one appeared.
    // The background re-checks by problem number immediately before creating.
    const mock2 = freshMock({
      "raced-page": { "S No.": { number: PROBLEM.number }, Attempts: { number: 1 } },
    });
    const { send: send2 } = bootWith(mock2, scenario.now);
    const res2 = await send2(markTodoMessage());
    r.is("AC9", "stale popup lookup still cannot double-create", mock2.createCount(), 0);
    r.is("AC9", "adopts the raced row", res2?.pageId, "raced-page");
  });

  // ============================================================ S5 · round-trip
  // AC6 — the first real "Update in Notion" on a queued row.
  r.section("S5 · queue → attempt → update round-trip");
  await safe("S5", async () => {
    const mock = freshMock();
    const { send } = bootWith(mock, scenario.now);
    const todo = await send(markTodoMessage());
    const pageId = todo.pageId;

    // What the popup would see when it reopens on that row.
    const seen = await send({
      action: "checkExisting",
      data: { ...API, problemNumber: PROBLEM.number },
    });
    r.is("AC6", "checkExisting reports 0 attempts (not 1)", seen?.attempts, 0);
    r.is("AC6", "checkExisting reports no first-attempt date", seen?.hasFirstAttemptDate, false);
    r.is("AC6", "checkExisting reports Done unchecked", seen?.done, false);
    r.is("AC6", "checkExisting reports no expertise", seen?.expertise, null);

    const upd = await send(updateMessage(pageId));
    const p = mock.page(pageId).properties;

    r.ok("AC6", "update succeeded", upd?.success === true, JSON.stringify(upd));
    r.is("AC6", "update was not blocked by the queue create", upd?.updated, true);
    r.is("AC6", "Attempts 0 → 1 (not double-counted)", p["Attempts"]?.number, 1);
    r.is("AC6", "response.attempts = 1", upd?.attempts, 1);
    r.is(
      "AC6",
      "Date (of first attempt) backfilled to local today",
      p["Date (of first attempt)"]?.date?.start,
      localDay,
    );
    r.is("AC6", "My Expertise now set", p["My Expertise"]?.select?.name, "Medium");
    r.is("AC6", "Done now true", p["Done"]?.checkbox, true);
    r.is("AC6", "Remark now written", p["Remark"]?.rich_text?.[0]?.text?.content, "tricky bounds");
    r.is("AC6", "Time Complexity now written", p["Time Complexity"]?.select?.name, "O(log n)");
    r.ok("AC6", "page body now has content", mock.page(pageId).children.length > 0);
    r.is(
      "AC6",
      "Spaced Repetition moved to today + interval",
      p["Spaced Repetition"]?.date?.start,
      addDaysLocal(scenario.now, 3),
    );

    // A second update in the same popup session must not increment again
    // (popup sends incrementAttempts:false); and the backfilled date is never
    // rewritten once present.
    const upd2 = await send(
      updateMessage(pageId, { incrementAttempts: false, backfillFirstAttemptDate: false }),
    );
    r.ok("AC6", "second update succeeded", upd2?.success === true);
    r.is("AC6", "Attempts still 1 on a same-session re-update", mock.attempts(pageId), 1);
    r.is(
      "AC6",
      "first-attempt date unchanged by later updates",
      mock.page(pageId).properties["Date (of first attempt)"]?.date?.start,
      localDay,
    );
  });

  // ============================================================ S6 · due queue
  r.section("S6 · due today");
  await safe("S6", async () => {
    const mock = freshMock();
    const { send, api, notifications } = bootWith(mock, scenario.now);
    await send(markTodoMessage());

    notifications.length = 0;
    await api.checkDueReviews();
    r.is("AC7", "hourly review check fires one notification", notifications.length, 1);
    r.is(
      "AC7",
      "notification title",
      notifications[0]?.title,
      "LeetCode Review Due",
    );
    r.is(
      "AC7",
      "notification counts the queued problem",
      notifications[0]?.message,
      "You have 1 problem due for review today.",
    );
    // #11 (PR #15) replaced the flat `{property, date:{on_or_before}}` filter
    // with a compound `and:` — once a review date can be cleared, an empty
    // date must not read as due, so the guard is stated explicitly rather
    // than left to Notion's filter semantics. Read the new shape, and assert
    // both legs: this suite now also protects #11's is_not_empty guard.
    const dueQuery = mock
      .requestsFor(/databases\/.*\/query/)
      .filter((q) => q.body?.filter?.and?.[1]?.date?.on_or_before)
      .pop();
    r.is("AC7", "due filter uses the local day", dueQuery?.body?.filter?.and?.[1]?.date?.on_or_before, localDay);
    r.is(
      "AC7",
      "due filter still excludes cleared review dates",
      dueQuery?.body?.filter?.and?.[0]?.date?.is_not_empty,
      true,
    );

    const stats = await send({ action: "getStats", data: API });
    r.is("AC7", "popup stats count it as due", stats?.dueForReview, 1);
    r.is("AC7", "popup stats count it in the total", stats?.total, 1);
  });

  // ============================================================ S7 · failures
  r.section("S7 · failure path leaves no half-created state");
  await safe("S7", async () => {
    const mock = freshMock();
    const { send } = bootWith(mock, scenario.now);
    mock.failNextWith(500, "QA forced Notion failure", 3, /^pages$/);
    const res = await send(markTodoMessage());

    r.is("AC8", "failure is reported, not swallowed", res?.success, false);
    r.ok("AC8", "error message surfaced to the popup", typeof res?.error === "string" && res.error.length > 0, JSON.stringify(res));
    r.is("AC8", "no row was created", mock.createdPages().length, 0);
    r.is("AC8", "no page id handed back", res?.pageId, undefined);

    // And a retry after the outage clears succeeds — the button stays usable.
    const retry = await send(markTodoMessage());
    r.ok("AC8", "retry after the failure creates the row", retry?.success === true);
    r.is("AC8", "retry created exactly one row", mock.createdPages().length, 1);
    r.is(
      "AC8",
      "retried row still has Attempts 0",
      retry?.pageId ? mock.attempts(retry.pageId) : null,
      0,
    );
  });

  // ============================================================ S8 · schema
  r.section("S8 · schema guards apply to the queue path too");
  await safe("S8", async () => {
    // Missing columns → confirmation required, nothing written.
    const partial = { ...structuredClone(FULL_SCHEMA) };
    delete partial["Spaced Repetition"];
    delete partial["Attempts"];
    const mock = freshMock({}, { schema: partial });
    const { send } = bootWith(mock, scenario.now);

    const res = await send(markTodoMessage());
    r.is("AC8", "missing columns ask for confirmation", res?.needsSchemaConfirmation, true);
    r.is("AC8", "nothing created before the user confirms", mock.createdPages().length, 0);
    r.ok(
      "AC8",
      "the missing columns are named",
      (res?.missingColumns || []).map((c) => c.name).includes("Spaced Repetition"),
      JSON.stringify(res?.missingColumns),
    );

    const confirmed = await send(markTodoMessage({ confirmSchemaChanges: true }));
    r.ok("AC8", "confirming creates the row", confirmed?.success === true);
    r.is("AC8", "and still queues it unattempted", confirmed?.attempts, 0);
    r.is(
      "AC8",
      "with today's local review date",
      mock.reviewDate(confirmed?.pageId),
      localDay,
    );

    // Wrong column type on a column this write touches → fail fast, no row.
    const wrong = structuredClone(FULL_SCHEMA);
    wrong["Attempts"] = { type: "rich_text", rich_text: {} };
    const mock2 = freshMock({}, { schema: wrong });
    const { send: send2 } = bootWith(mock2, scenario.now);
    const res2 = await send2(markTodoMessage());
    r.is("AC8", "wrong column type blocks the queue write", res2?.success, false);
    r.ok("AC8", "and says which column", /Attempts/.test(res2?.error || ""), res2?.error);
    r.is("AC8", "no row created on a type mismatch", mock2.createdPages().length, 0);
  });

  // ============================================================ S9 · regression
  r.section("S9 · normal save path unchanged");
  await safe("S9", async () => {
    const mock = freshMock();
    const { send } = bootWith(mock, scenario.now);
    const res = await send({
      action: "saveToNotion",
      data: {
        ...API,
        spacedRepetitionDays: 3,
        confirmSchemaChanges: false,
        problem: {
          ...PROBLEM,
          code: "x = 1",
          language: "Python3",
          expertise: "Medium",
          done: true,
          notes: "",
          snapshots: [],
        },
      },
    });
    const page = mock.onlyCreated();
    const p = page?.properties || {};
    r.ok("REG", "plain save still succeeds", res?.success === true);
    r.is("REG", "plain save still writes Attempts = 1", p["Attempts"]?.number, 1);
    r.is(
      "REG",
      "plain save still writes first-attempt date = local today",
      p["Date (of first attempt)"]?.date?.start,
      localDay,
    );
    r.is("REG", "plain save still writes expertise", p["My Expertise"]?.select?.name, "Medium");
    r.is(
      "REG",
      "plain save still uses today + interval for review",
      p["Spaced Repetition"]?.date?.start,
      addDaysLocal(scenario.now, 3),
    );
    r.ok("REG", "plain save still writes page content", (page?.children?.length || 0) > 0);
    r.is("REG", "plain save reports attempts = 1", res?.attempts, 1);
  });

  return r.rows;
}

/** Local calendar day `days` days after the frozen instant, in this TZ. */
function addDaysLocal(isoNow, days) {
  const d = new Date(isoNow);
  const fmt = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const [y, m, day] = fmt.format(d).split("-").map(Number);
  const local = new Date(y, m - 1, day + days);
  const pad = (n) => String(n).padStart(2, "0");
  return `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())}`;
}

// ---------------------------------------------------------------- child mode

const childScenario = process.argv.indexOf("--scenario");
if (childScenario !== -1) {
  const name = process.argv[childScenario + 1];
  const scenario = SCENARIOS.find((s) => s.name === name);
  runScenario(scenario)
    .then((rows) => {
      process.stdout.write("\n__QA_JSON__" + JSON.stringify(rows) + "__QA_JSON__\n");
      process.exit(0);
    })
    .catch((err) => {
      process.stdout.write(
        "\n__QA_JSON__" +
          JSON.stringify([
            {
              scenario: name,
              section: "harness",
              ac: "-",
              label: "scenario threw",
              pass: false,
              actual: String(err && err.stack ? err.stack : err),
              expected: "no throw",
            },
          ]) +
          "__QA_JSON__\n",
      );
      process.exit(0);
    });
} else {
  // ------------------------------------------------------------ parent mode
  const self = fileURLToPath(import.meta.url);
  const all = [];

  console.log(`background under test: ${BACKGROUND}\n`);

  for (const scenario of SCENARIOS) {
    const rows = await new Promise((resolve) => {
      const child = spawn(process.execPath, [self, "--scenario", scenario.name], {
        env: { ...process.env, TZ: scenario.tz },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", () => {});
      child.on("close", () => {
        const m = out.match(/__QA_JSON__([\s\S]*?)__QA_JSON__/);
        resolve(m ? JSON.parse(m[1]) : [
          {
            scenario: scenario.name,
            section: "harness",
            ac: "-",
            label: "child produced no result",
            pass: false,
            actual: out.slice(-400),
            expected: "JSON payload",
          },
        ]);
      });
    });
    all.push(...rows);

    const failed = rows.filter((x) => !x.pass);
    const localDay = new Intl.DateTimeFormat("en-CA", {
      timeZone: scenario.tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(scenario.now));
    const utcDay = new Date(scenario.now).toISOString().split("T")[0];
    console.log(
      `${failed.length === 0 ? "PASS" : "FAIL"}  ${scenario.name.padEnd(18)} ` +
        `TZ=${scenario.tz.padEnd(20)} local ${localDay} / UTC ${utcDay}  ` +
        `${rows.length - failed.length}/${rows.length}`,
    );
    for (const f of failed.slice(0, 12)) {
      console.log(
        `        ✗ [${f.ac}] ${f.section} · ${f.label}\n` +
          `            expected ${JSON.stringify(f.expected)}\n` +
          `            actual   ${JSON.stringify(f.actual)}`,
      );
    }
    if (failed.length > 12) console.log(`        ... ${failed.length - 12} more`);
  }

  const byAc = new Map();
  for (const row of all) {
    const e = byAc.get(row.ac) || { pass: 0, fail: 0 };
    row.pass ? e.pass++ : e.fail++;
    byAc.set(row.ac, e);
  }

  console.log("\nper-AC totals");
  for (const [ac, e] of [...byAc.entries()].sort()) {
    console.log(`  ${ac.padEnd(6)} ${String(e.pass).padStart(4)} pass  ${String(e.fail).padStart(4)} fail`);
  }

  const failed = all.filter((x) => !x.pass);
  console.log(
    `\n${failed.length === 0 ? "ALL GREEN" : "FAILURES"}: ${all.length - failed.length}/${all.length} assertions passed`,
  );

  const fs = await import("node:fs");
  fs.writeFileSync(
    path.join(here, "..", process.env.QA_ASSERTIONS || "assertions.json"),
    JSON.stringify({ background: BACKGROUND, total: all.length, failed: failed.length, rows: all }, null, 2),
  );

  process.exit(failed.length === 0 ? 0 : 1);
}
