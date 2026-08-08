/**
 * super-board QA harness — issue #1, popup layer.
 *
 * Injected BEFORE the real popup.js. Provides a faithful `chrome.*` stub plus
 * a fake background whose message contract mirrors the REAL background.js
 * behavior verified by the Node layer (background.qa.test.mjs):
 *   - saveToNotion: existing page + incrementAttempts → attempts+1 returned;
 *     incrementAttempts=false → no attempts key in response; create → attempts 1.
 *   - updateAttempts: attempts+1, Spaced Repetition untouched.
 *   - updateSpacedRepetition: sets date; sets attempts only when provided.
 *
 * Test hooks on window.__qa:
 *   messages                — ordered log of every runtime.sendMessage payload
 *   notion                  — fake server-side state {attempts, spacedRepDate,...}
 *   failNextUpdateAttempts  — one-shot: next updateAttempts → {success:false}
 *   failNextSave            — one-shot: next saveToNotion → {success:false}
 *
 * Query params: ?new=1 → problem does not exist yet (first-save scenario).
 */
(() => {
  const params = new URLSearchParams(location.search);
  const NEW_PROBLEM = params.get("new") === "1";

  // Fake Notion attempts survive popup reloads (sessionStorage) so the
  // "close and reopen the popup, update again = +1 more" scenario is
  // observable end-to-end. ?reset=1 clears it.
  if (params.get("reset") === "1") sessionStorage.removeItem("qaAttempts");
  const storedAttempts = sessionStorage.getItem("qaAttempts");

  const qa = {
    messages: [],
    notion: {
      exists: !NEW_PROBLEM,
      pageId: NEW_PROBLEM ? null : "qa-page-1",
      attempts: NEW_PROBLEM ? 0 : storedAttempts !== null ? Number(storedAttempts) : 3,
      spacedRepDate: "2026-08-20",
      tags: ["Array", "Hash Table"],
      expertise: "Medium",
      timeComplexity: "O(n)",
      spaceComplexity: "O(n)",
      hasQuestion: false,
    },
    failNextUpdateAttempts: false,
    failNextSave: false,
  };
  window.__qa = qa;

  const syncStore = {
    notionApiKey: "qa-test-key",
    notionDatabaseId: "qa-db-1",
    spacedRepetitionDays: 30,
  };
  const localStore = {};

  function pick(keys, store) {
    const out = {};
    const list = Array.isArray(keys) ? keys : typeof keys === "string" ? [keys] : Object.keys(store);
    for (const k of list) if (k in store) out[k] = JSON.parse(JSON.stringify(store[k]));
    return out;
  }

  function setAttempts(n) {
    qa.notion.attempts = n;
    sessionStorage.setItem("qaAttempts", String(n));
  }

  async function fakeBackground(msg) {
    qa.messages.push(JSON.parse(JSON.stringify(msg)));
    const d = msg.data || {};
    switch (msg.action) {
      case "checkExisting":
        if (!qa.notion.exists) return { exists: false };
        return {
          exists: true,
          pageId: qa.notion.pageId,
          attempts: qa.notion.attempts,
          tags: qa.notion.tags,
          expertise: qa.notion.expertise,
          remark: "",
          notes: "",
          altMethods: [],
          done: true,
          timeComplexity: qa.notion.timeComplexity,
          spaceComplexity: qa.notion.spaceComplexity,
          hasQuestion: qa.notion.hasQuestion,
        };
      case "saveToNotion": {
        if (qa.failNextSave) {
          qa.failNextSave = false;
          return { success: false, error: "QA forced save failure" };
        }
        if (d.existingPageId) {
          const res = { success: true, pageId: d.existingPageId, updated: true, contentUpdated: true };
          if (d.incrementAttempts) {
            setAttempts(qa.notion.attempts + 1); // server-fresh read+1 (mirrors verified backend)
            res.attempts = qa.notion.attempts;
          }
          return res;
        }
        qa.notion.exists = true;
        qa.notion.pageId = "qa-page-new";
        setAttempts(1);
        return { success: true, pageId: "qa-page-new", updated: false, contentUpdated: true, attempts: 1 };
      }
      case "updateAttempts": {
        if (qa.failNextUpdateAttempts) {
          qa.failNextUpdateAttempts = false;
          return { success: false, error: "QA forced +1 failure (Notion 500)" };
        }
        // Mirrors background.js: an explicit `attempts` sets that exact value
        // (hand-typed), omitting it increments. spacedRepDate NOT touched.
        setAttempts(
          typeof d.attempts === "number"
            ? Math.max(0, Math.floor(d.attempts))
            : qa.notion.attempts + 1,
        );
        return { success: true, attempts: qa.notion.attempts };
      }
      case "updateSpacedRepetition": {
        const date = new Date();
        date.setDate(date.getDate() + (d.days || 0));
        qa.notion.spacedRepDate = date.toISOString().split("T")[0];
        if (d.attempts !== undefined) setAttempts(d.attempts);
        return { success: true, date: qa.notion.spacedRepDate };
      }
      case "getStats":
        return { success: true, stats: { total: 1, easy: 1, medium: 0, hard: 0, dueReview: 0 } };
      default:
        return { success: false, error: "Unknown action: " + msg.action };
    }
  }

  // Auto-demo driver for headless screenshot capture:
  //   ?demo=fail-plus → after init, force the next +1 to fail (AC7 rollback +
  //   error-status state becomes the settled frame).
  if (params.get("demo") === "fail-plus") {
    window.addEventListener("load", () => {
      setTimeout(() => {
        qa.failNextUpdateAttempts = true;
        document.getElementById("btn-attempt-plus")?.click();
      }, 700);
    });
  }

  window.chrome = {
    runtime: {
      sendMessage: (msg) => Promise.resolve().then(() => fakeBackground(msg)),
      getURL: (p) => "/" + String(p).replace(/^\//, ""),
      lastError: null,
    },
    storage: {
      sync: {
        get: async (keys) => pick(keys, syncStore),
        set: async (obj) => { Object.assign(syncStore, obj); },
      },
      local: {
        get: async (keys) => pick(keys, localStore),
        set: async (obj) => { Object.assign(localStore, obj); },
        remove: async (keys) => {
          (Array.isArray(keys) ? keys : [keys]).forEach((k) => delete localStore[k]);
        },
      },
    },
    tabs: {
      query: async () => [{ id: 1, url: "https://leetcode.com/problems/two-sum/" }],
      sendMessage: (tabId, msg, cb) => { if (typeof cb === "function") cb(undefined); },
    },
    scripting: {
      executeScript: async () => [{
        result: {
          number: 1,
          title: "Two Sum",
          difficulty: "Easy",
          code: "def twoSum(nums, target):\n    seen = {}\n    for i, n in enumerate(nums):\n        if target - n in seen:\n            return [seen[target - n], i]\n        seen[n] = i",
          language: "Python3",
          url: "https://leetcode.com/problems/two-sum/",
          scrapedTags: ["Array", "Hash Table"],
          userAttempts: null,
          // NOTE: popup.js treats questionContent as a plain string (popup.js:728 indexOf)
          questionContent:
            "Given an array of integers nums and an integer target, return indices of the two numbers such that they add up to target. Example 1: Input: nums = [2,7,11,15], target = 9 Output: [0,1]",
          examples: [{ input: "nums = [2,7,11,15], target = 9", output: "[0,1]" }],
          constraints: ["2 <= nums.length <= 10^4"],
        },
      }],
    },
  };
})();
