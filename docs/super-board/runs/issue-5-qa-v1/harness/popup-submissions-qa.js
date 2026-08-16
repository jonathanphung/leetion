/**
 * QA harness for issue #5 — Submissions sync (popup layer + cross-file flow).
 *
 * The builder's harness (docs/super-board/runs/issue-5-build/harness/) exercises
 * background.js and content.js. It does NOT load popup.js, so the whole popup
 * layer — the sync action, the read-only rendering, the provenance note, and
 * the "Attempts is untouched" guarantee at the UI level — was unverified.
 *
 * This harness loads the REAL popup.js against a minimal fake DOM, and for the
 * end-to-end case wires popup.js -> content.js -> background.js so a single
 * click travels the actual production path across all three files.
 *
 * Usage (from the repo root):
 *   node docs/super-board/runs/issue-5-qa-v1/harness/popup-submissions-qa.js
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const repoRoot = path.resolve(__dirname, "../../../../..");
const read = (f) => fs.readFileSync(path.join(repoRoot, f), "utf8");

const popupSrc = read("popup.js");
const popupHtml = read("popup.html");
const contentSrc = read("content.js");
const backgroundSrc = read("background.js");

// --- assertion runner --------------------------------------------------------

const noop = () => {};
const tests = [];
let passed = 0;
const failures = [];

function test(name, fn) {
  tests.push([name, fn]);
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg}\n        got:      ${JSON.stringify(actual)}\n        wanted:   ${JSON.stringify(expected)}`);
  }
}
function assertDeep(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    throw new Error(`${msg}\n        got:      ${a}\n        wanted:   ${b}`);
  }
}

// --- minimal fake DOM --------------------------------------------------------

class FakeEl {
  constructor(id = "", tagName = "div") {
    this.id = id;
    this.tagName = tagName.toUpperCase();
    this._classes = new Set();
    this.textContent = "";
    this.innerHTML = "";
    this.value = "";
    this.disabled = false;
    this.checked = false;
    this.title = "";
    this.style = {};
    this.dataset = {};
    this.children = [];
    this.listeners = {};
    const self = this;
    this.classList = {
      add: (...c) => c.forEach((x) => self._classes.add(x)),
      remove: (...c) => c.forEach((x) => self._classes.delete(x)),
      contains: (c) => self._classes.has(c),
      toggle: (c, force) => {
        const on = force === undefined ? !self._classes.has(c) : !!force;
        if (on) self._classes.add(c);
        else self._classes.delete(c);
        return on;
      },
    };
  }
  get className() {
    return [...this._classes].join(" ");
  }
  addEventListener(type, fn) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  }
  removeEventListener() {}
  /** Fires the handlers the production code registered. */
  async fire(type, event = {}) {
    for (const fn of this.listeners[type] || []) await fn(event);
  }
  appendChild(child) {
    this.children.push(child);
    return child;
  }
  insertBefore(child) {
    this.children.push(child);
    return child;
  }
  remove() {}
  focus() {}
  blur() {}
  select() {}
  scrollIntoView() {}
  setAttribute(k, v) {
    this[k] = v;
  }
  getAttribute(k) {
    return this[k];
  }
  closest() {
    return null;
  }
  querySelector() {
    return new FakeEl();
  }
  querySelectorAll() {
    return [];
  }
}

/**
 * Initial class list per element id, read out of the real popup.html, so a
 * fake element starts in the same state the shipped markup gives it (the
 * `hidden` class on collapsed cards is load-bearing for these assertions).
 */
const INITIAL_CLASSES = (() => {
  const map = new Map();
  for (const tag of popupHtml.match(/<[a-zA-Z][^>]*\bid="[^"]+"[^>]*>/g) || []) {
    const id = /\bid="([^"]+)"/.exec(tag)[1];
    const cls = /\bclass="([^"]*)"/.exec(tag);
    map.set(id, cls ? cls[1].split(/\s+/).filter(Boolean) : []);
  }
  return map;
})();

function makeDocument() {
  const byId = new Map();
  const bySelector = new Map();
  return {
    body: new FakeEl("body", "body"),
    head: new FakeEl("head", "head"),
    title: "",
    cookie: "",
    getElementById(id) {
      if (!byId.has(id)) {
        const node = new FakeEl(id);
        (INITIAL_CLASSES.get(id) || []).forEach((c) => node.classList.add(c));
        byId.set(id, node);
      }
      return byId.get(id);
    },
    querySelector(sel) {
      if (!bySelector.has(sel)) bySelector.set(sel, new FakeEl(sel));
      return bySelector.get(sel);
    },
    querySelectorAll() {
      return [];
    },
    createElement(tag) {
      return new FakeEl("", tag);
    },
    addEventListener: noop,
    removeEventListener: noop,
  };
}

// --- chrome stub -------------------------------------------------------------

/**
 * @param {Object} o
 *   tabUrl       - URL reported by chrome.tabs.query
 *   scraped      - object chrome.scripting.executeScript resolves with
 *   syncStorage  - initial chrome.storage.sync contents
 *   localStorage - initial chrome.storage.local contents
 *   onTabMessage - (msg) => response | throws  (the content-script double)
 *   onRuntime    - (msg) => response          (the background double)
 */
function makeChrome(o = {}) {
  const sync = { ...(o.syncStorage || {}) };
  const local = { ...(o.localStorage || {}) };
  const tabMessages = [];
  const runtimeMessages = [];

  const pick = (store, keys) => {
    if (keys === null || keys === undefined) return { ...store };
    const list = Array.isArray(keys) ? keys : [keys];
    const out = {};
    list.forEach((k) => {
      if (k in store) out[k] = store[k];
    });
    return out;
  };

  return {
    tabMessages,
    runtimeMessages,
    syncStore: sync,
    localStore: local,
    api: {
      runtime: {
        onMessage: { addListener: noop },
        getURL: (p) => p,
        lastError: null,
        sendMessage: async (msg) => {
          runtimeMessages.push(msg);
          return o.onRuntime ? await o.onRuntime(msg) : { success: true };
        },
      },
      tabs: {
        query: async () => [{ id: 7, url: o.tabUrl || "https://leetcode.com/problems/two-sum/" }],
        sendMessage: async (tabId, msg) => {
          tabMessages.push({ tabId, msg });
          if (!o.onTabMessage) return { success: false };
          return await o.onTabMessage(msg);
        },
        create: noop,
      },
      scripting: {
        executeScript: async () => [{ result: o.scraped === undefined ? null : o.scraped }],
      },
      storage: {
        sync: {
          get: async (k) => pick(sync, k),
          set: async (obj) => Object.assign(sync, obj),
          remove: async (keys) => (Array.isArray(keys) ? keys : [keys]).forEach((k) => delete sync[k]),
        },
        local: {
          get: async (k) => pick(local, k),
          set: async (obj) => Object.assign(local, obj),
          remove: async (keys) => (Array.isArray(keys) ? keys : [keys]).forEach((k) => delete local[k]),
        },
      },
      alarms: { create: noop, onAlarm: { addListener: noop } },
      notifications: { create: noop, onClicked: { addListener: noop } },
      action: { setBadgeText: noop, setBadgeBackgroundColor: noop },
    },
  };
}

// --- popup.js sandbox --------------------------------------------------------

const POPUP_EPILOGUE = `
; return {
  DOM,
  checkCurrentTab, syncSubmissions, showSubmissionsControl, updateSubmissionDisplay,
  loadSubmissionSync, problemSlugFromUrl, setupEventListeners, saveToNotion,
  addManualAttempt, checkExistingEntry, updateAttemptDisplay,
  get existingPageId() { return existingPageId; },
  set existingPageId(v) { existingPageId = v; },
  get submissionSyncSupported() { return submissionSyncSupported; },
  set submissionSyncSupported(v) { submissionSyncSupported = v; },
  get currentTabId() { return currentTabId; },
  set currentTabId(v) { currentTabId = v; },
  get currentProblemSlug() { return currentProblemSlug; },
  set currentProblemSlug(v) { currentProblemSlug = v; },
  get submissionState() { return submissionState; },
  get problemData() { return problemData; },
  set problemData(v) { problemData = v; },
  get pendingAttempts() { return pendingAttempts; },
  set pendingAttempts(v) { pendingAttempts = v; },
  get userAttemptCount() { return userAttemptCount; },
  set userAttemptCount(v) { userAttemptCount = v; },
  get attemptSessionIncremented() { return attemptSessionIncremented; },
};`;

const popupFactory = new Function(
  "chrome",
  "document",
  "window",
  "requestAnimationFrame",
  "confirm",
  "console",
  `${popupSrc}\n${POPUP_EPILOGUE}`,
);

/** Console double that records errors so "no console errors" is assertable. */
function makeConsole() {
  const errors = [];
  const warns = [];
  return {
    errors,
    warns,
    api: { log: noop, warn: (...a) => warns.push(a.join(" ")), error: (...a) => errors.push(a.map(String).join(" ")) },
  };
}

function loadPopup(o = {}) {
  const doc = makeDocument();
  const chrome = makeChrome(o);
  const con = makeConsole();
  const win = { close: noop, addEventListener: noop, location: { href: "" } };
  const api = popupFactory(
    chrome.api,
    doc,
    win,
    (cb) => setTimeout(cb, 0),
    () => (o.confirmResult === undefined ? false : o.confirmResult),
    con.api,
  );
  return { api, doc, chrome, con };
}

// --- content.js sandbox (for the cross-file test) ----------------------------

function contentListener(o = {}) {
  const open = contentSrc.indexOf("(function () {");
  const close = contentSrc.lastIndexOf("})();");
  assert(open >= 0 && close >= 0, "content.js IIFE wrapper not found");
  const body = contentSrc.slice(open + "(function () {".length, close);

  let listener = null;
  const chromeStub = { runtime: { onMessage: { addListener: (fn) => (listener = fn) } } };
  const hostname = o.hostname || "leetcode.com";
  const win = {
    leetionContentLoaded: undefined,
    location: {
      hostname,
      origin: `https://${hostname}`,
      pathname: o.pathname || "/problems/two-sum/description/",
      href: `https://${hostname}${o.pathname || "/problems/two-sum/"}`,
    },
    addEventListener: noop,
    devicePixelRatio: 1,
  };
  const doc = {
    cookie: "csrftoken=csrf-qa",
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({ style: {}, appendChild: noop, setAttribute: noop }),
    addEventListener: noop,
    body: { innerText: "", appendChild: noop },
    head: { appendChild: noop },
  };

  const requests = [];
  let callIndex = 0;
  async function fetchStub(url, init) {
    const parsed = JSON.parse(init.body);
    requests.push({ url, offset: parsed.variables.offset });
    let spec = (o.pages || [])[callIndex];
    callIndex += 1;
    if (typeof spec === "function") spec = spec(parsed.variables.offset);
    if (spec === undefined) spec = { status: 200, payload: { data: { questionSubmissionList: { hasNext: false, submissions: [] } } } };
    return {
      ok: spec.status >= 200 && spec.status < 300,
      status: spec.status,
      json: async () => spec.payload,
    };
  }

  new Function("chrome", "window", "document", "fetch", "console", body)(
    chromeStub,
    win,
    doc,
    fetchStub,
    { log: noop, warn: noop, error: noop },
  );
  assert(typeof listener === "function", "content.js registered no message listener");

  /** Promise-shaped chrome.tabs.sendMessage double backed by the real listener. */
  const send = (msg) =>
    new Promise((resolve, reject) => {
      let settled = false;
      const kept = listener(msg, {}, (response) => {
        settled = true;
        resolve(response);
      });
      if (!kept && !settled) reject(new Error("listener closed the port"));
    });

  return { send, requests };
}

// --- background.js sandbox (for the cross-file test) -------------------------

function backgroundHandler(o = {}) {
  const calls = [];
  const chromeStub = {
    runtime: { onMessage: { addListener: noop }, onStartup: { addListener: noop }, onInstalled: { addListener: noop }, getURL: (p) => p, lastError: null },
    alarms: { create: noop, onAlarm: { addListener: noop } },
    storage: { sync: { get: async () => ({}) } },
    tabs: { create: noop, onUpdated: { addListener: noop }, query: async () => [] },
    notifications: { create: noop, onClicked: { addListener: noop } },
    action: { setBadgeText: noop, setBadgeBackgroundColor: noop },
  };
  async function fetchStub(url, init) {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, method: init.method, body });
    const json = (status, payload) => ({
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      json: async () => payload,
    });
    if (init.method === "GET" && /\/databases\//.test(url)) {
      return json(200, { id: "db", properties: o.dbProperties || {} });
    }
    if (init.method === "PATCH" && /\/pages\//.test(url)) return json(200, { id: "page" });
    return json(200, {});
  }
  const api = new Function("chrome", "fetch", `${backgroundSrc}\n; return { handleMessage };`)(chromeStub, fetchStub);
  /** Mirrors the real onMessage wrapper (resolve -> result, throw -> {success:false}). */
  const send = async (msg) => {
    try {
      return await api.handleMessage(msg);
    } catch (error) {
      return { success: false, error: error.message };
    }
  };
  return { send, calls };
}

const NUMBER_COL = { type: "number", number: {} };
function notionDbWithSubmissions() {
  return {
    Question: { type: "title" },
    "S No.": NUMBER_COL,
    Level: { type: "select" },
    Tag: { type: "multi_select" },
    "My Expertise": { type: "select" },
    Done: { type: "checkbox" },
    "Date (of first attempt)": { type: "date" },
    "Question Link": { type: "url" },
    "Spaced Repetition": { type: "date" },
    "Time Complexity": { type: "select" },
    "Space Complexity": { type: "select" },
    Attempts: NUMBER_COL,
    Submissions: NUMBER_COL,
  };
}

function submissionPage(offset, n, hasNext) {
  return {
    status: 200,
    payload: {
      data: {
        questionSubmissionList: {
          hasNext,
          submissions: Array.from({ length: n }, (_, i) => ({
            id: String(offset + i),
            statusDisplay: i % 4 === 0 ? "Accepted" : "Wrong Answer",
          })),
        },
      },
    },
  };
}

/** Puts a popup into "problem already exists in Notion, sync is available". */
function readyPopup(o = {}) {
  const ctx = loadPopup({
    syncStorage: { notionApiKey: "secret_qa", notionDatabaseId: "db-qa" },
    ...o,
  });
  ctx.api.problemData = { ...ctx.api.problemData, number: 1, title: "Two Sum" };
  ctx.api.existingPageId = "page-qa";
  ctx.api.currentTabId = 7;
  ctx.api.currentProblemSlug = "two-sum";
  ctx.api.submissionSyncSupported = true;
  return ctx;
}

const el = (ctx, id) => ctx.doc.getElementById(id);
const submissionWrites = (chrome) => chrome.runtimeMessages.filter((m) => m.action === "updateSubmissions");
const leetcodeFetches = (chrome) => chrome.tabMessages.filter((m) => m.msg.action === "getSubmissionCount");

// ============================================================================
// AC6 — Submissions is presented as a synced value, not an editable one
// ============================================================================

test("Q1 popup markup: Submissions renders as <output>, with no input or editable affordance", () => {
  const block = /<article[^>]*id="card-submissions"[\s\S]*?<\/article>/.exec(popupHtml);
  assert(block, 'popup.html has no <article id="card-submissions">');
  const html = block[0];
  assert(/<output[^>]*id="submissions-value"/.test(html), "the value is not an <output> element");
  assert(!/<input/i.test(html), "the Submissions card contains an <input> — it must not be hand-editable");
  assert(!/contenteditable/i.test(html), "the Submissions card is contenteditable");
  assert(!/<textarea/i.test(html), "the Submissions card contains a <textarea>");
  assert(/id="btn-sync-submissions"/.test(html), "no sync button in the Submissions card");
  assert(/id="submissions-note"/.test(html), "no provenance note element in the Submissions card");
  assert(/\bhidden\b/.test(/<article[^>]*id="card-submissions"[^>]*>/.exec(html)[0]), "the card does not start hidden");
});

test("Q2 the Attempts control is still the only editable counter in the popup", () => {
  assert(/id="input-attempts"/.test(popupHtml), "the Attempts input disappeared");
  assert(/id="btn-attempt-plus"/.test(popupHtml), "the Attempts + control disappeared");
});

// ============================================================================
// AC3 — explicit "Sync submissions" action, fetch runs in the content script
// ============================================================================

test("Q3 clicking Sync submissions asks the content script for the count for this slug", async () => {
  const ctx = readyPopup({
    onTabMessage: async () => ({ success: true, signedIn: true, count: 12, capped: false }),
    onRuntime: async () => ({ success: true, count: 12 }),
  });
  ctx.api.setupEventListeners();
  await el(ctx, "btn-sync-submissions").fire("click");

  const fetches = leetcodeFetches(ctx.chrome);
  assertEqual(fetches.length, 1, "expected exactly one content-script request");
  assertEqual(fetches[0].tabId, 7, "request did not go to the current LeetCode tab");
  assertDeep(fetches[0].msg, { action: "getSubmissionCount", slug: "two-sum" }, "wrong message shape");
});

test("Q4 the slug comes from the tab URL, and .cn tabs never enable sync", async () => {
  const com = loadPopup({ tabUrl: "https://leetcode.com/problems/valid-anagram/description/", scraped: null });
  await com.api.checkCurrentTab();
  assertEqual(com.api.currentProblemSlug, "valid-anagram", "slug not derived from the .com tab URL");
  assertEqual(com.api.submissionSyncSupported, true, "sync should be supported on leetcode.com");

  const cn = loadPopup({ tabUrl: "https://leetcode.cn/problems/valid-anagram/", scraped: null });
  await cn.api.checkCurrentTab();
  assertEqual(cn.api.submissionSyncSupported, false, "sync must be excluded on leetcode.cn");
  cn.api.existingPageId = "page-cn";
  cn.api.showSubmissionsControl(9);
  assert(
    cn.doc.getElementById("card-submissions").classList.contains("hidden"),
    "the Submissions card was revealed on leetcode.cn",
  );
});

// ============================================================================
// AC4 — count is shown before it is written; save never triggers a fetch
// ============================================================================

test("Q5 the fetched number is on screen before the Notion write is issued", async () => {
  let valueAtWriteTime = null;
  let noteAtWriteTime = null;
  const ctx = readyPopup({
    onTabMessage: async () => ({ success: true, signedIn: true, count: 42, capped: false }),
    onRuntime: async (msg) => {
      if (msg.action === "updateSubmissions") {
        valueAtWriteTime = ctxRef.doc.getElementById("submissions-value").textContent;
        noteAtWriteTime = ctxRef.doc.getElementById("submissions-note").textContent;
      }
      return { success: true, count: msg.data.count };
    },
  });
  const ctxRef = ctx;
  await ctx.api.syncSubmissions();

  assertEqual(valueAtWriteTime, "42", "the count was not rendered before the Notion write");
  assert(/saving to Notion/i.test(noteAtWriteTime || ""), `note did not announce the pending write (was "${noteAtWriteTime}")`);
  assertEqual(el(ctx, "submissions-value").textContent, "42", "final rendered value is wrong");
  assertEqual(el(ctx, "submissions-note").textContent, "Synced just now", "final note is wrong");
});

test("Q6 Save / Update in Notion never triggers a LeetCode fetch", async () => {
  const ctx = readyPopup({
    onTabMessage: async () => ({ success: true, signedIn: true, count: 5 }),
    onRuntime: async (msg) => {
      if (msg.action === "checkExisting") return { exists: true, pageId: "page-qa", attempts: 3 };
      return { success: true, pageId: "page-qa" };
    },
  });
  ctx.api.problemData = { ...ctx.api.problemData, number: 1, title: "Two Sum", url: "https://leetcode.com/problems/two-sum/" };
  await ctx.api.saveToNotion();

  assertEqual(leetcodeFetches(ctx.chrome).length, 0, "a save reached out to LeetCode");
  assertEqual(submissionWrites(ctx.chrome).length, 0, "a save wrote the Submissions property");
});

// ============================================================================
// AC5 — Attempts is provably untouched by the sync path
// ============================================================================

test("Q7 a full sync leaves every Attempts-related value and control alone", async () => {
  const ctx = readyPopup({
    onTabMessage: async () => ({ success: true, signedIn: true, count: 42, capped: false }),
    onRuntime: async (msg) => ({ success: true, count: msg.data.count }),
  });
  ctx.api.userAttemptCount = 3;
  ctx.api.updateAttemptDisplay();
  const attemptsField = el(ctx, "input-attempts");
  const before = {
    userAttemptCount: ctx.api.userAttemptCount,
    pendingAttempts: ctx.api.pendingAttempts,
    sessionIncremented: ctx.api.attemptSessionIncremented,
    fieldValue: attemptsField.value,
    fieldStaged: attemptsField.classList.contains("is-staged"),
  };

  await ctx.api.syncSubmissions();

  assertEqual(ctx.api.userAttemptCount, before.userAttemptCount, "sync changed userAttemptCount");
  assertEqual(ctx.api.pendingAttempts, before.pendingAttempts, "sync changed the staged Attempts edit");
  assertEqual(ctx.api.attemptSessionIncremented, before.sessionIncremented, "sync changed attemptSessionIncremented");
  assertEqual(attemptsField.value, before.fieldValue, "sync changed the Attempts field value");
  assertEqual(attemptsField.classList.contains("is-staged"), before.fieldStaged, "sync changed the Attempts staged flag");

  // No message emitted by the sync path may carry an attempts payload.
  ctx.chrome.runtimeMessages.forEach((m) => {
    assert(!("attempts" in (m.data || {})), `message ${m.action} carried an attempts field`);
  });

  // And the manual + control still behaves exactly as #1 left it after a sync.
  ctx.api.addManualAttempt();
  assertEqual(ctx.api.pendingAttempts, 4, "the manual +1 control stopped staging after a sync");
  assertEqual(attemptsField.value, "4", "the Attempts field did not reflect the staged +1 after a sync");
  assert(attemptsField.classList.contains("is-staged"), "the staged marker is missing after a sync");
});

// ============================================================================
// AC6 — staleness is legible (provenance note)
// ============================================================================

test("Q8 provenance note distinguishes never-synced / from-Notion / synced-here / stale", async () => {
  // never synced
  const a = readyPopup();
  a.api.showSubmissionsControl(null);
  assertEqual(el(a, "submissions-value").textContent, "--", "unsynced value should render --");
  assertEqual(el(a, "submissions-note").textContent, "Not synced yet", "wrong unsynced note");
  assert(!el(a, "card-submissions").classList.contains("hidden"), "card stayed hidden for an existing entry");

  // value carried over from Notion, never synced by this browser
  const b = readyPopup();
  b.api.showSubmissionsControl(17);
  assertEqual(el(b, "submissions-value").textContent, "17", "Notion value not rendered");
  assertEqual(
    el(b, "submissions-note").textContent,
    "Value stored in Notion · sync to refresh",
    "a number carried from Notion must not read as freshly synced",
  );

  // synced by this browser two days ago
  const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000;
  const c = readyPopup({ localStorage: { submissions_sync_1: { count: 17, capped: false, syncedAt: twoDaysAgo } } });
  await c.api.loadSubmissionSync(1);
  c.api.showSubmissionsControl(17);
  assertEqual(el(c, "submissions-note").textContent, "Synced 2d ago", "stale local sync is not dated");

  // a local record that no longer matches Notion must not date the Notion number
  const d = readyPopup({ localStorage: { submissions_sync_1: { count: 17, capped: false, syncedAt: twoDaysAgo } } });
  await d.api.loadSubmissionSync(1);
  d.api.showSubmissionsControl(31);
  assertEqual(el(d, "submissions-value").textContent, "31", "Notion value should win when the local record disagrees");
  assertEqual(
    el(d, "submissions-note").textContent,
    "Value stored in Notion · sync to refresh",
    "a stale local timestamp was reused to date a number it did not produce",
  );
});

// ============================================================================
// AC7 — paging cap is visible and never presented as exact
// ============================================================================

test("Q9 a capped count renders 100+, says the real total is higher, and writes 100", async () => {
  const ctx = readyPopup({
    onTabMessage: async () => ({ success: true, signedIn: true, count: 100, capped: true, pagesFetched: 5, countCap: 100 }),
    onRuntime: async (msg) => ({ success: true, count: msg.data.count }),
  });
  await ctx.api.syncSubmissions();

  assertEqual(el(ctx, "submissions-value").textContent, "100+", "capped count not marked as a floor");
  const note = el(ctx, "submissions-note").textContent;
  assert(/cap/i.test(note) && /higher/i.test(note), `capped note does not say the total is higher: "${note}"`);

  const writes = submissionWrites(ctx.chrome);
  assertEqual(writes.length, 1, "expected one Notion write");
  assertEqual(writes[0].data.count, 100, "the capped number written to Notion is wrong");
});

// ============================================================================
// AC8 — logged out degrades gracefully
// ============================================================================

test("Q10 logged out: hint shown, action disabled, nothing written, no console errors", async () => {
  const ctx = readyPopup({
    onTabMessage: async () => ({ success: false, signedIn: false, error: "Log in to LeetCode to sync submissions." }),
    onRuntime: async () => ({ success: true }),
  });
  ctx.api.showSubmissionsControl(null);
  ctx.api.setupEventListeners();
  await el(ctx, "btn-sync-submissions").fire("click");

  const btn = el(ctx, "btn-sync-submissions");
  assertEqual(btn.disabled, true, "the sync action stayed enabled while logged out");
  assertEqual(el(ctx, "submissions-note").textContent, "Log in to LeetCode to sync submissions.", "no log-in hint");
  assert(el(ctx, "submissions-note").classList.contains("is-error"), "the hint is not flagged as an error state");
  assertEqual(submissionWrites(ctx.chrome).length, 0, "a logged-out sync wrote to Notion");
  assertEqual(ctx.con.errors.length, 0, `console errors while logged out: ${ctx.con.errors.join(" | ")}`);
  // The rest of the popup keeps working.
  ctx.api.addManualAttempt();
  assertEqual(ctx.api.pendingAttempts, 1, "the popup stopped working after a logged-out sync");
});

// ============================================================================
// AC9 — a failure never writes 0 / null / a partial count
// ============================================================================

test("Q11 every fetch-side failure aborts before the Notion write and keeps the old number", async () => {
  const cases = [
    ["schema drift", { success: false, schemaDrift: true, error: "LeetCode's submission API returned an unexpected shape - nothing was written." }],
    ["network error", { success: false, error: "Could not reach LeetCode: network error" }],
    ["HTTP 500", { success: false, error: "LeetCode returned HTTP 500." }],
    ["mid-paging failure", { success: false, error: "Could not reach LeetCode: socket hang up" }],
  ];
  for (const [label, response] of cases) {
    const ctx = readyPopup({ onTabMessage: async () => response, onRuntime: async () => ({ success: true }) });
    ctx.api.showSubmissionsControl(17); // an existing, good value
    await ctx.api.syncSubmissions();

    assertEqual(submissionWrites(ctx.chrome).length, 0, `${label}: Notion was written anyway`);
    assertEqual(el(ctx, "submissions-value").textContent, "17", `${label}: the displayed value was clobbered`);
    assertEqual(ctx.api.submissionState.count, 17, `${label}: state was clobbered`);
    assert(el(ctx, "submissions-note").classList.contains("is-error"), `${label}: no visible error status`);
    assert(el(ctx, "submissions-note").textContent.length > 0, `${label}: the error status is empty`);
  }
});

test("Q12 a missing content script is reported as a reload hint, not a crash", async () => {
  const ctx = readyPopup({
    onTabMessage: async () => {
      throw new Error("Could not establish connection. Receiving end does not exist.");
    },
    onRuntime: async () => ({ success: true }),
  });
  ctx.api.showSubmissionsControl(null);
  await ctx.api.syncSubmissions();
  assertEqual(submissionWrites(ctx.chrome).length, 0, "a dead content script still produced a Notion write");
  assert(/reload/i.test(el(ctx, "submissions-note").textContent), "no actionable hint for a missing content script");
  assertEqual(el(ctx, "btn-sync-submissions").disabled, false, "the action stayed disabled after a recoverable error");
});

test("Q13 a Notion-side failure keeps the number unstored and unpersisted", async () => {
  const ctx = readyPopup({
    onTabMessage: async () => ({ success: true, signedIn: true, count: 42, capped: false }),
    onRuntime: async () => ({
      success: false,
      missingColumn: true,
      error: 'Your database has no "Submissions" column yet. Press "Update in Notion" once and confirm the column list, then sync again.',
    }),
  });
  await ctx.api.syncSubmissions();

  assert(/Submissions" column yet/.test(el(ctx, "submissions-note").textContent), "the missing-column guidance is not surfaced");
  assert(el(ctx, "submissions-note").classList.contains("is-error"), "the failure is not flagged as an error");
  assertEqual(ctx.api.submissionState.syncedAt, null, "a failed write was recorded as a successful sync");
  assertEqual(ctx.chrome.localStore.submissions_sync_1, undefined, "a failed write was persisted to local storage");
});

test("Q14 sync is refused before Notion is connected", async () => {
  const ctx = readyPopup({
    syncStorage: {},
    onTabMessage: async () => ({ success: true, signedIn: true, count: 9, capped: false }),
    onRuntime: async () => ({ success: true }),
  });
  await ctx.api.syncSubmissions();
  assertEqual(submissionWrites(ctx.chrome).length, 0, "wrote to Notion without credentials");
  assert(/settings/i.test(el(ctx, "submissions-note").textContent), "no guidance to connect Notion");
});

// ============================================================================
// Cross-file: popup.js -> content.js -> background.js on the real code path
// ============================================================================

test("Q15 end-to-end: one click pages LeetCode, counts, and PATCHes Submissions only", async () => {
  const content = contentListener({
    pages: [submissionPage(0, 20, true), submissionPage(20, 20, true), submissionPage(40, 1, false)],
  });
  const background = backgroundHandler({ dbProperties: notionDbWithSubmissions() });

  const ctx = readyPopup({
    onTabMessage: (msg) => content.send(msg),
    onRuntime: (msg) => background.send(msg),
  });
  ctx.api.setupEventListeners();
  await el(ctx, "btn-sync-submissions").fire("click");

  assertDeep(content.requests.map((r) => r.offset), [0, 20, 40], "paging offsets are wrong");
  assertEqual(el(ctx, "submissions-value").textContent, "41", "the counted total is wrong");
  assertEqual(el(ctx, "submissions-note").textContent, "Synced just now", "the sync was not recorded as fresh");

  const patches = background.calls.filter((c) => c.method === "PATCH" && /\/pages\//.test(c.url));
  assertEqual(patches.length, 1, "expected exactly one Notion page write");
  assertDeep(patches[0].body, { properties: { Submissions: { number: 41 } } }, "the PATCH body is not Submissions-only");
  assertEqual(ctx.con.errors.length, 0, `console errors on the happy path: ${ctx.con.errors.join(" | ")}`);
  assertDeep(
    ctx.chrome.localStore.submissions_sync_1,
    { count: 41, capped: false, syncedAt: ctx.api.submissionState.syncedAt },
    "the sync record was not persisted for the staleness note",
  );
});

test("Q16 end-to-end on leetcode.cn: the content script refuses and nothing is written", async () => {
  const content = contentListener({ hostname: "leetcode.cn" });
  const background = backgroundHandler({ dbProperties: notionDbWithSubmissions() });
  const ctx = readyPopup({ onTabMessage: (msg) => content.send(msg), onRuntime: (msg) => background.send(msg) });

  await ctx.api.syncSubmissions();
  assertEqual(content.requests.length, 0, "a GraphQL request was made on leetcode.cn");
  assertEqual(background.calls.filter((c) => c.method === "PATCH").length, 0, "leetcode.cn produced a Notion write");
  assert(/only available on leetcode\.com/i.test(el(ctx, "submissions-note").textContent), "no clear .cn exclusion message");
});

// ============================================================================
// AC1 / AC2 / AC10 — schema, README, manifest invariants (re-verified here)
// ============================================================================

test("Q17 README schema table and DATABASE_SCHEMA agree, both carrying Submissions", () => {
  const background = backgroundHandler();
  const schema = new Function("chrome", "fetch", `${backgroundSrc}\n; return DATABASE_SCHEMA;`)(
    { runtime: { onMessage: { addListener: noop }, onStartup: { addListener: noop }, onInstalled: { addListener: noop }, getURL: (p) => p }, alarms: { create: noop, onAlarm: { addListener: noop } }, storage: { sync: { get: async () => ({}) } }, tabs: { create: noop, onUpdated: { addListener: noop }, query: async () => [] }, notifications: { create: noop, onClicked: { addListener: noop } }, action: { setBadgeText: noop, setBadgeBackgroundColor: noop } },
    async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({}) }),
  );
  assert(background, "background failed to load");
  assertDeep(schema.Submissions, { type: "number", number: { format: "number" } }, "Submissions schema entry is wrong");

  const table = /These are the exact column names and types Leetion uses:\s*\n+((?:\|.*\n)+)/.exec(read("README.md"));
  assert(table, "README schema table not found");
  const rows = [...table[1].matchAll(/^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/gm)]
    // Drop the header row ("Property | Type") and the |---|---| separator.
    .filter(([, name, type]) => !/^-+$/.test(name) && !(name === "Property" && type === "Type"))
    .map(([, name]) => name.trim())
    .filter(Boolean);
  const documented = new Set(rows);
  assert(documented.has("Submissions"), "README table has no Submissions row");
  Object.keys(schema).forEach((name) => assert(documented.has(name), `README table is missing "${name}"`));
  documented.forEach((name) => assert(name in schema, `README documents "${name}" which is not in DATABASE_SCHEMA`));
});

test("Q18 manifest.json is byte-identical to the base branch (no new permissions)", () => {
  const base = execFileSync("git", ["show", "main:manifest.json"], { cwd: repoRoot, encoding: "buffer" });
  const head = fs.readFileSync(path.join(repoRoot, "manifest.json"));
  assert(base.equals(head), "manifest.json differs from main — store re-review risk");
});

// ============================================================================

(async () => {
  for (const [name, fn] of tests) {
    try {
      await fn();
      passed += 1;
      console.log(`  PASS  ${name}`);
    } catch (error) {
      failures.push([name, error]);
      console.log(`  FAIL  ${name}\n        ${error.message}`);
    }
  }
  console.log(`\n${passed}/${tests.length} PASS`);
  if (failures.length) process.exitCode = 1;
})();
