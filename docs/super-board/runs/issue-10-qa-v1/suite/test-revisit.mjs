/**
 * super-board QA suite — issue #10
 * "Revisit button should set Spaced Repetition to today, not today + interval"
 *
 * Runs the REAL background.js (nothing rewritten) against a stateful in-memory
 * Notion (notion-mock.mjs) with the clock frozen, once per timezone scenario.
 * Each scenario is its own child process because a process must pick its
 * timezone before anything reads a Date.
 *
 *   node docs/super-board/runs/issue-10-qa-v1/suite/test-revisit.mjs
 *   node .../test-revisit.mjs --only new-york-evening      # single scenario
 *
 * Writes assertions.json next to the suite. Exit code 0 iff every assertion
 * passed in every scenario.
 */
process.env.TZ = process.env.QA_TZ || process.env.TZ;

const { fileURLToPath } = await import("node:url");
const path = await import("node:path");
const fs = await import("node:fs");
const { spawnSync } = await import("node:child_process");

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../../..");
// QA_BACKGROUND lets the same suite be pointed at a pre-fix background.js as a
// negative control — a suite that passes on the broken code proves nothing.
const BACKGROUND = process.env.QA_BACKGROUND
  ? path.resolve(process.env.QA_BACKGROUND)
  : path.join(repoRoot, "background.js");

// ---------------------------------------------------------------------------
// Scenarios. Each freezes the clock at an instant chosen so the UTC calendar
// day and the user's local calendar day disagree (except the UTC control).
// ---------------------------------------------------------------------------
const SCENARIOS = {
  "new-york-evening": {
    tz: "America/New_York",
    isoNow: "2026-08-11T01:00:00Z", // 2026-08-10 21:00 EDT
    today: "2026-08-10",
    tomorrow: "2026-08-11",
    why: "AC4 primary case — negative UTC offset, evening: UTC is already tomorrow",
  },
  "tokyo-morning": {
    tz: "Asia/Tokyo",
    isoNow: "2026-08-10T22:00:00Z", // 2026-08-11 07:00 JST
    today: "2026-08-11",
    tomorrow: "2026-08-12",
    why: "positive UTC offset, morning: UTC is still yesterday",
  },
  "midway-late": {
    tz: "Pacific/Midway",
    isoNow: "2026-08-11T10:00:00Z", // 2026-08-10 23:00 SST (UTC-11)
    today: "2026-08-10",
    tomorrow: "2026-08-11",
    why: "extreme negative offset (UTC-11), last hour of the local day",
  },
  "kiritimati-early": {
    tz: "Pacific/Kiritimati",
    isoNow: "2026-08-10T11:00:00Z", // 2026-08-11 01:00 LINT (UTC+14)
    today: "2026-08-11",
    tomorrow: "2026-08-12",
    why: "extreme positive offset (UTC+14), first hour of the local day",
  },
  "utc-control": {
    tz: "UTC",
    isoNow: "2026-08-10T12:00:00Z",
    today: "2026-08-10",
    tomorrow: "2026-08-11",
    why: "control — local and UTC agree; the fix must not disturb this case",
  },
  "ny-dst-spring": {
    tz: "America/New_York",
    isoNow: "2026-03-08T04:30:00Z", // 2026-03-07 23:30 EST, DST starts next day
    today: "2026-03-07",
    tomorrow: "2026-03-08",
    why: "DST spring-forward boundary — today+1 crosses a 23-hour local day",
  },
  "ny-dst-fall": {
    tz: "America/New_York",
    isoNow: "2026-11-01T05:30:00Z", // 2026-11-01 01:30 EDT, before the 02:00 fall-back
    today: "2026-11-01",
    tomorrow: "2026-11-02",
    why: "DST fall-back boundary — today+1 crosses a 25-hour local day",
  },
  "ny-year-rollover": {
    tz: "America/New_York",
    isoNow: "2027-01-01T02:00:00Z", // 2026-12-31 21:00 EST
    today: "2026-12-31",
    tomorrow: "2027-01-01",
    why: "year rollover with a negative offset — UTC is already next year",
  },
};

const PAGE = "qa-page-1";
const utcDay = (iso) => new Date(iso).toISOString().split("T")[0];

// ---------------------------------------------------------------------------
// Child: run one scenario
// ---------------------------------------------------------------------------
async function runScenario(name) {
  const s = SCENARIOS[name];
  const { createNotionMock } = await import("./notion-mock.mjs");
  const { loadBackground } = await import("./load-background.mjs");

  const results = [];
  const check = (section, ac, label, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    results.push({ scenario: name, section, ac, label, ok, expected, actual });
  };
  /** Sections must not abort the run — a throw is itself a reportable failure. */
  const section = async (id, ac, fn) => {
    try {
      await fn();
    } catch (err) {
      results.push({
        scenario: name,
        section: id,
        ac,
        label: `section threw: ${err.message}`,
        ok: false,
        expected: "no exception",
        actual: String(err.message),
      });
    }
  };

  /** A page that already has an old review date + some attempts. */
  const seed = () => ({
    [PAGE]: {
      "Spaced Repetition": { date: { start: "2026-09-30" } },
      Attempts: { number: 3 },
      Done: { checkbox: false },
    },
  });

  const boot = (isoNow, sync = {}) => {
    const notion = createNotionMock(seed());
    const bg = loadBackground({
      file: BACKGROUND,
      isoNow,
      fetch: notion.fetch,
      sync: { notionApiKey: "qa-key", notionDatabaseId: "qa-db", ...sync },
    });
    return { notion, bg };
  };

  // Instants derived inside the child, so they are true local-clock instants
  // for this timezone (incl. DST) rather than naive UTC arithmetic.
  const base = new Date(s.isoNow);
  const [Y, M, D] = [base.getFullYear(), base.getMonth(), base.getDate()];
  const localInstant = (dayOffset, h, min) =>
    new Date(Y, M, D + dayOffset, h, min, 0).toISOString();

  // ===== S1 — the local-calendar-day primitive (AC4) ========================
  await section("S1", "AC4", async () => {
    const { bg } = boot(s.isoNow);
    check("S1", "AC4", "localDateString() is the LOCAL calendar day", bg.api.localDateString(), s.today);
    check("S1", "AC4", "localDateInDays(0) === today", bg.api.localDateInDays(0), s.today);
    check("S1", "AC4", "localDateInDays(1) === tomorrow", bg.api.localDateInDays(1), s.tomorrow);
    // The pre-fix expression, evaluated here for the record. Where it differs
    // from the local day, this scenario is a case the old code got wrong.
    const preFix = utcDay(s.isoNow);
    results.push({
      scenario: name,
      section: "S1",
      ac: "AC4",
      label: `pre-fix UTC formula would have written ${preFix} (local day ${s.today})`,
      ok: true,
      informational: true,
      expected: s.today,
      actual: preFix,
      differs: preFix !== s.today,
    });
  });

  // ===== S2 — Revisit writes today, read back off the page (AC1) ============
  await section("S2", "AC1", async () => {
    const { notion, bg } = boot(s.isoNow);
    notion.reset();
    const res = await bg.send({
      action: "updateSpacedRepetition",
      data: { apiKey: "qa-key", pageId: PAGE, setToday: true },
    });
    check("S2", "AC1", "message router reports success", res?.success, true);
    check("S2", "AC1", "response.date is the local today", res?.date, s.today);
    check("S2", "AC1", "exactly one PATCH reached Notion", notion.requestsFor(/^pages\//).length, 1);
    check("S2", "AC1", "PATCH body properties", notion.lastRequest().body.properties, {
      "Spaced Repetition": { date: { start: s.today } },
    });
    // Read the stored page back through the API, not out of the request log.
    const page = await (await notion.fetch(`https://api.notion.com/v1/pages/${PAGE}`, { method: "GET" })).json();
    check("S2", "AC1", "page 'Spaced Repetition' after the write", page.properties["Spaced Repetition"], {
      date: { start: s.today },
    });
    check("S2", "AC1", "the stale 2026-09-30 date was replaced", notion.reviewDate(PAGE), s.today);
    check("S2", "AC1", "unrelated properties untouched", page.properties.Done, { checkbox: false });
    check("S2", "AC5", "Attempts is not part of the write", page.properties.Attempts, { number: 3 });
  });

  // ===== S3 — interval independence (AC3) ===================================
  await section("S3", "AC3", async () => {
    const variants = [
      ["no days field at all", { setToday: true }],
      ["days:0 (reviews disabled for this expertise)", { setToday: true, days: 0 }],
      ["days:1 (Low)", { setToday: true, days: 1 }],
      ["days:3 (Medium)", { setToday: true, days: 3 }],
      ["days:7 (High)", { setToday: true, days: 7 }],
      ["days:null", { setToday: true, days: null }],
    ];
    for (const [label, extra] of variants) {
      const { notion, bg } = boot(s.isoNow);
      const res = await bg.send({
        action: "updateSpacedRepetition",
        data: { apiKey: "qa-key", pageId: PAGE, ...extra },
      });
      check("S3", "AC3", `setToday wins over ${label}`, [res.success, notion.reviewDate(PAGE)], [true, s.today]);
    }
    // and the write does not depend on any stored interval settings
    const { notion, bg } = boot(s.isoNow, {
      spacedRepetitionIntervals: { Low: 0, Medium: 0, High: 0 },
      spacedRepetitionDays: 0,
    });
    await bg.send({
      action: "updateSpacedRepetition",
      data: { apiKey: "qa-key", pageId: PAGE, setToday: true },
    });
    check("S3", "AC3", "intervals stored as 0/0/0 do not suppress the write", notion.reviewDate(PAGE), s.today);
  });

  // ===== S4 — Review Today does NOT touch Attempts (AC5) ====================
  // Scheduling a problem for review is not an attempt at it. Revisit sends no
  // `attempts` field at all, so the count must survive any number of clicks.
  await section("S4", "AC5", async () => {
    const { notion, bg } = boot(s.isoNow);
    await bg.send({
      action: "updateSpacedRepetition",
      data: { apiKey: "qa-key", pageId: PAGE, setToday: true },
    });
    check("S4", "AC5", "Attempts stays 3 after Review Today", notion.attempts(PAGE), 3);
    check("S4", "AC5", "no Attempts property in the PATCH body", "Attempts" in notion.lastRequest().body.properties, false);
    await bg.send({
      action: "updateSpacedRepetition",
      data: { apiKey: "qa-key", pageId: PAGE, setToday: true },
    });
    check("S4", "AC5", "second click still leaves Attempts at 3", notion.attempts(PAGE), 3);
    check("S4", "AC5", "date still today after the second click", notion.reviewDate(PAGE), s.today);

    // The handler itself still honours `attempts` when a caller sends one —
    // the save path and the manual +1 rely on that. Only Revisit stopped.
    const other = boot(s.isoNow);
    await other.bg.send({
      action: "updateSpacedRepetition",
      data: { apiKey: "qa-key", pageId: PAGE, setToday: true, attempts: 4 },
    });
    check("S4", "AC5", "an explicit attempts value is still written", other.notion.attempts(PAGE), 4);

    // Failure path: a Notion error must surface as success:false so the popup
    // can report it, and must leave both the date and the count untouched.
    const fail = boot(s.isoNow);
    fail.notion.failNextWith(500, "Notion is down");
    const res = await fail.bg.send({
      action: "updateSpacedRepetition",
      data: { apiKey: "qa-key", pageId: PAGE, setToday: true },
    });
    check("S4", "AC5", "a failed PATCH reports success:false", res.success, false);
    check("S4", "AC5", "a failed PATCH leaves Attempts alone", fail.notion.attempts(PAGE), 3);
    check("S4", "AC5", "a failed PATCH leaves the date alone", fail.notion.reviewDate(PAGE), "2026-09-30");
  });

  // ===== S5 — the reset problem is due TODAY (AC6) ==========================
  await section("S5", "AC6", async () => {
    // Write at 00:05 local, then run the hourly alarm's query at three points
    // in the SAME local day. All three must see the problem as due.
    const writeAt = localInstant(0, 0, 5);
    const w = boot(writeAt);
    await w.bg.send({
      action: "updateSpacedRepetition",
      data: { apiKey: "qa-key", pageId: PAGE, setToday: true },
    });
    check("S5", "AC6", "written at 00:05 local -> today", w.notion.reviewDate(PAGE), s.today);
    const written = w.notion.reviewDate(PAGE);

    for (const [label, h, min] of [
      ["00:06 local (just after the write)", 0, 6],
      ["12:00 local (midday)", 12, 0],
      ["23:55 local (last alarm of the day)", 23, 55],
    ]) {
      const q = boot(localInstant(0, h, min));
      q.notion.setPage(PAGE, {
        "Spaced Repetition": { date: { start: written } },
        Attempts: { number: 3 },
      });
      q.notion.reset();
      await q.bg.api.checkDueReviews();
      const query = q.notion.requestsFor(/\/query$/)[0];
      check("S5", "AC6", `checkDueReviews at ${label} filters on the local today`, query.body.filter, {
        property: "Spaced Repetition",
        date: { on_or_before: s.today },
      });
      const due = (await (await q.notion.fetch("https://api.notion.com/v1/databases/qa-db/query", {
        method: "POST",
        body: JSON.stringify({ filter: query.body.filter }),
      })).json()).results;
      check("S5", "AC6", `reset problem is in the due set at ${label}`, due.map((p) => p.id), [PAGE]);
      check("S5", "AC6", `the review notification fires at ${label}`, q.bg.notifications.length, 1);
    }

    // The stats panel's own due count must agree with the alarm.
    const st = boot(s.isoNow);
    st.notion.setPage(PAGE, { "Spaced Repetition": { date: { start: written } } });
    const stats = await st.bg.send({
      action: "getStats",
      data: { apiKey: "qa-key", databaseId: "qa-db" },
    });
    check("S5", "AC6", "getStats counts the reset problem as due", stats.dueForReview, 1);
  });

  // ===== S6 — Review Tomorrow unchanged, and NOT due today (AC7 + AC6) ======
  await section("S6", "AC7", async () => {
    const { notion, bg } = boot(s.isoNow);
    notion.reset();
    const res = await bg.send({
      action: "updateSpacedRepetition",
      data: { apiKey: "qa-key", pageId: PAGE, days: 1 },
    });
    check("S6", "AC7", "days:1 writes today+1 (local)", notion.reviewDate(PAGE), s.tomorrow);
    check("S6", "AC7", "days:1 response.date", res.date, s.tomorrow);
    check("S6", "AC7", "days:1 writes no Attempts property", notion.lastRequest().body.properties, {
      "Spaced Repetition": { date: { start: s.tomorrow } },
    });
    check("S6", "AC7", "Attempts on the page is untouched by Review Tomorrow", notion.attempts(PAGE), 3);

    // Discriminator: a "tomorrow" problem must NOT be in today's due set, and
    // MUST be in tomorrow's. A UTC/local mix-up shows up here as an off-by-one.
    const todayQ = boot(s.isoNow);
    todayQ.notion.setPage(PAGE, { "Spaced Repetition": { date: { start: s.tomorrow } } });
    todayQ.notion.reset();
    await todayQ.bg.api.checkDueReviews();
    const todayFilter = todayQ.notion.requestsFor(/\/query$/)[0].body.filter;
    const dueToday = (await (await todayQ.notion.fetch("https://api.notion.com/v1/databases/qa-db/query", {
      method: "POST",
      body: JSON.stringify({ filter: todayFilter }),
    })).json()).results;
    check("S6", "AC6", "a Review-Tomorrow problem is NOT due today", dueToday.length, 0);
    check("S6", "AC6", "…and no notification fires", todayQ.bg.notifications.length, 0);

    const tomorrowQ = boot(localInstant(1, 9, 0));
    tomorrowQ.notion.setPage(PAGE, { "Spaced Repetition": { date: { start: s.tomorrow } } });
    tomorrowQ.notion.reset();
    await tomorrowQ.bg.api.checkDueReviews();
    const tomorrowFilter = tomorrowQ.notion.requestsFor(/\/query$/)[0].body.filter;
    check("S6", "AC6", "next local day, the filter has advanced one day", tomorrowFilter.date.on_or_before, s.tomorrow);
    const dueTomorrow = (await (await tomorrowQ.notion.fetch("https://api.notion.com/v1/databases/qa-db/query", {
      method: "POST",
      body: JSON.stringify({ filter: tomorrowFilter }),
    })).json()).results;
    check("S6", "AC6", "…and the problem is due then", dueTomorrow.map((p) => p.id), [PAGE]);
  });

  // ===== S7 — days:0 keeps its old meaning (regression / #11 precondition) ==
  await section("S7", "—", async () => {
    const { notion, bg } = boot(s.isoNow);
    notion.reset();
    const res = await bg.send({
      action: "updateSpacedRepetition",
      data: { apiKey: "qa-key", pageId: PAGE, days: 0, attempts: 9 },
    });
    check("S7", "—", "days:0 alone leaves the date untouched", notion.reviewDate(PAGE), "2026-09-30");
    check("S7", "—", "days:0 still writes Attempts", notion.attempts(PAGE), 9);
    check("S7", "—", "days:0 PATCH body carries only Attempts", notion.lastRequest().body.properties, {
      Attempts: { number: 9 },
    });
    check("S7", "—", "days:0 response.date is null", res.date, null);

    const empty = boot(s.isoNow);
    empty.notion.reset();
    const skipped = await empty.bg.send({
      action: "updateSpacedRepetition",
      data: { apiKey: "qa-key", pageId: PAGE, days: 0 },
    });
    check("S7", "—", "nothing to write -> no request at all", empty.notion.requests.length, 0);
    check("S7", "—", "nothing to write -> skipped:true", [skipped.success, skipped.skipped], [true, true]);
  });

  // ===== S8 — the save path still uses the interval, now local (issue #3) ===
  await section("S8", "AC3", async () => {
    const { bg } = boot(s.isoNow);
    const problem = { title: "Two Sum", number: 1, difficulty: "Easy", expertise: "Medium" };
    const created = bg.api.buildProperties(problem, null, 3);
    check("S8", "AC3", "save path with interval 3 -> local today+3", created["Spaced Repetition"], {
      date: { start: bg.api.localDateInDays(3) },
    });
    check("S8", "AC4", "'Date (of first attempt)' is the local day", created["Date (of first attempt)"], {
      date: { start: s.today },
    });
    const disabled = bg.api.buildProperties(problem, "page-x", 0);
    check("S8", "AC3", "save path with interval 0 writes no review date", "Spaced Repetition" in disabled, false);
  });

  return results;
}

// ---------------------------------------------------------------------------
// Parent: fan out one child per scenario
// ---------------------------------------------------------------------------
if (process.env.QA_SCENARIO) {
  // background.js is chatty. Capture its console instead of interleaving it
  // with the report; replay the tail on stderr only if something failed.
  const captured = [];
  const real = { log: console.log, warn: console.warn, error: console.error };
  for (const k of ["log", "warn", "error"]) {
    console[k] = (...a) => captured.push(`[${k}] ${a.map(String).join(" ")}`);
  }
  let results;
  try {
    results = await runScenario(process.env.QA_SCENARIO);
  } finally {
    Object.assign(console, real);
  }
  const ok = results.every((r) => r.ok);
  if (!ok) process.stderr.write(captured.slice(-40).join("\n") + "\n");
  process.stdout.write("\n__QA_JSON__" + JSON.stringify(results) + "__QA_JSON__\n");
  process.exit(ok ? 0 : 1);
} else {
  const onlyIdx = process.argv.indexOf("--only");
  const names =
    onlyIdx > -1 ? [process.argv[onlyIdx + 1]] : Object.keys(SCENARIOS);

  const all = [];
  let failed = 0;

  console.log("super-board QA — issue #10 · Revisit sets Spaced Repetition to today");
  console.log(`node ${process.version} · background.js under test: ${BACKGROUND}`);
  console.log("=".repeat(78));

  for (const name of names) {
    const s = SCENARIOS[name];
    console.log(
      `\n### ${name}  [TZ=${s.tz}]  frozen at ${s.isoNow}` +
        `\n    local day ${s.today} · UTC day ${utcDay(s.isoNow)}` +
        `${utcDay(s.isoNow) !== s.today ? "  <-- they disagree" : "  (they agree)"}` +
        `\n    ${s.why}`,
    );
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      env: { ...process.env, QA_SCENARIO: name, QA_TZ: s.tz },
      encoding: "utf8",
    });
    const m = r.stdout.match(/__QA_JSON__(.*)__QA_JSON__/s);
    if (!m) {
      console.log("    CHILD FAILED TO REPORT");
      console.log(r.stdout.split("\n").filter((l) => !l.startsWith("Leetion")).slice(-25).join("\n"));
      console.log(r.stderr.slice(-4000));
      failed++;
      continue;
    }
    const results = JSON.parse(m[1]);
    all.push(...results);
    let section = null;
    for (const res of results) {
      if (res.section !== section) {
        section = res.section;
        console.log(`  ${section}`);
      }
      if (res.informational) {
        console.log(`    ..  ${res.label}${res.differs ? "  [the old code was wrong here]" : ""}`);
        continue;
      }
      const tag = res.ok ? "PASS" : "FAIL";
      console.log(`    ${tag}  [${res.ac}] ${res.label}`);
      if (!res.ok) {
        failed++;
        console.log(`          expected ${JSON.stringify(res.expected)}`);
        console.log(`          actual   ${JSON.stringify(res.actual)}`);
      }
    }
  }

  const real = all.filter((r) => !r.informational);
  const byAc = {};
  for (const r of real) {
    byAc[r.ac] ??= { pass: 0, fail: 0 };
    r.ok ? byAc[r.ac].pass++ : byAc[r.ac].fail++;
  }

  console.log("\n" + "=".repeat(78));
  console.log(`Scenarios: ${names.length}   Assertions: ${real.length}   Failures: ${failed}`);
  for (const [ac, c] of Object.entries(byAc).sort()) {
    console.log(`  ${ac.padEnd(5)} ${String(c.pass).padStart(3)} pass  ${c.fail} fail`);
  }
  fs.writeFileSync(
    path.join(here, "..", process.env.QA_BACKGROUND ? "assertions-negative-control.json" : "assertions.json"),
    JSON.stringify({ node: process.version, scenarios: names.length, assertions: real.length, failures: failed, byAc, results: all }, null, 2),
  );
  console.log(failed === 0 ? "\nALL CHECKS PASSED" : `\n${failed} CHECK(S) FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}
