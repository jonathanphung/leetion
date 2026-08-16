/**
 * Builder-side local check for issue #5 — Submissions sync.
 *
 * Loads the REAL background.js and the REAL content.js in sandboxes (chrome,
 * fetch, window, document injected as Function parameters so they shadow the
 * globals inside each file's scope) and asserts:
 *
 *   A. Schema      — Submissions is in DATABASE_SCHEMA with the right type, and
 *                    the README table matches DATABASE_SCHEMA exactly (#4's
 *                    invariant).
 *   B. Notion write— updateSubmissions PATCHes ONLY the Submissions property
 *                    (the Attempts regression assertion), and every failure
 *                    mode issues no PATCH at all.
 *   C. LeetCode    — fetchSubmissionCount pages, de-duplicates, caps, detects
 *                    logged-out, fails closed on schema drift, and refuses to
 *                    run on leetcode.cn.
 *
 * Usage (from the repo root):
 *   node docs/super-board/runs/issue-5-build/harness/submissions-check.js
 */

const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "../../../../..");
const backgroundSrc = fs.readFileSync(
  path.join(repoRoot, "background.js"),
  "utf8",
);
const contentSrc = fs.readFileSync(path.join(repoRoot, "content.js"), "utf8");
const readmeSrc = fs.readFileSync(path.join(repoRoot, "README.md"), "utf8");

// --- tiny assertion runner ---------------------------------------------------

let passed = 0;
const failures = [];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertDeep(actual, expected, message) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${message}\n        got:      ${a}\n        wanted:   ${b}`);
}

const tests = [];
function test(name, fn) {
  tests.push([name, fn]);
}

// --- background.js sandbox ---------------------------------------------------

const noop = () => {};

function backgroundChromeStub() {
  return {
    runtime: {
      onMessage: { addListener: noop },
      onStartup: { addListener: noop },
      onInstalled: { addListener: noop },
      getURL: (p) => p,
      lastError: null,
    },
    alarms: { create: noop, onAlarm: { addListener: noop } },
    storage: { sync: { get: async () => ({}) } },
    tabs: { create: noop, onUpdated: { addListener: noop }, query: async () => [] },
    notifications: { create: noop, onClicked: { addListener: noop } },
    action: { setBadgeText: noop, setBadgeBackgroundColor: noop },
  };
}

/**
 * Loads background.js with a Notion fetch double.
 * @param {Object} options
 *   dbProperties - properties object returned for GET databases/<id>
 *   patchFails   - when true every PATCH pages/<id> returns a 400
 */
function loadBackground(options = {}) {
  const calls = [];

  async function fetchStub(url, init) {
    const method = init.method;
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, method, body });

    if (method === "GET" && /\/databases\//.test(url)) {
      return jsonResponse(200, {
        id: "db-stub",
        properties: options.dbProperties || {},
      });
    }
    if (method === "PATCH" && /\/pages\//.test(url)) {
      if (options.patchFails) {
        return jsonResponse(400, {
          message: "Submissions is not a property that exists",
          code: "validation_error",
        });
      }
      return jsonResponse(200, { id: "page-stub" });
    }
    return jsonResponse(200, {});
  }

  const factory = new Function(
    "chrome",
    "fetch",
    `${backgroundSrc}\n; return { DATABASE_SCHEMA, updateSubmissions };`,
  );

  return { api: factory(backgroundChromeStub(), fetchStub), calls };
}

function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => payload,
  };
}

/** Every PATCH issued against a Notion page during a background call. */
function pagePatches(calls) {
  return calls.filter((c) => c.method === "PATCH" && /\/pages\//.test(c.url));
}

// --- content.js sandbox ------------------------------------------------------

/**
 * content.js is an IIFE, so its internals are not reachable from outside.
 * Unwrap the body and re-expose exactly the pieces under test — the code
 * itself is the real file, byte for byte.
 */
function contentBody() {
  const open = contentSrc.indexOf("(function () {");
  const close = contentSrc.lastIndexOf("})();");
  if (open < 0 || close < 0) {
    throw new Error("content.js IIFE wrapper not found - harness needs updating");
  }
  return contentSrc.slice(open + "(function () {".length, close);
}

/**
 * Loads content.js against a fake LeetCode page.
 * @param {Object} options
 *   hostname - page hostname (defaults to leetcode.com)
 *   pages    - array of per-request responses; each entry is either
 *              { status, payload } or a function(offset) returning one
 */
function loadContent(options = {}) {
  const hostname = options.hostname || "leetcode.com";
  const requests = [];

  const windowStub = {
    leetionContentLoaded: undefined,
    location: {
      hostname,
      origin: `https://${hostname}`,
      pathname: options.pathname || "/problems/two-sum/description/",
      href: `https://${hostname}${options.pathname || "/problems/two-sum/"}`,
    },
    addEventListener: noop,
    devicePixelRatio: 1,
  };

  const documentStub = {
    cookie: options.cookie === undefined ? "csrftoken=csrf-123; other=x" : options.cookie,
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({ style: {}, appendChild: noop, setAttribute: noop }),
    addEventListener: noop,
    body: { innerText: "", appendChild: noop },
    head: { appendChild: noop },
  };

  let callIndex = 0;
  async function fetchStub(url, init) {
    const body = JSON.parse(init.body);
    requests.push({ url, init, variables: body.variables, query: body.query });

    let spec = options.pages ? options.pages[callIndex] : undefined;
    callIndex += 1;
    if (typeof spec === "function") spec = spec(body.variables.offset);
    if (spec === undefined) spec = { status: 200, payload: emptyPage() };
    if (spec.throws) throw new Error(spec.throws);

    return {
      ok: spec.status >= 200 && spec.status < 300,
      status: spec.status,
      json: async () => {
        if (spec.badJson) throw new Error("Unexpected token < in JSON");
        return spec.payload;
      },
    };
  }

  const chromeStub = {
    runtime: { onMessage: { addListener: noop } },
  };

  const factory = new Function(
    "chrome",
    "window",
    "document",
    "fetch",
    "console",
    `${contentBody()}\n; return { fetchSubmissionCount, problemSlugFromPath, isSubmissionSyncHost, SUBMISSION_PAGE_SIZE, SUBMISSION_PAGE_CAP, SUBMISSION_COUNT_CAP };`,
  );

  const api = factory(chromeStub, windowStub, documentStub, fetchStub, {
    log: noop,
    warn: noop,
    error: noop,
  });
  return { api, requests };
}

function emptyPage() {
  return { data: { questionSubmissionList: { hasNext: false, submissions: [] } } };
}

/** A full page of `n` submissions with unique ids starting at `offset`. */
function submissionPage(offset, n, hasNext) {
  return {
    data: {
      questionSubmissionList: {
        hasNext,
        submissions: Array.from({ length: n }, (_, i) => ({
          id: String(offset + i),
          statusDisplay: i % 3 === 0 ? "Accepted" : "Wrong Answer",
        })),
      },
    },
  };
}

// ============================================================================
// A. SCHEMA + README INVARIANT
// ============================================================================

test("A1 DATABASE_SCHEMA has Submissions as a plain number column", () => {
  const { api } = loadBackground();
  const entry = api.DATABASE_SCHEMA["Submissions"];
  assert(entry, "Submissions missing from DATABASE_SCHEMA");
  assertDeep(
    entry,
    { type: "number", number: { format: "number" } },
    "Submissions schema entry is not the plain number shape",
  );
});

test("A2 Attempts is still its own, unchanged schema entry", () => {
  const { api } = loadBackground();
  assertDeep(
    api.DATABASE_SCHEMA["Attempts"],
    { type: "number", number: { format: "number" } },
    "Attempts schema entry changed",
  );
});

test("A3 README table lists exactly the DATABASE_SCHEMA columns (#4 invariant)", () => {
  const { api } = loadBackground();
  const rows = readmeSrc
    .split("\n")
    .filter((line) => /^\|/.test(line))
    .map((line) => line.split("|").map((cell) => cell.trim()))
    .filter((cells) => cells.length > 2 && !/^-+$/.test(cells[1]) && cells[1] !== "Property")
    .map((cells) => cells[1]);

  const schemaNames = Object.keys(api.DATABASE_SCHEMA);
  const missingFromReadme = schemaNames.filter((n) => !rows.includes(n));
  const extraInReadme = rows.filter((n) => !schemaNames.includes(n));

  assert(
    missingFromReadme.length === 0,
    `README is missing schema columns: ${missingFromReadme.join(", ")}`,
  );
  assert(
    extraInReadme.length === 0,
    `README lists columns that are not in DATABASE_SCHEMA: ${extraInReadme.join(", ")}`,
  );
});

// ============================================================================
// B. NOTION WRITE — updateSubmissions
// ============================================================================

const schemaWithBoth = {
  Question: { type: "title" },
  Attempts: { type: "number" },
  Submissions: { type: "number" },
};

test("B1 a successful sync PATCHes Submissions and nothing else (Attempts untouched)", async () => {
  const { api, calls } = loadBackground({ dbProperties: schemaWithBoth });
  const result = await api.updateSubmissions({
    apiKey: "k",
    databaseId: "db",
    pageId: "page-1",
    count: 42,
  });

  assert(result.success === true, `expected success, got ${JSON.stringify(result)}`);
  assert(result.count === 42, `expected count 42, got ${result.count}`);

  const patches = pagePatches(calls);
  assert(patches.length === 1, `expected exactly 1 page PATCH, got ${patches.length}`);
  assertDeep(
    patches[0].body,
    { properties: { Submissions: { number: 42 } } },
    "PATCH body must carry Submissions only",
  );
  assert(
    !("Attempts" in patches[0].body.properties),
    "REGRESSION: the sync PATCH touched Attempts",
  );
  assert(
    Object.keys(patches[0].body.properties).length === 1,
    `PATCH wrote extra properties: ${Object.keys(patches[0].body.properties).join(", ")}`,
  );
});

test("B2 a genuine zero is written (0 submissions is a real answer)", async () => {
  const { api, calls } = loadBackground({ dbProperties: schemaWithBoth });
  const result = await api.updateSubmissions({
    apiKey: "k",
    databaseId: "db",
    pageId: "page-1",
    count: 0,
  });
  assert(result.success === true, "a real 0 should still be written");
  assertDeep(
    pagePatches(calls)[0].body,
    { properties: { Submissions: { number: 0 } } },
    "0 not written as a plain number",
  );
});

test("B3 a non-numeric count is refused before any request", async () => {
  for (const bad of [undefined, null, NaN, -1, "12"]) {
    const { api, calls } = loadBackground({ dbProperties: schemaWithBoth });
    const result = await api.updateSubmissions({
      apiKey: "k",
      databaseId: "db",
      pageId: "page-1",
      count: bad,
    });
    assert(result.success === false, `count=${String(bad)} should be refused`);
    assert(
      pagePatches(calls).length === 0,
      `count=${String(bad)} issued a PATCH - a failed fetch must never write`,
    );
  }
});

test("B4 no pageId is refused before any request", async () => {
  const { api, calls } = loadBackground({ dbProperties: schemaWithBoth });
  const result = await api.updateSubmissions({
    apiKey: "k",
    databaseId: "db",
    pageId: null,
    count: 3,
  });
  assert(result.success === false, "missing pageId should be refused");
  assert(pagePatches(calls).length === 0, "missing pageId issued a PATCH");
});

test("B5 missing Submissions column reports it instead of writing", async () => {
  const { api, calls } = loadBackground({
    dbProperties: { Question: { type: "title" }, Attempts: { type: "number" } },
  });
  const result = await api.updateSubmissions({
    apiKey: "k",
    databaseId: "db",
    pageId: "page-1",
    count: 7,
  });
  assert(result.success === false, "missing column should fail");
  assert(result.missingColumn === true, "missingColumn flag not set");
  assert(
    /Update in Notion/.test(result.error),
    `error should point at the existing schema-confirm flow, got: ${result.error}`,
  );
  assert(pagePatches(calls).length === 0, "wrote despite the column being absent");
});

test("B6 wrong Submissions column type is reported instead of writing", async () => {
  const { api, calls } = loadBackground({
    dbProperties: {
      Question: { type: "title" },
      Submissions: { type: "rich_text" },
    },
  });
  const result = await api.updateSubmissions({
    apiKey: "k",
    databaseId: "db",
    pageId: "page-1",
    count: 7,
  });
  assert(result.success === false, "type mismatch should fail");
  assert(/rich_text/.test(result.error), `error should name the actual type: ${result.error}`);
  assert(pagePatches(calls).length === 0, "wrote despite the wrong column type");
});

test("B7 a Notion API failure surfaces the error, never a silent success", async () => {
  const { api } = loadBackground({
    dbProperties: schemaWithBoth,
    patchFails: true,
  });
  const result = await api.updateSubmissions({
    apiKey: "k",
    databaseId: "db",
    pageId: "page-1",
    count: 7,
  });
  assert(result.success === false, "a failing PATCH must report failure");
  assert(typeof result.error === "string" && result.error.length > 0, "no error message");
});

// ============================================================================
// C. LEETCODE FETCH — fetchSubmissionCount
// ============================================================================

test("C1 single short page: count is the number of submissions, not capped", async () => {
  const { api, requests } = loadContent({
    pages: [{ status: 200, payload: submissionPage(0, 7, false) }],
  });
  const result = await api.fetchSubmissionCount("two-sum");

  assert(result.success === true, `expected success: ${JSON.stringify(result)}`);
  assert(result.count === 7, `expected 7, got ${result.count}`);
  assert(result.capped === false, "short page should not be capped");
  assert(requests.length === 1, `expected 1 request, got ${requests.length}`);
  assertDeep(
    requests[0].variables,
    { offset: 0, limit: 20, questionSlug: "two-sum" },
    "first page variables wrong",
  );
});

test("C2 request is same-origin JSON with the csrf token attached", async () => {
  const { api, requests } = loadContent({
    pages: [{ status: 200, payload: submissionPage(0, 1, false) }],
  });
  await api.fetchSubmissionCount("two-sum");

  const { url, init } = requests[0];
  assert(url === "https://leetcode.com/graphql/", `wrong endpoint: ${url}`);
  assert(init.credentials === "same-origin", `credentials: ${init.credentials}`);
  assert(init.headers["x-csrftoken"] === "csrf-123", "csrf token not forwarded");
  assert(
    /questionSubmissionList/.test(requests[0].query),
    "query is not questionSubmissionList",
  );
  assert(
    !/runtime|code|memory|timestamp|lang/.test(requests[0].query),
    "query asks for more than id + statusDisplay",
  );
});

test("C3 paging: follows hasNext across pages and sums them", async () => {
  const { api, requests } = loadContent({
    pages: [
      { status: 200, payload: submissionPage(0, 20, true) },
      { status: 200, payload: submissionPage(20, 20, true) },
      { status: 200, payload: submissionPage(40, 5, false) },
    ],
  });
  const result = await api.fetchSubmissionCount("two-sum");

  assert(result.count === 45, `expected 45, got ${result.count}`);
  assert(result.capped === false, "should not be capped at 45");
  assert(result.pagesFetched === 3, `expected 3 pages, got ${result.pagesFetched}`);
  assertDeep(
    requests.map((r) => r.variables.offset),
    [0, 20, 40],
    "offsets not advanced by page size",
  );
});

test("C4 cap: stops at 5 pages / 100 submissions and flags the count as capped", async () => {
  const { api, requests } = loadContent({
    pages: Array.from({ length: 8 }, (_, i) => ({
      status: 200,
      payload: submissionPage(i * 20, 20, true),
    })),
  });
  const result = await api.fetchSubmissionCount("two-sum");

  assert(result.count === 100, `expected the 100 cap, got ${result.count}`);
  assert(result.capped === true, "capped flag not set when LeetCode had more pages");
  assert(requests.length === 5, `cap should stop at 5 requests, made ${requests.length}`);
  assert(result.countCap === 100 && result.pageCap === 5, "cap metadata not reported");
});

test("C5 duplicate submission ids across pages are counted once", async () => {
  const { api } = loadContent({
    pages: [
      { status: 200, payload: submissionPage(0, 20, true) },
      // LeetCode re-serving the same window (new submission shifts the offset).
      { status: 200, payload: submissionPage(0, 20, false) },
    ],
  });
  const result = await api.fetchSubmissionCount("two-sum");
  assert(result.count === 20, `duplicates not de-duplicated: got ${result.count}`);
});

test("C6 logged out (GraphQL auth error): signedIn false, no count", async () => {
  const { api } = loadContent({
    pages: [
      {
        status: 200,
        payload: {
          errors: [{ message: "You need to be authenticated to access this resource" }],
          data: { questionSubmissionList: null },
        },
      },
    ],
  });
  const result = await api.fetchSubmissionCount("two-sum");

  assert(result.success === false, "logged out must not succeed");
  assert(result.signedIn === false, "signedIn flag not set");
  assert(result.count === undefined, "a logged-out result must carry no count");
  assert(/Log in to LeetCode/i.test(result.error), `unhelpful message: ${result.error}`);
});

test("C7 logged out (HTTP 403): signedIn false, no count", async () => {
  const { api } = loadContent({ pages: [{ status: 403, payload: {} }] });
  const result = await api.fetchSubmissionCount("two-sum");
  assert(result.success === false && result.signedIn === false, "403 not treated as logged out");
  assert(result.count === undefined, "403 produced a count");
});

test("C8 schema drift fails closed - no count is guessed", async () => {
  const drifted = [
    { data: { questionSubmissionList: { submissions: [{ id: "1" }] } } }, // no hasNext
    { data: { questionSubmissionList: { hasNext: false } } }, // no submissions
    { data: { questionSubmissionList: null } }, // gone
    { data: {} }, // renamed
  ];
  for (const payload of drifted) {
    const { api } = loadContent({ pages: [{ status: 200, payload }] });
    const result = await api.fetchSubmissionCount("two-sum");
    assert(
      result.success === false,
      `drifted shape accepted: ${JSON.stringify(payload)}`,
    );
    assert(result.count === undefined, "a drifted response produced a count");
  }
});

test("C9 a mid-paging failure aborts - never returns a partial count", async () => {
  const { api } = loadContent({
    pages: [
      { status: 200, payload: submissionPage(0, 20, true) },
      { status: 500, payload: {} },
    ],
  });
  const result = await api.fetchSubmissionCount("two-sum");
  assert(result.success === false, "page 2 failure should abort the whole count");
  assert(result.count === undefined, "returned the partial first-page count");
  assert(/HTTP 500/.test(result.error), `error should name the status: ${result.error}`);
});

test("C10 network error is reported, not swallowed", async () => {
  const { api } = loadContent({ pages: [{ throws: "Failed to fetch" }] });
  const result = await api.fetchSubmissionCount("two-sum");
  assert(result.success === false, "network error should fail");
  assert(result.count === undefined, "network error produced a count");
  assert(/Could not reach LeetCode/.test(result.error), `bad message: ${result.error}`);
});

test("C11 non-JSON response (LeetCode error page) is reported, not parsed", async () => {
  const { api } = loadContent({ pages: [{ status: 200, badJson: true, payload: null }] });
  const result = await api.fetchSubmissionCount("two-sum");
  assert(result.success === false && result.count === undefined, "HTML page produced a count");
});

test("C12 leetcode.cn is excluded outright - no request is made", async () => {
  const { api, requests } = loadContent({
    hostname: "leetcode.cn",
    pages: [{ status: 200, payload: submissionPage(0, 5, false) }],
  });
  const result = await api.fetchSubmissionCount("two-sum");

  assert(result.success === false, ".cn should not sync");
  assert(result.unsupportedHost === true, "unsupportedHost flag not set");
  assert(requests.length === 0, "made a request on leetcode.cn");
  assert(api.isSubmissionSyncHost() === false, "isSubmissionSyncHost true on .cn");
});

test("C13 slug falls back to the page URL when the popup sends none", async () => {
  const { api, requests } = loadContent({
    pathname: "/problems/median-of-two-sorted-arrays/submissions/",
    pages: [{ status: 200, payload: submissionPage(0, 2, false) }],
  });
  const result = await api.fetchSubmissionCount(undefined);

  assert(result.success === true, "fallback slug failed");
  assert(
    requests[0].variables.questionSlug === "median-of-two-sorted-arrays",
    `wrong slug: ${requests[0].variables.questionSlug}`,
  );
  assert(
    api.problemSlugFromPath("/problems/two-sum/") === "two-sum",
    "problemSlugFromPath broken",
  );
  assert(api.problemSlugFromPath("/contest/weekly") === null, "non-problem path matched");
});

test("C14 missing csrf cookie still sends the request (header is empty, not undefined)", async () => {
  const { api, requests } = loadContent({
    cookie: "",
    pages: [{ status: 200, payload: submissionPage(0, 1, false) }],
  });
  const result = await api.fetchSubmissionCount("two-sum");
  assert(result.success === true, "empty csrf cookie broke the request");
  assert(requests[0].init.headers["x-csrftoken"] === "", "csrf header should be an empty string");
});

// --- run ---------------------------------------------------------------------

(async () => {
  console.log("issue #5 - Submissions sync, builder harness\n");
  for (const [name, fn] of tests) {
    try {
      await fn();
      passed += 1;
      console.log(`  PASS  ${name}`);
    } catch (error) {
      failures.push(`${name}: ${error.message}`);
      console.log(`  FAIL  ${name}\n        ${error.message}`);
    }
  }

  console.log(`\n${passed}/${tests.length} PASS`);
  if (failures.length > 0) {
    console.log(`\n${failures.length} FAILURE(S):`);
    failures.forEach((f) => console.log(`  - ${f}`));
    process.exit(1);
  }
})();
