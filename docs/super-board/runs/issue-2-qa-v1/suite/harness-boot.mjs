/**
 * Browser bootstrap for the issue #2 visual QA harness.
 *
 * Loaded (as the FIRST deferred script) by /qa-harness.html — a transformed
 * copy of popup.html served by serve.mjs — followed by the real background.js
 * (module) and the real popup.js (defer). Installs window.chrome + a mock
 * Notion cloud before either executes.
 *
 * Cross-"machine" simulation:
 *   - chrome.storage.local  -> localStorage["qa_profile_<name>"]  (per machine)
 *   - mock Notion cloud     -> localStorage["qa_notion"]          (shared)
 *   - chrome.storage.sync   -> fixed settings (sync replicates anyway)
 *
 * URL params:
 *   ?profile=A|B|C   which machine this tab is (default A)
 *   &reset           wipe cloud + all profiles first
 *   &auto=seed       drive the UI: 2 snapshots + notes + expertise + Save
 *   &auto=update     wait for hydration, then click "Update in Notion"
 *   &auto=stale-draft  pre-seed a form draft OLDER than the Notion page
 *   &auto=fresh-draft  pre-seed a form draft NEWER than the Notion page
 */

import {
  createNotionMock,
  createNotionFetch,
  createChromeMock,
  parseSolutionsFromPage,
  parseNotesFromPage,
  jsonClone,
} from "./mock-env.mjs";

const params = new URLSearchParams(location.search);
const profile = params.get("profile") || "A";
const auto = params.get("auto") || "";

if (params.has("reset")) {
  for (const k of Object.keys(localStorage)) {
    if (k.startsWith("qa_")) localStorage.removeItem(k);
  }
}

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

const FIXTURE = {
  number: 1,
  title: "Two Sum",
  difficulty: "Easy",
  code: CODE_A1,
  language: "Python3",
  url: "https://leetcode.com/problems/two-sum/",
  scrapedTags: ["array", "hash table"],
  questionContent:
    "Given an array of integers nums and an integer target, return indices of the two numbers such that they add up to target.",
  examples: [
    { number: 1, input: "nums = [2,7,11,15], target = 9", output: "[0,1]" },
  ],
  constraints: ["2 <= nums.length <= 10^4"],
};

// --- shared cloud -----------------------------------------------------------

const storedCloud = localStorage.getItem("qa_notion");
const notion = createNotionMock(
  storedCloud ? JSON.parse(storedCloud) : undefined,
  (state) => localStorage.setItem("qa_notion", JSON.stringify(state)),
);

// --- this machine's chrome --------------------------------------------------

const profileKey = `qa_profile_${profile}`;
const localData = JSON.parse(localStorage.getItem(profileKey) || "{}");
const syncData = {
  notionApiKey: "secret_qa_key",
  notionDatabaseId: "qa-database-0001",
  spacedRepetitionDays: 30,
};
const bus = { listeners: [] };
const syncSetLog = [];

// Pre-seed draft scenarios BEFORE popup.js reads storage.
if (auto === "stale-draft" || auto === "fresh-draft") {
  const page = notion.pageByNumber(1);
  const pageEdited = page ? Date.parse(page.last_edited_time) : Date.now();
  const stale = auto === "stale-draft";
  localData["form_state_1"] = {
    notes: stale ? "stale draft notes (should LOSE to Notion)" : "fresh draft notes (should WIN over Notion)",
    remark: stale ? "stale draft remark" : "fresh draft remark",
    altMethods: "",
    timeComplexity: "O(n²)",
    spaceComplexity: "",
    done: true,
    expertise: "Low",
    tags: [],
    timestamp: stale ? pageEdited - 3600_000 : Date.now() + 3600_000,
  };
}

window.chrome = createChromeMock({
  bus,
  localData,
  syncData,
  syncSetLog,
  problemFixture: FIXTURE,
  tabUrl: FIXTURE.url,
  onLocalMutate: () =>
    localStorage.setItem(profileKey, JSON.stringify(localData)),
});
localStorage.setItem(profileKey, JSON.stringify(localData));

const realFetch = window.fetch.bind(window);
window.fetch = createNotionFetch(notion, realFetch);

window.__qaEnv = {
  profile,
  notion,
  localData,
  syncData,
  syncSetLog,
  parseSolutionsFromPage,
  parseNotesFromPage,
  jsonClone,
  cloudSummary() {
    const page = notion.pageByNumber(1);
    return page
      ? {
          pageId: page.id,
          lastEdited: page.last_edited_time,
          solutions: parseSolutionsFromPage(page).map((s) => ({
            heading: s.heading,
            caption: s.caption,
            firstLine: s.code.split("\n")[0],
            lines: s.code.split("\n").length,
          })),
          notes: parseNotesFromPage(page),
          attempts: page.properties.Attempts?.number,
        }
      : null;
  },
};

// --- harness chrome (ribbon) ------------------------------------------------

function addRibbon() {
  const bar = document.createElement("div");
  bar.id = "qa-ribbon";
  const scenario =
    {
      seed: "seeding 2 snapshots + notes, then Save",
      update: 'pressing "Update in Notion" with hydrated state',
      "stale-draft": "stale local draft vs newer Notion page",
      "fresh-draft": "fresh local draft vs older Notion page",
    }[auto] || "popup open (hydration on load)";
  bar.textContent = `QA harness — machine/profile ${profile} — ${scenario} — Notion mocked in-page`;
  bar.style.cssText =
    "position:sticky;top:0;z-index:99999;background:#4f46e5;color:#fff;" +
    "font:600 11px/1.6 system-ui,sans-serif;padding:4px 10px;letter-spacing:.02em;";
  document.body.prepend(bar);
}

// --- auto-drive -------------------------------------------------------------

function waitUntil(fn, timeoutMs = 15000, everyMs = 50) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const timer = setInterval(() => {
      let ok = false;
      try {
        ok = fn();
      } catch {
        ok = false;
      }
      if (ok) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - t0 > timeoutMs) {
        clearInterval(timer);
        reject(new Error("waitUntil timeout"));
      }
    }, everyMs);
  });
}

const statusText = () =>
  document.getElementById("save-status")?.textContent || "";

async function autoDrive() {
  const done = (label) => {
    window.__qaAutoDone = label;
    console.log(`[qa-harness] auto=${label} done`);
  };

  if (auto === "seed") {
    await waitUntil(
      () => document.getElementById("problem-title")?.textContent === "Two Sum",
    );
    // Snapshot 1 (current editor code), then "edit" the code and snapshot 2.
    document.getElementById("btn-snapshot").click();
    await waitUntil(
      () => document.getElementById("snapshot-count")?.textContent === "1",
    );
    (0, eval)("problemData.code = " + JSON.stringify(CODE_A2) + ";");
    document.getElementById("btn-snapshot").click();
    await waitUntil(
      () => document.getElementById("snapshot-count")?.textContent === "2",
    );
    document.getElementById("input-notes").value = "A notes";
    document.getElementById("input-remark").value = "A remark";
    document.getElementById("input-time-complexity").value = "O(n)";
    document.getElementById("input-space-complexity").value = "O(1)";
    document.querySelector('[data-expertise="High"]')?.click();
    document.getElementById("btn-save").click();
    await waitUntil(() => statusText().includes("Saved to Notion"));
    done("seed");
    return;
  }

  if (auto === "update") {
    await waitUntil(
      () => document.getElementById("snapshot-count")?.textContent === "2",
    );
    document.getElementById("btn-save").click();
    await waitUntil(() => statusText().includes("Updated"));
    done("update");
    return;
  }

  if (auto === "stale-draft" || auto === "fresh-draft") {
    await waitUntil(() => statusText().length > 0);
    done(auto);
    return;
  }

  // plain load: wait for the existing-entry check to settle when a page exists
  if (notion.pageByNumber(1)) {
    await waitUntil(() => statusText().length > 0);
  }
  done("load");
}

document.addEventListener("DOMContentLoaded", () => {
  if (params.has("inspect")) {
    // Evidence mode: render the mock Notion cloud state instead of the popup.
    document.body.innerHTML = "";
    const h = document.createElement("div");
    h.textContent = "QA harness — mock Notion cloud state (shared across profiles)";
    h.style.cssText =
      "background:#4f46e5;color:#fff;font:600 13px system-ui;padding:8px 12px;";
    const pre = document.createElement("pre");
    pre.textContent = JSON.stringify(window.__qaEnv.cloudSummary(), null, 2);
    pre.style.cssText =
      "font:12px/1.5 Consolas,monospace;padding:16px;white-space:pre-wrap;" +
      "background:#fff;color:#111;margin:0;";
    document.body.append(h, pre);
    document.body.style.background = "#fff";
    window.__qaAutoDone = "inspect";
    return;
  }
  addRibbon();
  if (params.has("expand")) {
    // Evidence mode: un-constrain the popup's internal scroll container so a
    // tall headless window captures the whole form + snapshot list at once.
    const style = document.createElement("style");
    style.textContent =
      "body{height:auto !important;} .main-content{overflow-y:visible !important;}";
    document.head.appendChild(style);
  }
  autoDrive()
    .then(() => {
      const scrollTo = params.get("scroll");
      if (scrollTo) document.getElementById(scrollTo)?.scrollIntoView();
    })
    .catch((e) => {
      console.error("[qa-harness] auto-drive failed:", e);
      window.__qaAutoDone = `ERROR: ${e.message}`;
    });
});
