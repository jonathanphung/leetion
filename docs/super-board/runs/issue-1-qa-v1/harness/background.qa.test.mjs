/**
 * super-board QA harness — issue #1 (Attempts counter), background.js layer.
 *
 * Loads the REAL background.js (unmodified) into a Node vm context with a
 * stubbed `chrome` API and a fake Notion `fetch` that records every request
 * in order and keeps page state, then drives the registered onMessage
 * listener exactly like the popup does.
 *
 * Run:  node docs/super-board/runs/issue-1-qa-v1/harness/background.qa.test.mjs
 * Exit: 0 = all assertions pass, 1 = failures (printed per test).
 */
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../../../.."); // → worktree root
const backgroundSrc = fs.readFileSync(path.join(repoRoot, "background.js"), "utf8");

// ---------------------------------------------------------------- fake Notion
function makeFakeNotion() {
  const state = {
    pages: new Map(), // id → { properties }
    log: [],          // { method, endpoint, body } in call order
    failNext: null,   // { match: RegExp, status, message } — persistent while set
                      // (background's notionRequest retries ALL errors 3×, so a
                      // realistic outage must fail every attempt, not just one)
  };

  function pageObject(id) {
    const page = state.pages.get(id);
    return { object: "page", id, properties: JSON.parse(JSON.stringify(page.properties)) };
  }

  async function fakeFetch(url, options = {}) {
    const method = options.method || "GET";
    const endpoint = url.replace("https://api.notion.com/v1/", "");
    const body = options.body ? JSON.parse(options.body) : null;
    state.log.push({ method, endpoint, body });

    const respond = (status, obj) => ({
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      json: async () => obj,
    });

    if (state.failNext && state.failNext.match.test(`${method} ${endpoint}`)) {
      const f = state.failNext; // stays set: a real outage fails retries too
      return respond(f.status, { message: f.message, code: "qa_forced_failure" });
    }

    // GET pages/{id}
    let m = endpoint.match(/^pages\/([^/?]+)$/);
    if (m && method === "GET") {
      if (!state.pages.has(m[1])) return respond(404, { message: "page not found" });
      return respond(200, pageObject(m[1]));
    }
    // PATCH pages/{id}
    if (m && method === "PATCH") {
      if (!state.pages.has(m[1])) return respond(404, { message: "page not found" });
      const page = state.pages.get(m[1]);
      Object.assign(page.properties, JSON.parse(JSON.stringify(body.properties || {})));
      return respond(200, pageObject(m[1]));
    }
    // POST pages  (create)
    if (endpoint === "pages" && method === "POST") {
      const id = `created-page-${state.pages.size + 1}`;
      state.pages.set(id, { properties: JSON.parse(JSON.stringify(body.properties || {})) });
      return respond(200, { object: "page", id });
    }
    // GET databases/{id} — report full schema so ensureDatabaseSchema is a no-op
    m = endpoint.match(/^databases\/([^/?]+)$/);
    if (m && method === "GET") {
      const allProps = {};
      for (const name of [
        "Problem", "Problem Name", "Difficulty", "Tags", "Status", "Done",
        "Expertise", "Remark", "Alternative Methods", "URL", "Language",
        "Time Complexity", "Space Complexity", "Spaced Repetition", "Attempts",
        "Notes", "Date Solved", "Created", "Last Edited",
      ]) allProps[name] = { id: name, name };
      return respond(200, { object: "database", id: m[1], properties: allProps });
    }
    if (m && method === "PATCH") return respond(200, { object: "database", id: m[1] });
    // POST databases/{id}/query
    if (/^databases\/[^/]+\/query$/.test(endpoint) && method === "POST") {
      return respond(200, { results: [] });
    }
    // GET blocks/{id}/children
    if (/^blocks\/[^/]+\/children/.test(endpoint) && method === "GET") {
      return respond(200, { results: [], has_more: false });
    }
    // POST blocks/{id}/children (append)
    if (/^blocks\/[^/]+\/children$/.test(endpoint) && method === "POST") {
      return respond(200, { results: [] });
    }
    // DELETE blocks/{id}
    if (/^blocks\/[^/]+$/.test(endpoint) && method === "DELETE") {
      return respond(200, {});
    }
    return respond(200, {});
  }

  return { state, fakeFetch };
}

// ------------------------------------------------------------- chrome + load
function loadBackground(fakeFetch) {
  let messageListener = null;
  const noop = () => {};
  const listenerSink = { addListener: noop };
  const chrome = {
    runtime: {
      onMessage: { addListener: (fn) => { messageListener = fn; } },
      onInstalled: listenerSink,
      onStartup: listenerSink,
      sendMessage: noop,
      getURL: (p) => `chrome-extension://qa-harness/${p}`,
      lastError: null,
    },
    tabs: { onUpdated: listenerSink, create: noop },
    alarms: { create: noop, onAlarm: listenerSink },
    notifications: { create: noop },
    storage: { sync: { get: async () => ({}) } },
  };
  const context = vm.createContext({
    chrome,
    fetch: fakeFetch,
    console: { log: noop, warn: noop, error: noop },
    setTimeout, clearTimeout,
    Date, JSON, Math, Promise, Error, Object, Array, String, Number, Boolean, RegExp, Map, Set, URL,
  });
  new vm.Script(backgroundSrc, { filename: "background.js" }).runInContext(context);
  if (!messageListener) throw new Error("background.js did not register an onMessage listener");
  return function sendMessage(request) {
    return new Promise((resolve) => {
      messageListener(request, { id: "qa-harness" }, resolve);
    });
  };
}

// ------------------------------------------------------------------ helpers
let passCount = 0, failCount = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passCount++; console.log(`  ok   - ${name}`); }
  else {
    failCount++;
    failures.push({ name, detail });
    console.log(`  FAIL - ${name}${detail ? `\n         ${detail}` : ""}`);
  }
}
const patchOf = (log, id) => log.filter((r) => r.method === "PATCH" && r.endpoint === `pages/${id}`);
const getOf = (log, id) => log.filter((r) => r.method === "GET" && r.endpoint === `pages/${id}`);

const PROBLEM = {
  number: 1, title: "Two Sum", difficulty: "Easy",
  code: "def twoSum(): pass", language: "Python",
  url: "https://leetcode.com/problems/two-sum/", tags: [], expertise: "Medium",
  remark: "", notes: "", altMethods: [], done: true,
  timeComplexity: "O(n)", spaceComplexity: "O(n)",
  snapshots: [], saveQuestion: false,
  questionContent: { description: "", examples: [], constraints: [] },
};

// -------------------------------------------------------------------- tests
async function main() {
  // ============================================ AC2 — server-fresh increment
  console.log("\nAC2: update with incrementAttempts=true reads server value and writes read+1");
  {
    const { state, fakeFetch } = makeFakeNotion();
    const send = loadBackground(fakeFetch);
    state.pages.set("page-1", { properties: {
      Attempts: { number: 7 },
      "Spaced Repetition": { date: { start: "2026-08-20" } },
    }});
    const res = await send({ action: "saveToNotion", data: {
      apiKey: "qa-key", databaseId: "db-1", existingPageId: "page-1",
      incrementAttempts: true, spacedRepetitionDays: 30, problem: PROBLEM,
    }});
    const patches = patchOf(state.log, "page-1");
    const gets = getOf(state.log, "page-1");
    check("PATCH carries Attempts = server 7 + 1 = 8",
      patches.length >= 1 && patches[0].body?.properties?.Attempts?.number === 8,
      `patch properties: ${JSON.stringify(patches[0]?.body?.properties?.Attempts)}`);
    check("a GET pages/{id} precedes the PATCH (server-fresh read)",
      gets.length >= 1 && state.log.indexOf(gets[0]) < state.log.indexOf(patches[0]),
      `log order: ${state.log.map((r) => `${r.method} ${r.endpoint}`).join(" → ")}`);
    check("GET is IMMEDIATELY before the PATCH (no calls between)",
      state.log.indexOf(patches[0]) - state.log.indexOf(gets[0]) === 1,
      `log order: ${state.log.map((r) => `${r.method} ${r.endpoint}`).join(" → ")}`);
    check("response.success && response.attempts === 8",
      res?.success === true && res?.attempts === 8, JSON.stringify(res));
    check("Notion page now has Attempts 8",
      state.pages.get("page-1").properties.Attempts.number === 8);
  }

  // ------------ AC2b — a direct Notion edit between popup-open and save wins
  console.log("\nAC2b: direct Notion edit (7 → 41) made before save is preserved +1, not stale-overwritten");
  {
    const { state, fakeFetch } = makeFakeNotion();
    const send = loadBackground(fakeFetch);
    state.pages.set("page-1", { properties: { Attempts: { number: 41 } } }); // user edited in Notion
    const res = await send({ action: "saveToNotion", data: {
      apiKey: "qa-key", databaseId: "db-1", existingPageId: "page-1",
      incrementAttempts: true, spacedRepetitionDays: 30, problem: PROBLEM,
    }});
    check("write is 42 (fresh 41 + 1), not a stale popup value",
      res?.attempts === 42 && state.pages.get("page-1").properties.Attempts.number === 42,
      JSON.stringify(res));
  }

  // ===================== AC1 (backend half) — repeat update omits Attempts
  console.log("\nAC1-backend: update with incrementAttempts=false omits Attempts from the PATCH");
  {
    const { state, fakeFetch } = makeFakeNotion();
    const send = loadBackground(fakeFetch);
    state.pages.set("page-1", { properties: { Attempts: { number: 8 } } });
    const res = await send({ action: "saveToNotion", data: {
      apiKey: "qa-key", databaseId: "db-1", existingPageId: "page-1",
      incrementAttempts: false, spacedRepetitionDays: 30, problem: PROBLEM,
    }});
    const patches = patchOf(state.log, "page-1");
    check("PATCH body has NO Attempts key",
      patches.length >= 1 && !("Attempts" in (patches[0].body?.properties || {})),
      `patch properties keys: ${Object.keys(patches[0]?.body?.properties || {}).join(", ")}`);
    check("no GET pages/{id} read is wasted when not incrementing",
      getOf(state.log, "page-1").length === 0,
      `log: ${state.log.map((r) => `${r.method} ${r.endpoint}`).join(" → ")}`);
    check("Notion Attempts unchanged at 8",
      state.pages.get("page-1").properties.Attempts.number === 8);
    check("response carries no attempts field (popup keeps its display value)",
      res?.success === true && !("attempts" in res), JSON.stringify(res));
  }

  // ========================================= AC3 — first save writes Attempts 1
  console.log("\nAC3: first-time save (no existingPageId) creates the page with Attempts = 1");
  {
    const { state, fakeFetch } = makeFakeNotion();
    const send = loadBackground(fakeFetch);
    const res = await send({ action: "saveToNotion", data: {
      apiKey: "qa-key", databaseId: "db-1", existingPageId: null,
      incrementAttempts: false, spacedRepetitionDays: 30, problem: PROBLEM,
    }});
    const create = state.log.find((r) => r.method === "POST" && r.endpoint === "pages");
    check("POST pages body has Attempts = 1",
      create?.body?.properties?.Attempts?.number === 1,
      JSON.stringify(create?.body?.properties?.Attempts));
    check("response.success, pageId set, attempts === 1",
      res?.success === true && !!res?.pageId && res?.attempts === 1, JSON.stringify(res));
  }

  // ==== AC4 — updateAttempts PATCHes ONLY Attempts; Spaced Repetition untouched
  console.log("\nAC4: updateAttempts action → GET then PATCH of ONLY the Attempts property");
  {
    const { state, fakeFetch } = makeFakeNotion();
    const send = loadBackground(fakeFetch);
    const dateBefore = JSON.stringify({ date: { start: "2026-08-20" } });
    state.pages.set("page-1", { properties: {
      Attempts: { number: 3 },
      "Spaced Repetition": JSON.parse(dateBefore),
      Status: { select: { name: "Done" } },
    }});
    const res = await send({ action: "updateAttempts", data: { apiKey: "qa-key", pageId: "page-1" } });
    const patches = patchOf(state.log, "page-1");
    const gets = getOf(state.log, "page-1");
    check("exactly one GET + one PATCH on the page, GET first",
      gets.length === 1 && patches.length === 1 &&
      state.log.indexOf(gets[0]) < state.log.indexOf(patches[0]),
      `log: ${state.log.map((r) => `${r.method} ${r.endpoint}`).join(" → ")}`);
    check("PATCH body property keys === [Attempts] only",
      JSON.stringify(Object.keys(patches[0]?.body?.properties || {})) === JSON.stringify(["Attempts"]),
      `keys: ${Object.keys(patches[0]?.body?.properties || {}).join(", ")}`);
    check("Attempts written as server-fresh 3 + 1 = 4",
      patches[0]?.body?.properties?.Attempts?.number === 4);
    check("Spaced Repetition byte-identical before/after",
      JSON.stringify(state.pages.get("page-1").properties["Spaced Repetition"]) === dateBefore,
      JSON.stringify(state.pages.get("page-1").properties["Spaced Repetition"]));
    check("response {success:true, attempts:4}",
      res?.success === true && res?.attempts === 4, JSON.stringify(res));
  }

  // ============ AC6 — Revisit increments via updateSpacedRepetition; Tomorrow doesn't
  console.log("\nAC6: updateSpacedRepetition with attempts (Revisit) vs without (Tomorrow)");
  {
    const { state, fakeFetch } = makeFakeNotion();
    const send = loadBackground(fakeFetch);
    state.pages.set("page-1", { properties: {
      Attempts: { number: 4 },
      "Spaced Repetition": { date: { start: "2026-08-20" } },
    }});
    // Revisit path: popup sends days + attempts
    const r1 = await send({ action: "updateSpacedRepetition", data: {
      apiKey: "qa-key", pageId: "page-1", days: 30, attempts: 5,
    }});
    let patches = patchOf(state.log, "page-1");
    check("Revisit: PATCH sets BOTH Spaced Repetition and Attempts=5",
      r1?.success === true &&
      patches[0]?.body?.properties?.["Spaced Repetition"]?.date?.start &&
      patches[0]?.body?.properties?.Attempts?.number === 5,
      JSON.stringify(patches[0]?.body?.properties));
    // Tomorrow path: popup sends days:1 and NO attempts
    state.log.length = 0;
    const r2 = await send({ action: "updateSpacedRepetition", data: {
      apiKey: "qa-key", pageId: "page-1", days: 1,
    }});
    patches = patchOf(state.log, "page-1");
    check("Tomorrow: PATCH sets Spaced Repetition only — NO Attempts key",
      r2?.success === true &&
      patches[0]?.body?.properties?.["Spaced Repetition"]?.date?.start &&
      !("Attempts" in (patches[0]?.body?.properties || {})),
      JSON.stringify(patches[0]?.body?.properties));
    check("Attempts still 5 after Tomorrow",
      state.pages.get("page-1").properties.Attempts.number === 5);
  }

  // ============================ AC7 (backend half) — failed write reports error
  console.log("\nAC7-backend: updateAttempts returns {success:false, error} on Notion failure");
  {
    const { state, fakeFetch } = makeFakeNotion();
    const send = loadBackground(fakeFetch);
    state.pages.set("page-1", { properties: { Attempts: { number: 9 } } });
    state.failNext = { match: /^PATCH pages\/page-1$/, status: 500, message: "Notion exploded (QA forced)" };
    const res = await send({ action: "updateAttempts", data: { apiKey: "qa-key", pageId: "page-1" } });
    check("response is {success:false, error:...}",
      res?.success === false && typeof res?.error === "string" && res.error.includes("QA forced"),
      JSON.stringify(res));
    check("Notion Attempts unchanged at 9 after failed PATCH",
      state.pages.get("page-1").properties.Attempts.number === 9);
  }

  // ---- unknown action still errors cleanly (guard for the new switch case)
  console.log("\nRegression: unknown action still rejects via the wrapper");
  {
    const { fakeFetch } = makeFakeNotion();
    const send = loadBackground(fakeFetch);
    const res = await send({ action: "definitelyNotAnAction", data: {} });
    check("unknown action → {success:false, error mentions action}",
      res?.success === false && /Unknown action/.test(res?.error || ""), JSON.stringify(res));
  }

  // -------------------------------------------------------------- summary
  console.log(`\n${"=".repeat(60)}`);
  console.log(`background.js layer: ${passCount} passed, ${failCount} failed`);
  if (failCount > 0) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f.name}${f.detail ? ` :: ${f.detail}` : ""}`);
    process.exit(1);
  }
}

main().catch((e) => { console.error("HARNESS CRASH:", e); process.exit(2); });
