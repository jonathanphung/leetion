/**
 * QA harness for issue #3 — per-expertise spaced-repetition intervals.
 *
 * Independent of the Builder's harness (which asserts the interval helpers and
 * background functions in isolation). This one drives the SHIPPED popup
 * entry points end to end:
 *
 *     popup.loadSettings/saveSettings/saveToNotion/revisitProblem/
 *     markForReviewTomorrow
 *         -> chrome.runtime.sendMessage
 *             -> background.handleMessage (the real router)
 *                 -> notionRequest -> fetch  (captured)
 *
 * so every assertion below is made against the actual Notion request body the
 * extension would send, not against an intermediate helper's return value.
 *
 * popup.js and background.js each get their own vm context (they both declare a
 * top-level `saveToNotion`, so one shared context would clobber it). Top-level
 * `let`/`const` in a vm script live in the context's global lexical environment,
 * so the harness reads/writes popup state (`selectedExpertise`, `problemData`,
 * `DOM`) with `vm.runInContext` rather than reaching through the global object.
 *
 * Run from the repo root:  node docs/super-board/runs/issue-3-qa-v1/qa-intervals.mjs
 * Exit code 0 = all assertions passed.
 */

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

let passed = 0;
const failures = [];
let currentAC = "";

function ac(name) {
  currentAC = name;
  console.log(`\n${name}`);
}

function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failures.push(
      `[${currentAC}] ${name}\n          expected ${e}\n          actual   ${a}`,
    );
    console.log(
      `  FAIL  ${name}\n          expected ${e}\n          actual   ${a}`,
    );
  }
}

/** today + n days, formatted the way the extension formats it. */
function dayOffset(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().split("T")[0];
}

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** chrome.storage area backed by a real object; supports promise + callback. */
function makeStorageArea(seed = {}) {
  const data = { ...seed };
  const pick = (keys) => {
    if (keys === null || keys === undefined) return { ...data };
    const list = Array.isArray(keys) ? keys : [keys];
    const out = {};
    list.forEach((k) => {
      if (k in data) out[k] = data[k];
    });
    return out;
  };
  return {
    _data: data,
    get(keys, cb) {
      const out = pick(keys);
      if (typeof cb === "function") return void cb(out);
      return Promise.resolve(out);
    },
    set(obj, cb) {
      Object.assign(data, JSON.parse(JSON.stringify(obj)));
      if (typeof cb === "function") return void cb();
      return Promise.resolve();
    },
    remove(keys, cb) {
      (Array.isArray(keys) ? keys : [keys]).forEach((k) => delete data[k]);
      if (typeof cb === "function") return void cb();
      return Promise.resolve();
    },
  };
}

function makeElement(id) {
  const el = {
    id,
    value: "",
    checked: false,
    disabled: false,
    textContent: "",
    innerHTML: "",
    dataset: {},
    classList: {
      _s: new Set(),
      add(...c) {
        c.forEach((x) => this._s.add(x));
      },
      remove(...c) {
        c.forEach((x) => this._s.delete(x));
      },
      toggle() {},
      contains(c) {
        return this._s.has(c);
      },
    },
    addEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    appendChild() {},
    focus() {},
  };
  return el;
}

/** Loads a source file into its own vm context. Returns {ctx, elements, ...}. */
function loadScript(file, opts = {}) {
  const { storage, sendMessage, fetchImpl, notifications } = opts;
  const elements = new Map();
  const getEl = (id) => {
    if (!elements.has(id)) elements.set(id, makeElement(id));
    return elements.get(id);
  };
  const expertiseButtons = ["Low", "Medium", "High"].map((level) => {
    const b = makeElement(`expertise-${level}`);
    b.dataset.expertise = level;
    return b;
  });

  const ctx = vm.createContext({
    console: { log() {}, error() {}, warn() {} },
    document: {
      getElementById: getEl,
      querySelector: (sel) => {
        const m = /^\[data-tag="(.+)"\]$/.exec(sel);
        if (m) return getEl(`tag-${m[1]}`);
        return null;
      },
      querySelectorAll: (sel) =>
        sel === ".expertise-btn" ? expertiseButtons : [],
      addEventListener() {},
      createElement: (t) => makeElement(`created-${t}`),
      body: makeElement("body"),
    },
    chrome: {
      runtime: {
        onMessage: { addListener() {} },
        onInstalled: { addListener() {} },
        onStartup: { addListener() {} },
        sendMessage: sendMessage || (async () => ({ success: true })),
        getURL: (p) => p,
        lastError: null,
      },
      storage,
      alarms: {
        create() {},
        onAlarm: { addListener() {} },
        get: async () => null,
      },
      notifications: {
        create: notifications || function () {},
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
    fetch: fetchImpl || (async () => ({ ok: true, json: async () => ({}) })),
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URL,
    TextEncoder,
  });

  vm.runInContext(fs.readFileSync(path.join(REPO_ROOT, file), "utf8"), ctx, {
    filename: file,
  });
  return { ctx, elements, getEl, expertiseButtons };
}

/**
 * Wires a popup context to a background context through the real message
 * router, with every Notion HTTP call captured.
 *
 * @param {Object} seedSync - initial chrome.storage.sync contents
 */
function makeExtension(seedSync = {}) {
  const sync = makeStorageArea(seedSync);
  const local = makeStorageArea({});
  const requests = [];
  const notifications = [];

  const fetchImpl = async (url, options) => {
    const endpoint = url.replace("https://api.notion.com/v1/", "");
    const method = options.method;
    const body = options.body ? JSON.parse(options.body) : null;
    requests.push({ endpoint, method, body });

    // Minimal Notion responses, keyed by endpoint shape.
    if (method === "GET" && /^databases\/[^/]+$/.test(endpoint)) {
      // Report a fully provisioned schema so ensureDatabaseSchema PATCHes nothing.
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({
          properties: Object.fromEntries(
            [
              "Question",
              "S No.",
              "Question Link",
              "Tag",
              "Level",
              "My Expertise",
              "Remark",
              "Alternative Method Tags",
              "Done",
              "Date (of first attempt)",
              "Time Complexity",
              "Space Complexity",
              "Attempts",
              "Spaced Repetition",
              "Notes",
              "Status",
            ].map((n) => [n, {}]),
          ),
        }),
      };
    }
    if (endpoint === "pages" && method === "POST") {
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ id: "page-created-001" }),
      };
    }
    if (/^databases\/[^/]+\/query$/.test(endpoint)) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ results: [] }),
      };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ id: "page-existing-001", results: [] }),
    };
  };

  const bg = loadScript("background.js", {
    storage: { sync, local },
    fetchImpl,
    notifications: (id, opts, cb) => {
      notifications.push({ id, ...opts });
      if (cb) cb(id);
    },
  });

  const messages = [];
  const popup = loadScript("popup.js", {
    storage: { sync, local },
    sendMessage: async (msg) => {
      messages.push(JSON.parse(JSON.stringify(msg)));
      if (msg.action === "checkExisting" && ext._existing) return ext._existing;
      return await bg.ctx.handleMessage(msg);
    },
  });

  const ext = {
    sync,
    local,
    requests,
    messages,
    notifications,
    bg,
    popup,
    _existing: null,
    /** Read/eval an expression inside the popup's lexical scope. */
    p: (expr) => vm.runInContext(expr, popup.ctx),
    /** Notion requests that carried a `properties` payload. */
    propertyWrites: () => requests.filter((r) => r.body && r.body.properties),
    lastProperties() {
      const w = this.propertyWrites();
      return w.length ? w[w.length - 1].body.properties : null;
    },
    reset() {
      requests.length = 0;
      messages.length = 0;
    },
  };
  return ext;
}

/** Seeds the popup with a scraped problem so saveToNotion() proceeds. */
function seedProblem(ext) {
  ext.p(`
    problemData.number = 1;
    problemData.title = "Two Sum";
    problemData.difficulty = "Easy";
    problemData.code = "class Solution: pass";
    problemData.language = "python";
    problemData.url = "https://leetcode.com/problems/two-sum/";
    problemData.questionContent = "Given an array of integers...";
  `);
}

const KEYS = { api: "notionApiKey", db: "notionDatabaseId" };
const CREDS = { [KEYS.api]: "secret_test", [KEYS.db]: "db_test" };

console.log("Issue #3 QA — per-expertise spaced-repetition intervals");
console.log("(end-to-end: popup entry point -> background router -> Notion request body)");

// ===========================================================================
ac("AC1 — settings view: three inputs, defaults 1/3/7, persist across reload");
// ===========================================================================
{
  const html = fs.readFileSync(path.join(REPO_ROOT, "popup.html"), "utf8");
  ["low", "medium", "high"].forEach((lvl, i) => {
    const re = new RegExp(
      `<input[^>]*id="input-interval-${lvl}"[^>]*>`,
      "s",
    );
    const tag = (html.match(re) || [""])[0];
    check(
      `popup.html has #input-interval-${lvl} (number, min 0, max 365, default ${[1, 3, 7][i]})`,
      {
        number: /type="number"/.test(tag),
        min: /min="0"/.test(tag),
        max: /max="365"/.test(tag),
        value: (tag.match(/value="(\d+)"/) || [])[1],
      },
      { number: true, min: true, max: true, value: String([1, 3, 7][i]) },
    );
  });
  check(
    "legacy single #input-spaced-rep input is gone from popup.html",
    html.includes('id="input-spaced-rep"'),
    false,
  );

  // Fresh profile -> defaults land in the inputs.
  const ext = makeExtension({ ...CREDS });
  await ext.popup.ctx.loadSettings();
  check(
    "fresh profile: loadSettings() fills inputs with 1 / 3 / 7",
    [
      ext.getInputs ? null : ext.p("DOM.settings.intervalInputs.Low.value"),
      ext.p("DOM.settings.intervalInputs.Medium.value"),
      ext.p("DOM.settings.intervalInputs.High.value"),
    ],
    [1, 3, 7],
  );

  // User edits the three fields and saves.
  ext.p(`
    DOM.settings.intervalInputs.Low.value = "2";
    DOM.settings.intervalInputs.Medium.value = "5";
    DOM.settings.intervalInputs.High.value = "9";
  `);
  await ext.popup.ctx.saveSettings();
  check(
    "saveSettings() writes spacedRepetitionIntervals to chrome.storage.sync",
    ext.sync._data.spacedRepetitionIntervals,
    { Low: 2, Medium: 5, High: 9 },
  );
  check(
    "saveSettings() preserves the stored Notion credentials",
    [ext.sync._data[KEYS.api], ext.sync._data[KEYS.db]],
    ["secret_test", "db_test"],
  );

  // Popup reload = brand-new context reading the same synced storage.
  const reopened = makeExtension({ ...ext.sync._data });
  await reopened.popup.ctx.loadSettings();
  check(
    "values survive a popup reload (fresh context, same sync storage)",
    [
      reopened.p("DOM.settings.intervalInputs.Low.value"),
      reopened.p("DOM.settings.intervalInputs.Medium.value"),
      reopened.p("DOM.settings.intervalInputs.High.value"),
    ],
    [2, 5, 9],
  );

  // Blanked field falls back to that level's default rather than 0.
  const ext2 = makeExtension({ ...CREDS });
  await ext2.popup.ctx.loadSettings();
  ext2.p(`DOM.settings.intervalInputs.High.value = "";`);
  await ext2.popup.ctx.saveSettings();
  check(
    "a cleared field saves that level's default (7), not 0",
    ext2.sync._data.spacedRepetitionIntervals.High,
    7,
  );
}

// ===========================================================================
ac("AC2 — save writes Spaced Repetition = today + the selected expertise's interval");
// ===========================================================================
for (const [level, offset] of [
  ["Low", 1],
  ["Medium", 3],
  ["High", 7],
]) {
  const ext = makeExtension({ ...CREDS });
  seedProblem(ext);
  ext.popup.ctx.populateExistingData({ expertise: level }); // sets selectedExpertise
  ext.reset();
  await ext.popup.ctx.saveToNotion();

  const create = ext.requests.find(
    (r) => r.endpoint === "pages" && r.method === "POST",
  );
  check(
    `${level} save: POST /pages Spaced Repetition = today+${offset}`,
    create?.body?.properties?.["Spaced Repetition"]?.date?.start,
    dayOffset(offset),
  );
  check(
    `${level} save: My Expertise still written as ${level}`,
    create?.body?.properties?.["My Expertise"]?.select?.name,
    level,
  );
  check(
    `${level} save: message carried the resolved day count, not a flat scalar`,
    ext.messages.find((m) => m.action === "saveToNotion")?.data
      ?.spacedRepetitionDays,
    offset,
  );
}
{
  // Custom intervals prove the values are read from settings, not hardcoded.
  const ext = makeExtension({
    ...CREDS,
    spacedRepetitionIntervals: { Low: 2, Medium: 5, High: 9 },
  });
  seedProblem(ext);
  ext.popup.ctx.populateExistingData({ expertise: "High" });
  ext.reset();
  await ext.popup.ctx.saveToNotion();
  check(
    "custom High=9: POST /pages Spaced Repetition = today+9",
    ext.requests.find((r) => r.endpoint === "pages")?.body?.properties?.[
      "Spaced Repetition"
    ]?.date?.start,
    dayOffset(9),
  );
  check(
    "save-to-Notion happy path unregressed (Question title still written)",
    ext.requests.find((r) => r.endpoint === "pages")?.body?.properties
      ?.Question?.title?.[0]?.text?.content,
    "Two Sum",
  );
}

// ===========================================================================
ac("AC3 — Revisit reschedules from the entry's stored 'My Expertise'");
// ===========================================================================
for (const [level, offset] of [
  ["Low", 1],
  ["Medium", 3],
  ["High", 7],
]) {
  const ext = makeExtension({ ...CREDS });
  seedProblem(ext);
  // Simulate popup open on an existing Notion entry whose My Expertise = level.
  ext._existing = { exists: true, pageId: "page-existing-001", expertise: level };
  await ext.popup.ctx.checkExistingEntry();
  check(
    `popup open hydrates selectedExpertise from "My Expertise" = ${level}`,
    ext.p("selectedExpertise"),
    level,
  );
  ext.reset();
  await ext.popup.ctx.revisitProblem();
  const patch = ext.requests.find((r) => r.endpoint === "pages/page-existing-001");
  check(
    `Revisit on a ${level} entry PATCHes Spaced Repetition = today+${offset}`,
    patch?.body?.properties?.["Spaced Repetition"]?.date?.start,
    dayOffset(offset),
  );
}
{
  // A leftover legacy scalar must not win over the per-expertise object.
  const ext = makeExtension({
    ...CREDS,
    spacedRepetitionDays: 30,
    spacedRepetitionIntervals: { Low: 1, Medium: 3, High: 7 },
  });
  seedProblem(ext);
  ext._existing = { exists: true, pageId: "page-existing-001", expertise: "High" };
  await ext.popup.ctx.checkExistingEntry();
  ext.reset();
  await ext.popup.ctx.revisitProblem();
  check(
    "Revisit ignores a stale flat spacedRepetitionDays=30 (uses High=7)",
    ext
      .requests.find((r) => r.endpoint === "pages/page-existing-001")
      ?.body?.properties?.["Spaced Repetition"]?.date?.start,
    dayOffset(7),
  );
}

// ===========================================================================
ac("AC4 — 'Tomorrow' still hardcodes 1 day regardless of expertise");
// ===========================================================================
{
  const ext = makeExtension({
    ...CREDS,
    spacedRepetitionIntervals: { Low: 30, Medium: 60, High: 90 },
  });
  seedProblem(ext);
  ext._existing = { exists: true, pageId: "page-existing-001", expertise: "High" };
  await ext.popup.ctx.checkExistingEntry();
  ext.reset();
  await ext.popup.ctx.markForReviewTomorrow();
  check(
    "Tomorrow on a High(=90) entry still writes today+1",
    ext
      .requests.find((r) => r.endpoint === "pages/page-existing-001")
      ?.body?.properties?.["Spaced Repetition"]?.date?.start,
    dayOffset(1),
  );
  check(
    "Tomorrow sends days: 1 on the wire",
    ext.messages.find((m) => m.action === "updateSpacedRepetition")?.data?.days,
    1,
  );
}
{
  // Even with every level disabled, Tomorrow is an explicit user action.
  const ext = makeExtension({
    ...CREDS,
    spacedRepetitionIntervals: { Low: 0, Medium: 0, High: 0 },
  });
  seedProblem(ext);
  ext._existing = { exists: true, pageId: "page-existing-001", expertise: "Low" };
  await ext.popup.ctx.checkExistingEntry();
  ext.reset();
  await ext.popup.ctx.markForReviewTomorrow();
  check(
    "Tomorrow works even when all intervals are 0",
    ext
      .requests.find((r) => r.endpoint === "pages/page-existing-001")
      ?.body?.properties?.["Spaced Repetition"]?.date?.start,
    dayOffset(1),
  );
}

// ===========================================================================
ac("AC5 — a per-level 0 disables the review date for that expertise only");
// ===========================================================================
{
  const intervals = { Low: 1, Medium: 3, High: 0 };

  const high = makeExtension({ ...CREDS, spacedRepetitionIntervals: intervals });
  seedProblem(high);
  high.popup.ctx.populateExistingData({ expertise: "High" });
  high.reset();
  await high.popup.ctx.saveToNotion();
  const created = high.requests.find((r) => r.endpoint === "pages");
  check(
    "High=0 save: no Spaced Repetition property in the created page",
    "Spaced Repetition" in (created?.body?.properties || {}),
    false,
  );
  check(
    "High=0 save: the rest of the page is still written (My Expertise)",
    created?.body?.properties?.["My Expertise"]?.select?.name,
    "High",
  );

  const low = makeExtension({ ...CREDS, spacedRepetitionIntervals: intervals });
  seedProblem(low);
  low.popup.ctx.populateExistingData({ expertise: "Low" });
  low.reset();
  await low.popup.ctx.saveToNotion();
  check(
    "Low=1 is unaffected by High=0 (still today+1)",
    low.requests.find((r) => r.endpoint === "pages")?.body?.properties?.[
      "Spaced Repetition"
    ]?.date?.start,
    dayOffset(1),
  );

  const rev = makeExtension({ ...CREDS, spacedRepetitionIntervals: intervals });
  seedProblem(rev);
  rev._existing = { exists: true, pageId: "page-existing-001", expertise: "High" };
  await rev.popup.ctx.checkExistingEntry();
  rev.reset();
  await rev.popup.ctx.revisitProblem();
  const patch = rev.requests.find((r) => r.endpoint === "pages/page-existing-001");
  check(
    "Revisit on a High=0 entry writes no Spaced Repetition date",
    "Spaced Repetition" in (patch?.body?.properties || {}),
    false,
  );
  check(
    "Revisit on a High=0 entry still logs the Attempts bump",
    patch?.body?.properties?.Attempts?.number,
    1,
  );
}

// ===========================================================================
ac("AC6 — migration from the legacy flat spacedRepetitionDays scalar");
// ===========================================================================
{
  // Legacy custom cadence: seeds all three levels, no errors.
  const ext = makeExtension({ ...CREDS, spacedRepetitionDays: 30 });
  await ext.popup.ctx.loadSettings();
  check(
    "legacy 30: settings inputs read 30 / 30 / 30",
    [
      ext.p("DOM.settings.intervalInputs.Low.value"),
      ext.p("DOM.settings.intervalInputs.Medium.value"),
      ext.p("DOM.settings.intervalInputs.High.value"),
    ],
    [30, 30, 30],
  );

  // Behavioural: a legacy user who never opens settings keeps their cadence.
  const beh = makeExtension({ ...CREDS, spacedRepetitionDays: 14 });
  seedProblem(beh);
  beh.popup.ctx.populateExistingData({ expertise: "High" });
  beh.reset();
  await beh.popup.ctx.saveToNotion();
  check(
    "legacy 14, settings never opened: save still writes today+14",
    beh.requests.find((r) => r.endpoint === "pages")?.body?.properties?.[
      "Spaced Repetition"
    ]?.date?.start,
    dayOffset(14),
  );

  // Legacy 0 means "reviews deliberately off" — must not be re-enabled.
  const off = makeExtension({ ...CREDS, spacedRepetitionDays: 0 });
  await off.popup.ctx.loadSettings();
  check(
    "legacy 0: inputs read 0 / 0 / 0 (reviews stay disabled)",
    [
      off.p("DOM.settings.intervalInputs.Low.value"),
      off.p("DOM.settings.intervalInputs.Medium.value"),
      off.p("DOM.settings.intervalInputs.High.value"),
    ],
    [0, 0, 0],
  );
  seedProblem(off);
  off.popup.ctx.populateExistingData({ expertise: "Medium" });
  off.reset();
  await off.popup.ctx.saveToNotion();
  check(
    "legacy 0: save writes no Spaced Repetition date",
    "Spaced Repetition" in
      (off.requests.find((r) => r.endpoint === "pages")?.body?.properties || {}),
    false,
  );

  // One-shot migration: first save writes the object and drops the legacy key.
  const mig = makeExtension({ ...CREDS, spacedRepetitionDays: 30 });
  await mig.popup.ctx.loadSettings();
  await mig.popup.ctx.saveSettings();
  check(
    "first saveSettings() writes the object seeded from the legacy scalar",
    mig.sync._data.spacedRepetitionIntervals,
    { Low: 30, Medium: 30, High: 30 },
  );
  check(
    "first saveSettings() deletes the legacy spacedRepetitionDays key",
    "spacedRepetitionDays" in mig.sync._data,
    false,
  );

  // Corrupt / partial object: per-level fallback, no throw.
  const partial = makeExtension({
    ...CREDS,
    spacedRepetitionDays: 30,
    spacedRepetitionIntervals: { Low: 4, High: "nonsense" },
  });
  await partial.popup.ctx.loadSettings();
  check(
    "partial object: Low from object, Medium+High fall back to the legacy scalar",
    [
      partial.p("DOM.settings.intervalInputs.Low.value"),
      partial.p("DOM.settings.intervalInputs.Medium.value"),
      partial.p("DOM.settings.intervalInputs.High.value"),
    ],
    [4, 30, 30],
  );
  const garbage = makeExtension({
    ...CREDS,
    spacedRepetitionIntervals: { Low: -5, Medium: "abc", High: 9999 },
  });
  await garbage.popup.ctx.loadSettings();
  check(
    "garbage values are sanitized (negative/NaN -> default, >365 -> 365)",
    [
      garbage.p("DOM.settings.intervalInputs.Low.value"),
      garbage.p("DOM.settings.intervalInputs.Medium.value"),
      garbage.p("DOM.settings.intervalInputs.High.value"),
    ],
    [1, 3, 365],
  );

  // Unknown expertise (e.g. a hand-edited Notion select) must not lose the date.
  const unknown = makeExtension({ ...CREDS });
  seedProblem(unknown);
  unknown.popup.ctx.populateExistingData({ expertise: "Expert" });
  unknown.reset();
  await unknown.popup.ctx.saveToNotion();
  check(
    "unknown expertise falls back to the Medium interval (today+3)",
    unknown.requests.find((r) => r.endpoint === "pages")?.body?.properties?.[
      "Spaced Repetition"
    ]?.date?.start,
    dayOffset(3),
  );
}

// ===========================================================================
ac("AC7 — the hourly checkReviews alarm + notification are unchanged");
// ===========================================================================
{
  // Static: the review-alarm code is untouched by this branch.
  const before = execFileSync("git", ["show", "main:background.js"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  const after = fs.readFileSync(path.join(REPO_ROOT, "background.js"), "utf8");
  const slice = (src) => {
    const start = src.indexOf("async function checkDueReviews()");
    return src.slice(start, src.indexOf("\n}\n", start));
  };
  check(
    "checkDueReviews() is byte-identical to main",
    slice(after) === slice(before),
    true,
  );
  check(
    "the checkReviews alarm registration is byte-identical to main",
    after.includes(`chrome.alarms.create("checkReviews", {\n    periodInMinutes: 60,\n  });`) &&
      before.includes(`chrome.alarms.create("checkReviews", {\n    periodInMinutes: 60,\n  });`),
    true,
  );

  // Behavioural: it still queries on_or_before today and fires the notification.
  const ext = makeExtension({ ...CREDS });
  ext.bg.ctx.fetch = undefined; // keep the harness honest: use the wired router
  const dueFetch = async (url, options) => {
    const endpoint = url.replace("https://api.notion.com/v1/", "");
    ext.requests.push({
      endpoint,
      method: options.method,
      body: JSON.parse(options.body),
    });
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ results: [{ id: "a" }, { id: "b" }] }),
    };
  };
  vm.runInContext("globalThis.__fetchOverride = null;", ext.bg.ctx);
  ext.bg.ctx.fetch = dueFetch;
  ext.reset();
  await ext.bg.ctx.checkDueReviews();
  const query = ext.requests.find((r) => /\/query$/.test(r.endpoint));
  check(
    "checkDueReviews queries Spaced Repetition on_or_before today",
    query?.body?.filter,
    { property: "Spaced Repetition", date: { on_or_before: dayOffset(0) } },
  );
  check(
    "checkDueReviews raises the 'LeetCode Review Due' notification",
    ext.notifications.map((n) => [n.title, n.message]),
    [["LeetCode Review Due", "You have 2 problems due for review today."]],
  );
}

// ===========================================================================
console.log("");
if (failures.length) {
  console.log(`${passed} passed, ${failures.length} FAILED`);
  failures.forEach((f) => console.log(`  FAIL  ${f}`));
  process.exit(1);
}
console.log(`${passed} passed, 0 failed (${passed} assertions)`);
