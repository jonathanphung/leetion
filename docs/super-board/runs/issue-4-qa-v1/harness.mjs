/**
 * QA harness for issue #4 — "Stop duplicate date columns: align README with
 * real schema, make auto-schema non-silent" (PR #9, branch
 * issue-4-stop-duplicate-date-columns).
 *
 * Loads the real background.js in a Node `vm` context with a stubbed `chrome`
 * and a recording `fetch`, then exercises saveToNotion() against mock Notion
 * databases. One observable test (or test group) per acceptance criterion.
 *
 * Run:  node harness.mjs   (from this directory; exits non-zero on failure)
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";

const ROOT = new URL("../../../../", import.meta.url);
const bgSource = readFileSync(new URL("background.js", ROOT), "utf8");
const readme = readFileSync(new URL("README.md", ROOT), "utf8");

// ---------------------------------------------------------------- infra ----

let failures = 0;
let checks = 0;
const lines = [];
function log(msg) {
  lines.push(msg);
  console.log(msg);
}
function assert(cond, label, detail = "") {
  checks++;
  if (cond) {
    log(`  PASS  ${label}`);
  } else {
    failures++;
    log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

// Recursive no-op proxy standing in for the chrome.* API surface.
function makeChromeStub() {
  const handler = {
    get(target, prop) {
      if (prop === Symbol.toPrimitive || prop === "toString") {
        return () => "[chrome-stub]";
      }
      if (!(prop in target)) {
        target[prop] = new Proxy(function () {}, handler);
      }
      return target[prop];
    },
    apply() {
      return undefined;
    },
  };
  return new Proxy(function () {}, handler);
}

// Recording fetch with per-scenario routes.
let routes = [];
let requests = [];
const allDbPatches = []; // every PATCH databases/* body, across all scenarios
function setRoutes(r) {
  routes = r;
  requests = [];
}
async function fakeFetch(url, options = {}) {
  const method = options.method || "GET";
  const body = options.body ? JSON.parse(options.body) : null;
  requests.push({ url, method, body });
  if (method === "PATCH" && url.includes("/databases/")) {
    allDbPatches.push(body);
  }
  for (const route of routes) {
    if (route.method === method && url.includes(route.match)) {
      return route.respond(body);
    }
  }
  throw new Error(`Unstubbed request: ${method} ${url}`);
}
const ok = (json) => ({
  ok: true,
  status: 200,
  headers: { get: () => null },
  json: async () => json,
});
const httpErr = (status, message) => ({
  ok: false,
  status,
  headers: { get: () => null },
  json: async () => ({ message, code: "validation_error" }),
});
const reqCount = (method, match) =>
  requests.filter((r) => r.method === method && r.url.includes(match)).length;

// Background console output captured as user-visible-log evidence (AC3).
const bgConsole = [];
const quietConsole = {
  log: (...a) => bgConsole.push("[log] " + a.map(String).join(" ")),
  warn: (...a) => bgConsole.push("[warn] " + a.map(String).join(" ")),
  error: (...a) => bgConsole.push("[error] " + a.map(String).join(" ")),
};

const context = vm.createContext({
  chrome: makeChromeStub(),
  fetch: fakeFetch,
  console: quietConsole,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
});
vm.runInContext(
  bgSource +
    "\n;globalThis.__x = { DATABASE_SCHEMA, inspectDatabaseSchema, ensureDatabaseSchema, saveToNotion, buildProperties };",
  context,
  { filename: "background.js" },
);
const { DATABASE_SCHEMA, saveToNotion, buildProperties } = context.__x;

// ------------------------------------------------------------- fixtures ----

const prop = (type, extra = {}) => ({ type, ...extra, [type]: extra[type] ?? {} });

// Database exactly matching DATABASE_SCHEMA (the "already-correct DB").
function exactSchemaDb() {
  const properties = {};
  for (const [name, config] of Object.entries(DATABASE_SCHEMA)) {
    properties[name] = { type: config.type, [config.type]: {} };
  }
  return { properties };
}

// Database built by following the OLD README instructions verbatim.
const legacyReadmeDb = () => ({
  properties: {
    Name: prop("title"),
    Number: prop("number"),
    Difficulty: prop("select"),
    Tags: prop("multi_select"),
    Status: prop("checkbox"),
    Expertise: prop("select"),
    "Time Complexity": prop("rich_text"),
    "Space Complexity": prop("rich_text"),
    Attempts: prop("number"),
    Notes: prop("rich_text"),
    Remark: prop("rich_text"),
    "Alternative Methods": prop("rich_text"),
    Date: prop("date"),
    Review: prop("date"),
    URL: prop("url"),
  },
});

const problem = {
  number: 1,
  title: "Two Sum",
  url: "https://leetcode.com/problems/two-sum/",
  tags: ["Array", "Hash Table"],
  difficulty: "Easy",
  expertise: "Medium",
  remark: "hash map lookup",
  altMethods: "brute force",
  done: true,
  attempts: 2,
  code: "def twoSum(nums, target): pass",
  language: "python3",
};

const base = { apiKey: "secret_test", databaseId: "db1", spacedRepetitionDays: 30 };

// ------------------------------------------------------------------- AC1 ----

log("AC1 — README schema table matches DATABASE_SCHEMA exactly");
{
  // Parse the schema table: the contiguous markdown table containing "Question".
  const tables = [];
  let current = [];
  for (const line of readme.split("\n")) {
    if (/^\|/.test(line.trim())) current.push(line.trim());
    else if (current.length) {
      tables.push(current);
      current = [];
    }
  }
  if (current.length) tables.push(current);
  const schemaTable = tables.find((t) =>
    t.some((row) => /^\|\s*Question\s*\|/.test(row)),
  );
  assert(!!schemaTable, "README contains a schema table with a Question row");

  const rows = (schemaTable || [])
    .filter((r) => !/^\|[\s\-|]+\|$/.test(r)) // drop separator row
    .slice(1) // drop header row
    .map((r) => r.split("|").map((c) => c.trim()).filter(Boolean))
    .filter((cells) => cells.length >= 2)
    .map(([name, type]) => ({ name, type }));

  const tableNames = rows.map((r) => r.name);
  const schemaNames = Object.keys(DATABASE_SCHEMA);

  const missingFromTable = schemaNames.filter((n) => !tableNames.includes(n));
  const extraInTable = tableNames.filter((n) => !schemaNames.includes(n));
  assert(
    missingFromTable.length === 0,
    "every DATABASE_SCHEMA property appears in the README table",
    `missing: ${missingFromTable.join(", ")}`,
  );
  assert(
    extraInTable.length === 0,
    "README table has no property that DATABASE_SCHEMA lacks",
    `extra: ${extraInTable.join(", ")}`,
  );

  const typeWord = {
    title: "title",
    number: "number",
    select: "select",
    multi_select: "multi-select",
    checkbox: "checkbox",
    date: "date",
    url: "url",
    rich_text: "rich text",
  };
  for (const { name, type } of rows) {
    const expected = typeWord[DATABASE_SCHEMA[name]?.type];
    const normalized = type.toLowerCase().replace(/\s*\(.*\)$/, "").trim();
    assert(
      expected !== undefined && normalized === expected,
      `README type for "${name}" is "${type}" (schema: ${DATABASE_SCHEMA[name]?.type})`,
      `normalized "${normalized}" != "${expected}"`,
    );
  }

  const stale = [
    "Date", "Review", "Name", "Number", "Difficulty", "Tags", "Status",
    "Expertise", "Alternative Methods", "URL",
  ];
  const staleInTable = stale.filter((s) => tableNames.includes(s));
  assert(
    staleInTable.length === 0,
    "no stale old-README name appears as a column name in the table",
    `found: ${staleInTable.join(", ")}`,
  );
  assert(
    /never deletes columns|merge or remove the leftover columns manually/i.test(readme),
    "README documents manual cleanup of legacy duplicate columns (issue note)",
  );
}

// ------------------------------------------------------------------- AC2 ----

log("");
log("AC2 — legacy README-style DB: no silent second date column");
{
  setRoutes([
    { method: "GET", match: "/databases/db1", respond: () => ok(legacyReadmeDb()) },
  ]);
  const res = await saveToNotion({ ...base, problem: { ...problem } });
  assert(
    res.success === false && res.needsSchemaConfirmation === true,
    "unconfirmed save returns needsSchemaConfirmation instead of creating columns",
    JSON.stringify(res).slice(0, 200),
  );
  assert(
    reqCount("PATCH", "/databases/") === 0 && reqCount("POST", "/pages") === 0,
    "no PATCH (column create) and no page write before confirmation",
  );
  const dateCol = (res.missingColumns || []).find(
    (c) => c.name === "Date (of first attempt)",
  );
  assert(
    !!dateCol && dateCol.similarExisting.includes("Date") && dateCol.similarExisting.includes("Review"),
    'warning lists existing same-type columns ("Date", "Review") next to "Date (of first attempt)"',
    JSON.stringify(dateCol),
  );
  const listed = (res.missingColumns || []).map((c) => c.name).sort();
  const expectedMissing = [
    "S No.", "Level", "Tag", "My Expertise", "Done",
    "Date (of first attempt)", "Question Link", "Alternative Method Tags",
    "Spaced Repetition",
  ].sort();
  assert(
    JSON.stringify(listed) === JSON.stringify(expectedMissing),
    "warning lists exactly the columns about to be created (9, title excluded)",
    `got: ${listed.join(", ")}`,
  );

  // Confirmed save: columns created add-only, title mapped to legacy "Name".
  setRoutes([
    { method: "GET", match: "/databases/db1", respond: () => ok(legacyReadmeDb()) },
    { method: "PATCH", match: "/databases/db1", respond: () => ok({}) },
    { method: "POST", match: "/pages", respond: () => ok({ id: "page_1" }) },
  ]);
  const res2 = await saveToNotion({
    ...base,
    problem: { ...problem },
    confirmSchemaChanges: true,
  });
  assert(res2.success === true, "confirmed save succeeds", JSON.stringify(res2).slice(0, 200));
  const patch = requests.find((r) => r.method === "PATCH" && r.url.includes("/databases/"));
  const patchedNames = Object.keys(patch?.body?.properties || {}).sort();
  assert(
    JSON.stringify(patchedNames) === JSON.stringify(expectedMissing),
    "PATCH creates exactly the confirmed missing columns — nothing else",
    `patched: ${patchedNames.join(", ")}`,
  );
  const pagePost = requests.find((r) => r.method === "POST" && r.url.includes("/pages"));
  assert(
    !!pagePost?.body?.properties?.Name?.title && !pagePost?.body?.properties?.Question,
    'problem title is written to the DB\'s real title column ("Name"), not a new "Question"',
  );
  assert(
    JSON.stringify(res2.schemaCreated?.slice().sort()) === JSON.stringify(expectedMissing),
    "response reports the created columns back to the popup (schemaCreated)",
    JSON.stringify(res2.schemaCreated),
  );
  assert(
    typeof res2.schemaWarning === "string" && res2.schemaWarning.includes("Time Complexity"),
    "non-blocking wrong-type columns (legacy rich_text Time/Space Complexity) reported as warning",
    JSON.stringify(res2.schemaWarning),
  );
}

// ------------------------------------------------------------------- AC3 ----

log("");
log("AC3 — schema results/errors surfaced, not swallowed");
{
  // Column-creation failure is returned as a visible error.
  setRoutes([
    { method: "GET", match: "/databases/db1", respond: () => ok(legacyReadmeDb()) },
    { method: "PATCH", match: "/databases/db1", respond: () => httpErr(400, "body failed validation") },
  ]);
  const res = await saveToNotion({
    ...base,
    problem: { ...problem },
    confirmSchemaChanges: true,
  });
  assert(
    res.success === false && /Could not add columns/.test(res.error || ""),
    "failed column creation returns a clear error to the popup (not swallowed)",
    JSON.stringify(res).slice(0, 200),
  );
  assert(
    reqCount("POST", "/pages") === 0,
    "no page write is attempted after column creation fails",
  );

  // Schema-read failure is surfaced as a warning while the save still runs.
  setRoutes([
    { method: "GET", match: "/databases/db1", respond: () => httpErr(500, "internal server error") },
    { method: "POST", match: "/pages", respond: () => ok({ id: "page_2" }) },
  ]);
  const res2 = await saveToNotion({ ...base, problem: { ...problem } });
  assert(
    res2.success === true && /Could not verify database columns/.test(res2.schemaWarning || ""),
    "schema-read failure surfaces schemaWarning on an otherwise-successful save",
    JSON.stringify({ success: res2.success, warning: res2.schemaWarning }),
  );
}

// ------------------------------------------------------------------- AC4 ----

log("");
log("AC4 — wrong-type same-name column detected and reported clearly");
{
  const db = exactSchemaDb();
  db.properties.Attempts = prop("rich_text"); // wrong type, name matches
  setRoutes([
    { method: "GET", match: "/databases/db1", respond: () => ok(db) },
  ]);
  const res = await saveToNotion({ ...base, problem: { ...problem, attempts: 3 } });
  assert(
    res.success === false &&
      /Wrong column type/.test(res.error || "") &&
      /Attempts/.test(res.error || "") &&
      /rich_text/.test(res.error || "") &&
      /number/.test(res.error || ""),
    "save fails fast with a message naming the column, actual and required type",
    JSON.stringify(res.error),
  );
  assert(
    reqCount("POST", "/pages") === 0 && reqCount("PATCH", "/databases/") === 0,
    "no opaque page write and no column create happen after the type mismatch",
  );
}

// ------------------------------------------------------------------- AC5 ----

log("");
log("AC5 — regression: matching DB untouched; first-attempt date only on create");
{
  setRoutes([
    { method: "GET", match: "/databases/db1", respond: () => ok(exactSchemaDb()) },
    { method: "POST", match: "/pages", respond: () => ok({ id: "page_3" }) },
  ]);
  const res = await saveToNotion({ ...base, problem: { ...problem } });
  assert(
    res.success === true && !res.needsSchemaConfirmation,
    "already-correct DB: save succeeds with no confirmation prompt",
    JSON.stringify(res).slice(0, 200),
  );
  assert(
    reqCount("PATCH", "/databases/") === 0,
    "already-correct DB: zero columns created (no databases PATCH)",
  );
  assert(
    (res.schemaCreated || []).length === 0,
    "already-correct DB: schemaCreated is empty",
  );
  const pagePost = requests.find((r) => r.method === "POST" && r.url.includes("/pages"));
  assert(
    !!pagePost?.body?.properties?.["Date (of first attempt)"],
    'new page carries "Date (of first attempt)"',
  );

  const createProps = buildProperties({ ...problem }, null, 30);
  const updateProps = buildProperties({ ...problem }, "page_3", 30);
  assert(
    "Date (of first attempt)" in createProps &&
      !("Date (of first attempt)" in updateProps),
    'buildProperties gate: "Date (of first attempt)" set on create only, never on update',
  );
}

// ------------------------------------------------------------------- AC6 ----

log("");
log("AC6 — conservative: columns only added, never renamed/retyped/deleted");
{
  assert(allDbPatches.length > 0, "at least one databases PATCH was captured across scenarios");
  let violations = [];
  for (const body of allDbPatches) {
    for (const [name, config] of Object.entries(body?.properties || {})) {
      if (config === null) violations.push(`${name}: null (delete)`);
      else if ("name" in config) violations.push(`${name}: rename to ${config.name}`);
      else if (!(name in DATABASE_SCHEMA)) violations.push(`${name}: not a schema column`);
    }
  }
  assert(
    violations.length === 0,
    "every databases PATCH is add-only (no null deletes, no renames, schema columns only)",
    violations.join("; "),
  );
  assert(
    !/properties\s*:\s*\{[^}]*:\s*null/.test(bgSource),
    "static check: background.js never sends a null property (Notion delete syntax)",
  );
}

// ---------------------------------------------------------------- summary ----

log("");
log(`RESULT: ${checks - failures}/${checks} checks passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
