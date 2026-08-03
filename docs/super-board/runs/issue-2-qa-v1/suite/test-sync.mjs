/**
 * Issue #2 QA suite — cross-device sync: hydrate snapshots/notes from Notion,
 * stop clobbering on second machine.
 *
 * Runs the REAL background.js (imported as a module with chrome/fetch mocked)
 * and the REAL popup.js (executed unmodified in per-profile `vm` contexts with
 * a minimal DOM double). "Profiles" simulate two machines: each has its own
 * chrome.storage, while the mock Notion cloud is shared — exactly the
 * cross-device topology from the issue.
 *
 * Run from the repo root (or anywhere):
 *   node docs/super-board/runs/issue-2-qa-v1/suite/test-sync.mjs
 *
 * Exit code 0 = all assertions pass.
 */

import vm from "node:vm";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  createNotionMock,
  createNotionFetch,
  createChromeMock,
  parseSolutionsFromPage,
  parseNotesFromPage,
  jsonClone,
} from "./mock-env.mjs";
import { createFakeDom } from "./fake-dom.mjs";

const SUITE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SUITE_DIR, "../../../../..");
const EVIDENCE_DIR = path.resolve(SUITE_DIR, "..");

// ---------------------------------------------------------------------------
// Assertion plumbing
// ---------------------------------------------------------------------------

let passCount = 0;
const failures = [];

function check(name, cond, detail = "") {
  if (cond) {
    passCount++;
    console.log(`  PASS  ${name}`);
  } else {
    failures.push({ name, detail });
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title) {
  console.log(`\n=== ${title} ===`);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SETTINGS = {
  notionApiKey: "secret_qa_key",
  notionDatabaseId: "qa-database-0001",
  spacedRepetitionDays: 30,
};

const CODE_A1 = [
  "class Solution:",
  "    def twoSum(self, nums, target):",
  "        seen = {}",
  "        for i, n in enumerate(nums):",
  "            if target - n in seen:",
  "                return [seen[target - n], i]",
  "            seen[n] = i",
].join("\n");

const CODE_A2 = [
  "class Solution:",
  "    def twoSum(self, nums, target):",
  "        for i in range(len(nums)):",
  "            for j in range(i + 1, len(nums)):",
  "                if nums[i] + nums[j] == target:",
  "                    return [i, j]",
].join("\n");

const CODE_WIP = "# WIP local-only idea\n# not saved to Notion yet";

const FIXTURE = {
  number: 1,
  title: "Two Sum",
  difficulty: "Easy",
  code: CODE_A1,
  language: "Python3",
  url: "https://leetcode.com/problems/two-sum/",
  scrapedTags: ["array", "hash table"],
  questionContent:
    "Given an array of integers nums and an integer target, return indices of the two numbers such that they add up to target. Example 1: ...",
  examples: [
    { number: 1, input: "nums = [2,7,11,15], target = 9", output: "[0,1]" },
  ],
  constraints: ["2 <= nums.length <= 10^4"],
};

function baseProblemPayload(overrides = {}) {
  return {
    number: 1,
    title: "Two Sum",
    difficulty: "Easy",
    code: CODE_A1,
    language: "Python3",
    url: FIXTURE.url,
    tags: ["Array"],
    expertise: "High",
    notes: "",
    remark: "",
    altMethods: "",
    done: false,
    timeComplexity: "",
    spaceComplexity: "",
    attempts: 1,
    snapshots: [],
    saveQuestion: false,
    questionContent: { content: "", description: "", examples: [], constraints: [] },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Environment bootstrap: shared cloud + shared message bus + real background.js
// ---------------------------------------------------------------------------

const bus = { listeners: [] };
const syncSetLog = [];
const notion = createNotionMock();

const backgroundChrome = createChromeMock({
  bus,
  localData: {},
  syncData: {},
  syncSetLog,
  problemFixture: null,
});

globalThis.chrome = backgroundChrome;
globalThis.fetch = createNotionFetch(notion);

// background.js logs verbosely with a "Leetion" prefix; keep suite output
// readable while still surfacing anything unexpected.
const realLog = console.log.bind(console);
const realWarn = console.warn.bind(console);
const realError = console.error.bind(console);
const isLeetionNoise = (args) =>
  typeof args[0] === "string" && args[0].startsWith("Leetion");
console.log = (...args) => {
  if (!isLeetionNoise(args)) realLog(...args);
};
console.warn = (...args) => {
  if (!isLeetionNoise(args)) realWarn(...args);
};
console.error = (...args) => {
  realError(...args);
};

await import(new URL("../../../../../background.js", import.meta.url).href);

const callBg = (action, data) =>
  backgroundChrome.runtime.sendMessage({ action, data });

// ---------------------------------------------------------------------------
// Popup booter: runs the real popup.js in a fresh vm context per "machine"
// ---------------------------------------------------------------------------

const popupSource = fs.readFileSync(path.join(REPO_ROOT, "popup.js"), "utf8");

const EXPOSE = `
;globalThis.__qa = {
  get DOM() { return DOM; },
  get codeSnapshots() { return codeSnapshots; },
  set codeSnapshots(v) { codeSnapshots = v; },
  get problemData() { return problemData; },
  set problemData(v) { problemData = v; },
  get selectedTags() { return selectedTags; },
  get selectedExpertise() { return selectedExpertise; },
  set selectedExpertise(v) { selectedExpertise = v; },
  get existingPageId() { return existingPageId; },
  get userAttemptCount() { return userAttemptCount; },
};`;

const quietConsole = {
  log() {},
  warn() {},
  error(...args) {
    // Surface real errors but ignore expected noise-free runs.
    console.log("  [popup console.error]", ...args.map(String).slice(0, 2));
  },
};

async function bootPopup(profile) {
  const dom = createFakeDom();
  const chrome = createChromeMock({
    bus,
    localData: profile.local,
    syncData: profile.sync,
    syncSetLog,
    problemFixture: profile.fixture || FIXTURE,
    tabUrl: (profile.fixture || FIXTURE).url,
  });
  const sandbox = {
    chrome,
    document: dom.document,
    window: dom.window,
    console: quietConsole,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  };
  sandbox.window.document = dom.document;
  vm.createContext(sandbox);
  vm.runInContext(popupSource + EXPOSE, sandbox, { filename: "popup.js" });
  await dom.dispatchDocumentEvent("DOMContentLoaded");
  return { sandbox, dom, qa: sandbox.__qa };
}

// ---------------------------------------------------------------------------
// S0 — environment sanity
// ---------------------------------------------------------------------------

section("S0 environment sanity");
check("background.js registered exactly one onMessage listener", bus.listeners.length === 1);

// ---------------------------------------------------------------------------
// S1 — Profile A: first save with 2 snapshots + notes + expertise (setup +
//      happy-path regression, PROJECT.md definition of done)
// ---------------------------------------------------------------------------

section("S1 Profile A: save 2 snapshots + notes + expertise (create path)");

const profileA = { local: {}, sync: jsonClone(SETTINGS) };
{
  const A = await bootPopup(profileA);
  check("A: problem scraped (number 1)", A.qa.problemData.number === 1);
  check("A: no existing page found on empty DB", A.qa.existingPageId === null);
  check(
    "A: snapshot list renders empty",
    A.qa.DOM.snapshots.count.textContent === "0",
  );

  await A.sandbox.saveSnapshot();
  A.qa.problemData.code = CODE_A2;
  await A.sandbox.saveSnapshot();
  check("A: two snapshots captured locally", A.qa.codeSnapshots.length === 2);

  A.qa.DOM.form.notes.value = "A notes";
  A.qa.DOM.form.remark.value = "A remark";
  A.qa.DOM.form.altMethods.value = "Two Pointers";
  A.qa.DOM.complexity.time.value = "O(n)";
  A.qa.DOM.complexity.space.value = "O(1)";
  A.qa.selectedExpertise = "High";

  await A.sandbox.saveToNotion();

  const page = notion.pageByNumber(1);
  check("A: Notion page created", !!page);
  const sols = page ? parseSolutionsFromPage(page) : [];
  check("A: page has exactly 2 solutions", sols.length === 2, `got ${sols.length}`);
  check("A: solution 1 code round-trips", sols[0]?.code === CODE_A1);
  check("A: solution 2 code round-trips", sols[1]?.code === CODE_A2);
  check(
    "A: code block caption stores display language",
    sols[0]?.caption === "Python3" && sols[1]?.caption === "Python3",
  );
  check(
    "A: H3 subheadings carry language+label",
    /^Python3 - Solution 1 \(/.test(sols[0]?.heading || "") &&
      /^Python3 - Solution 2 \(/.test(sols[1]?.heading || ""),
  );
  check("A: notes saved to page", page && parseNotesFromPage(page) === "A notes");
  check(
    "A: title + S No. + expertise + attempts properties saved",
    page &&
      page.properties.Question?.title?.[0]?.plain_text === "Two Sum" &&
      page.properties["S No."]?.number === 1 &&
      page.properties["My Expertise"]?.select?.name === "High" &&
      page.properties.Attempts?.number === 1,
  );
  check(
    "A: local snapshots persisted with synced flag after save (AC4 baseline)",
    (profileA.local["snapshots_1"] || []).length === 2 &&
      profileA.local["snapshots_1"].every((s) => s.synced === true),
  );
  check("A: form draft cleared after save", !profileA.local["form_state_1"]);
  check("A: popup adopted new pageId", A.qa.existingPageId === page?.id);
  check(
    "A: save status shows created",
    A.qa.DOM.save.status.textContent === "Saved to Notion!",
    `got "${A.qa.DOM.save.status.textContent}"`,
  );
}

// ---------------------------------------------------------------------------
// S2 — Profile B (fresh machine): popup open hydrates everything (AC1 + AC7)
// ---------------------------------------------------------------------------

section("S2 Profile B (fresh): popup open hydrates from Notion (AC1, AC7)");

const profileB = { local: {}, sync: jsonClone(SETTINGS) };
let pageId1;
{
  const B = await bootPopup(profileB);
  const snaps = B.qa.codeSnapshots;
  check("B: snapshot list hydrated with 2 solutions (AC1)", snaps.length === 2, `got ${snaps.length}`);
  check(
    "B: hydrated codes match machine A exactly (AC7)",
    snaps[0]?.code === CODE_A1 && snaps[1]?.code === CODE_A2,
  );
  check(
    "B: hydrated snapshots marked synced + source notion",
    snaps.every((s) => s.synced === true && s.source === "notion"),
  );
  check(
    "B: hydrated language from caption",
    snaps.every((s) => s.language === "Python3"),
  );
  check(
    "B: hydrated labels from subheadings",
    snaps[0]?.label === "Solution 1" && snaps[1]?.label === "Solution 2",
  );
  check(
    "B: reconciled list persisted to storage.local on open (AC4 persistence)",
    (profileB.local["snapshots_1"] || []).length === 2,
  );
  check(
    "B: snapshot UI rendered (count=2, list shows solutions)",
    B.qa.DOM.snapshots.count.textContent === "2" &&
      B.qa.DOM.snapshots.list.innerHTML.includes("Python3 - Solution 1") &&
      B.qa.DOM.snapshots.list.innerHTML.includes("Python3 - Solution 2"),
  );
  check("B: notes hydrated (AC7)", B.qa.DOM.form.notes.value === "A notes");
  check("B: remark hydrated", B.qa.DOM.form.remark.value === "A remark");
  check("B: expertise hydrated (AC7)", B.qa.selectedExpertise === "High");
  check(
    "B: complexity hydrated",
    B.qa.DOM.complexity.time.value === "O(n)" &&
      B.qa.DOM.complexity.space.value === "O(1)",
  );
  check("B: attempts hydrated from Notion (AC5)", B.qa.userAttemptCount === 1);
  check(
    "B: status message announces existing entry",
    B.qa.DOM.save.status.textContent === "Found existing entry - will update on save",
    `got "${B.qa.DOM.save.status.textContent}"`,
  );

  // The background.js:319 key fix, observed at the message-contract level.
  const resp = await callBg("checkExisting", {
    apiKey: SETTINGS.notionApiKey,
    databaseId: SETTINGS.notionDatabaseId,
    problemNumber: 1,
  });
  pageId1 = resp.pageId;
  check(
    "checkExisting returns codeBlocks (key mismatch fixed)",
    Array.isArray(resp.codeBlocks) && resp.codeBlocks.length === 2,
  );
  check("checkExisting no longer exposes dead existingCode key", !("existingCode" in resp));
  check(
    "checkExisting returns remoteSnapshots + lastEdited",
    resp.remoteSnapshots?.length === 2 && typeof resp.lastEdited === "number",
  );

  // ---------------------------------------------------------------------------
  // S3 — Profile B presses "Update in Notion" (AC2: the destructive-clobber
  //      regression scenario from the issue, hydration path active)
  // ---------------------------------------------------------------------------

  section('S3 Profile B presses "Update in Notion" (AC2 regression)');

  await B.sandbox.saveToNotion();
  const page = notion.pageByNumber(1);
  const sols = parseSolutionsFromPage(page);
  check(
    "B update: page still contains BOTH solutions (no clobber)",
    sols.length === 2 && sols[0].code === CODE_A1 && sols[1].code === CODE_A2,
    `got ${sols.length} solutions`,
  );
  check("B update: notes preserved", parseNotesFromPage(page) === "A notes");
  check(
    "B update: solutions not duplicated",
    sols.length === 2 && page.children.filter((b) => b.type === "heading_2").length <= 3,
  );
  fs.writeFileSync(
    path.join(EVIDENCE_DIR, "notion-after-b-update.json"),
    JSON.stringify({ note: "mock Notion page after fresh profile B pressed Update", page }, null, 2),
  );
}

// ---------------------------------------------------------------------------
// S4 — Defense in depth: update with NO local snapshots (hydration failed /
//      pre-hydration client) must not wipe the Solution(s) section (AC2)
// ---------------------------------------------------------------------------

section("S4 Update with zero local snapshots (hydration-failure guard, AC2)");
{
  const before = notion.pageByNumber(1).children.map((b) => b.id);

  const respA = await callBg("saveToNotion", {
    apiKey: SETTINGS.notionApiKey,
    databaseId: SETTINGS.notionDatabaseId,
    existingPageId: pageId1,
    spacedRepetitionDays: 30,
    problem: baseProblemPayload({ code: "print('editor preview only')" }),
  });
  const afterA = notion.pageByNumber(1).children.map((b) => b.id);
  check(
    "no-content update: contentUpdated=false, page untouched",
    respA.success === true &&
      respA.contentUpdated === false &&
      JSON.stringify(before) === JSON.stringify(afterA),
  );

  const respB = await callBg("saveToNotion", {
    apiKey: SETTINGS.notionApiKey,
    databaseId: SETTINGS.notionDatabaseId,
    existingPageId: pageId1,
    spacedRepetitionDays: 30,
    problem: baseProblemPayload({
      code: "print('editor preview only')",
      notes: "guard notes",
    }),
  });
  const page = notion.pageByNumber(1);
  const sols = parseSolutionsFromPage(page);
  check(
    "notes-only update from snapshot-less device keeps both solutions (clobber guard)",
    respB.success === true &&
      sols.length === 2 &&
      sols[0].code === CODE_A1 &&
      sols[1].code === CODE_A2,
    `got ${sols.length} solutions`,
  );
  check(
    "editor preview code was NOT written as a solution",
    sols.every((s) => !s.code.includes("editor preview only")),
  );
  check("notes still update through the guard", parseNotesFromPage(page) === "guard notes");
}

// ---------------------------------------------------------------------------
// S5 — Draft freshness gate (AC3)
// ---------------------------------------------------------------------------

section("S5 Draft-vs-Notion freshness gate (AC3)");
{
  const pageLastEdited = Date.parse(notion.pageByNumber(1).last_edited_time);

  // (a) STALE draft: Notion edited after the draft was written → Notion wins.
  profileA.local["form_state_1"] = {
    notes: "stale draft notes",
    remark: "stale draft remark",
    altMethods: "",
    timeComplexity: "O(n²)",
    spaceComplexity: "",
    done: true,
    expertise: "Low",
    tags: [],
    timestamp: pageLastEdited - 3600_000,
  };
  const A2 = await bootPopup(profileA);
  check(
    "stale draft: Notion notes win",
    A2.qa.DOM.form.notes.value === "guard notes",
    `got "${A2.qa.DOM.form.notes.value}"`,
  );
  check("stale draft: Notion remark wins", A2.qa.DOM.form.remark.value === "A remark");
  check("stale draft: Notion expertise wins", A2.qa.selectedExpertise === "High");
  check("stale draft: done reset to Notion value", A2.qa.DOM.form.done.checked === false);
  check(
    "stale draft: complexity reset then repopulated from Notion",
    A2.qa.DOM.complexity.time.value === "O(n)",
  );
  check("stale draft: cleared from storage", !profileA.local["form_state_1"]);
  check(
    "stale draft: status announces Notion data used",
    A2.qa.DOM.save.status.textContent ===
      "Loaded latest data from Notion (newer than local draft)",
    `got "${A2.qa.DOM.save.status.textContent}"`,
  );

  // (b) FRESH draft: draft newer than the page → draft wins (existing behavior).
  profileA.local["form_state_1"] = {
    notes: "fresh draft notes",
    remark: "fresh draft remark",
    altMethods: "",
    timeComplexity: "O(n²)",
    spaceComplexity: "",
    done: true,
    expertise: "Low",
    tags: [],
    timestamp: Date.now() + 3600_000,
  };
  const A3 = await bootPopup(profileA);
  check(
    "fresh draft: draft notes win",
    A3.qa.DOM.form.notes.value === "fresh draft notes",
    `got "${A3.qa.DOM.form.notes.value}"`,
  );
  check("fresh draft: draft expertise wins", A3.qa.selectedExpertise === "Low");
  check(
    "fresh draft: draft complexity wins",
    A3.qa.DOM.complexity.time.value === "O(n²)",
  );
  check("fresh draft: draft kept in storage", !!profileA.local["form_state_1"]);
  check(
    "fresh draft: snapshots still hydrate regardless of draft",
    A3.qa.codeSnapshots.length === 2,
  );
  check(
    "fresh draft: status is the normal existing-entry message",
    A3.qa.DOM.save.status.textContent === "Found existing entry - will update on save",
  );
}

// ---------------------------------------------------------------------------
// S6 — Attempts stays Notion-backed and identical across machines (AC5)
// ---------------------------------------------------------------------------

section("S6 Attempts Notion-backed across machines (AC5)");
{
  const resp = await callBg("updateSpacedRepetition", {
    apiKey: SETTINGS.notionApiKey,
    pageId: pageId1,
    days: 30,
    attempts: 5,
  });
  check("updateSpacedRepetition writes attempts", resp.success === true);
  check(
    "page Attempts property is 5",
    notion.pageByNumber(1).properties.Attempts?.number === 5,
  );

  const M1 = await bootPopup({ local: {}, sync: jsonClone(SETTINGS) });
  const M2 = await bootPopup({ local: {}, sync: jsonClone(SETTINGS) });
  check(
    "two fresh machines both read attempts=5 from Notion",
    M1.qa.userAttemptCount === 5 && M2.qa.userAttemptCount === 5,
    `got ${M1.qa.userAttemptCount}/${M2.qa.userAttemptCount}`,
  );
}

// ---------------------------------------------------------------------------
// S7 — Remote deletion propagates; stale local list cannot resurrect (AC4)
// ---------------------------------------------------------------------------

section("S7 Remote deletion propagates; stale snapshots cannot resurrect (AC4)");
{
  // Machine B deletes Solution 2 and saves.
  const B4 = await bootPopup(profileB);
  check("B4: booted with 2 snapshots", B4.qa.codeSnapshots.length === 2);
  const solution2Id = B4.qa.codeSnapshots[1].id;
  await B4.sandbox.deleteSnapshot(solution2Id);
  check("B4: local delete leaves 1 snapshot", B4.qa.codeSnapshots.length === 1);
  await B4.sandbox.saveToNotion();
  const solsAfterDelete = parseSolutionsFromPage(notion.pageByNumber(1));
  check(
    "B4: page now has only solution 1",
    solsAfterDelete.length === 1 && solsAfterDelete[0].code === CODE_A1,
    `got ${solsAfterDelete.length}`,
  );

  // Machine A still holds the stale pre-deletion list [S1, S2] (synced flags).
  delete profileA.local["form_state_1"]; // discard the future-dated test draft
  check(
    "A: stale local list still has 2 snapshots before boot",
    (profileA.local["snapshots_1"] || []).length === 2,
  );
  const A4 = await bootPopup(profileA);
  check(
    "A4: popup open drops the remotely-deleted snapshot (deletion propagates)",
    A4.qa.codeSnapshots.length === 1 && A4.qa.codeSnapshots[0].code === CODE_A1,
    `got ${A4.qa.codeSnapshots.length}`,
  );
  check(
    "A4: reconciled (post-deletion) state persisted locally",
    (profileA.local["snapshots_1"] || []).length === 1,
  );
  await A4.sandbox.saveToNotion();
  const solsAfterASave = parseSolutionsFromPage(notion.pageByNumber(1));
  check(
    "A4: save does NOT resurrect the deleted solution (AC4)",
    solsAfterASave.length === 1 && solsAfterASave[0].code === CODE_A1,
    `got ${solsAfterASave.length}`,
  );
  fs.writeFileSync(
    path.join(EVIDENCE_DIR, "notion-after-stale-machine-save.json"),
    JSON.stringify(
      {
        note: "mock Notion page after machine A (stale 2-snapshot local list) saved post-deletion",
        page: notion.pageByNumber(1),
      },
      null,
      2,
    ),
  );
}

// ---------------------------------------------------------------------------
// S8 — Never-synced local work is preserved, question snapshots stay local
// ---------------------------------------------------------------------------

section("S8 Unsynced local snapshots survive reconcile (no user code lost)");
{
  const profileC = {
    local: {
      snapshots_1: [
        {
          id: "q_local",
          type: "question",
          code: "# 1. Two Sum\n\nProblem statement...",
          language: "markdown",
          timestamp: Date.now(),
          label: "Problem Statement",
        },
        {
          id: "wip1",
          code: CODE_WIP,
          language: "Python3",
          timestamp: Date.now(),
          label: "Solution 1",
          // no `synced` flag — never saved to Notion (also the legacy shape)
        },
      ],
    },
    sync: jsonClone(SETTINGS),
  };
  const C = await bootPopup(profileC);
  const snaps = C.qa.codeSnapshots;
  check(
    "C: reconcile = [question, remote solution, unsynced local]",
    snaps.length === 3 &&
      snaps[0].type === "question" &&
      snaps[1].code === CODE_A1 &&
      snaps[2].code === CODE_WIP,
    `got ${snaps.map((s) => s.type || "solution").join(",")}`,
  );
  check("C: unsynced local snapshot NOT dropped", snaps.some((s) => s.code === CODE_WIP));

  await C.sandbox.saveToNotion();
  const page = notion.pageByNumber(1);
  const sols = parseSolutionsFromPage(page);
  check(
    "C: save appends the local WIP after the remote solution",
    sols.length === 2 && sols[0].code === CODE_A1 && sols[1].code === CODE_WIP,
    `got ${sols.length}`,
  );
  check(
    "C: question snapshot did not become a Solution(s) entry",
    sols.every((s) => !s.code.includes("Problem statement")),
  );
  check(
    "C: local snapshots all flagged synced after save",
    (profileC.local["snapshots_1"] || [])
      .filter((s) => s.type !== "question")
      .every((s) => s.synced === true),
  );
}

// ---------------------------------------------------------------------------
// S9 — Lone question-type snapshot no longer wipes Solution(s) (fix in passing)
// ---------------------------------------------------------------------------

section("S9 Lone question-type snapshot cannot wipe Solution(s)");
{
  const questionSnap = {
    id: "qsnap",
    type: "question",
    code: "# 1. Two Sum question markdown",
    language: "markdown",
    timestamp: Date.now(),
    label: "Problem Statement",
  };

  const before = notion.pageByNumber(1).children.map((b) => b.id);
  const respA = await callBg("saveToNotion", {
    apiKey: SETTINGS.notionApiKey,
    databaseId: SETTINGS.notionDatabaseId,
    existingPageId: pageId1,
    spacedRepetitionDays: 30,
    problem: baseProblemPayload({ snapshots: [questionSnap] }),
  });
  const after = notion.pageByNumber(1).children.map((b) => b.id);
  check(
    "question-only update: no content rebuild, page untouched",
    respA.contentUpdated === false && JSON.stringify(before) === JSON.stringify(after),
  );

  await callBg("saveToNotion", {
    apiKey: SETTINGS.notionApiKey,
    databaseId: SETTINGS.notionDatabaseId,
    existingPageId: pageId1,
    spacedRepetitionDays: 30,
    problem: baseProblemPayload({
      snapshots: [questionSnap],
      notes: "note after question-only save",
    }),
  });
  const page = notion.pageByNumber(1);
  const sols = parseSolutionsFromPage(page);
  const h2s = page.children
    .filter((b) => b.type === "heading_2")
    .map((b) => b.heading_2.rich_text.map((t) => t.plain_text).join(""));
  check(
    "question+notes update: solutions preserved via guard",
    sols.length === 2 && sols[0].code === CODE_A1 && sols[1].code === CODE_WIP,
    `got ${sols.length}`,
  );
  check(
    "exactly one Solution(s) heading, no empty duplicate",
    h2s.filter((t) => t === "Solution(s)").length === 1,
    `headings: ${h2s.join("|")}`,
  );
}

// ---------------------------------------------------------------------------
// S10 — Pagination: pages with >100 blocks hydrate completely
// ---------------------------------------------------------------------------

section("S10 Pagination: >100-block page hydrates fully");
{
  const many = Array.from({ length: 60 }, (_, i) => ({
    id: `many_${i}`,
    code: `# solution ${i}\npass`,
    language: "Python3",
    timestamp: Date.now(),
    label: `Solution ${i + 1}`,
  }));
  await callBg("saveToNotion", {
    apiKey: SETTINGS.notionApiKey,
    databaseId: SETTINGS.notionDatabaseId,
    existingPageId: null,
    spacedRepetitionDays: 30,
    problem: baseProblemPayload({
      number: 2,
      title: "Add Two Numbers",
      snapshots: many,
      url: "https://leetcode.com/problems/add-two-numbers/",
    }),
  });
  const page2 = notion.pageByNumber(2);
  check(
    "60-snapshot page created with >100 blocks",
    page2 && page2.children.length === 121,
    `got ${page2?.children.length}`,
  );

  const marker = notion.state.requestLog.length;
  const resp = await callBg("checkExisting", {
    apiKey: SETTINGS.notionApiKey,
    databaseId: SETTINGS.notionDatabaseId,
    problemNumber: 2,
  });
  const childReads = notion.state.requestLog
    .slice(marker)
    .filter((r) => r.method === "GET" && r.endpoint.includes(`blocks/${page2.id}/children`));
  check(
    "all 60 solutions hydrate (old code truncated at 100 blocks)",
    resp.remoteSnapshots?.length === 60,
    `got ${resp.remoteSnapshots?.length}`,
  );
  check(
    "block fetch followed pagination cursor (2 GET pages)",
    childReads.length === 2,
    `got ${childReads.length} reads`,
  );
  check(
    "first/last hydrated codes intact",
    resp.remoteSnapshots?.[0]?.code === "# solution 0\npass" &&
      resp.remoteSnapshots?.[59]?.code === "# solution 59\npass",
  );
}

// ---------------------------------------------------------------------------
// S11 — Snapshots never enter chrome.storage.sync (AC6)
// ---------------------------------------------------------------------------

section("S11 storage.sync quota audit (AC6)");
{
  check(
    "zero storage.sync writes across every scenario",
    syncSetLog.length === 0,
    `got ${syncSetLog.length} writes: ${JSON.stringify(syncSetLog.map((e) => e.keys))}`,
  );

  const ALLOWED = new Set([
    "notionApiKey",
    "notionDatabaseId",
    "spacedRepetitionDays",
    "onboardingComplete",
  ]);
  const offenders = syncSetLog.filter(
    (e) => !e.keys.every((k) => ALLOWED.has(k)) || e.bytes >= 8192,
  );
  check("any sync writes stay within allowed keys and 8KB quota", offenders.length === 0);

  // Static source audit: no code path writes snapshot/form-draft keys to sync.
  const sources = ["popup.js", "background.js", "onboarding.js", "content.js"].map((f) => ({
    f,
    text: fs.readFileSync(path.join(REPO_ROOT, f), "utf8"),
  }));
  const syncSetLines = [];
  for (const { f, text } of sources) {
    text.split("\n").forEach((line, i) => {
      if (line.includes(".sync.set(")) syncSetLines.push({ f, line: i + 1, text: line.trim() });
    });
  }
  check(
    "no storage.sync.set call involves snapshots or form drafts (static audit)",
    syncSetLines.every(
      (l) => !l.text.includes("snapshot") && !l.text.includes("form_state"),
    ),
    JSON.stringify(syncSetLines),
  );
  // Every place popup.js constructs a snapshots_ key sits in a storage.local
  // call (saveSnapshot / loadSnapshots / reconcileSnapshots / delete / post-save
  // persist); none appear near storage.sync (checked above).
  const snapshotKeySites = sources[0].text.match(/`snapshots_\$\{/g) || [];
  check(
    "snapshot persistence goes through storage.local only",
    snapshotKeySites.length >= 5 &&
      !/sync\.(set|get)\(\s*\[?`?snapshots_/.test(sources[0].text),
    `found ${snapshotKeySites.length} snapshots_ key sites in popup.js`,
  );
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

section("Summary");
console.log(`  ${passCount} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("\nFailed assertions:");
  for (const f of failures) console.log(`  - ${f.name}${f.detail ? ` (${f.detail})` : ""}`);
}

fs.writeFileSync(
  path.join(EVIDENCE_DIR, "assertions.json"),
  JSON.stringify({ passed: passCount, failed: failures.length, failures }, null, 2),
);

process.exit(failures.length ? 1 : 0);
