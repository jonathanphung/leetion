/**
 * Builds a browser-loadable preview of the REAL popup for screenshot evidence.
 *
 * The markup is popup.html verbatim, the CSS is styles.css, and the rendering
 * is done by the real popup.js — only the `chrome.*` extension APIs are stubbed
 * (they do not exist outside an extension context). So the Submissions row in
 * the screenshots is drawn by the shipped `showSubmissionsControl` /
 * `updateSubmissionDisplay` code paths, not by a mock-up.
 *
 * Serve the repo root over HTTP and open  /docs/.../preview/popup-<state>.html
 *
 * Usage (from the repo root):
 *   node docs/super-board/runs/issue-5-qa-v1/harness/make-preview.js
 */

const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "../../../../..");
const outDir = path.join(__dirname, "..", "preview");
fs.mkdirSync(outDir, { recursive: true });

const popupHtml = fs.readFileSync(path.join(repoRoot, "popup.html"), "utf8");

/** Root-absolute asset paths so the preview works from any directory. */
const base = popupHtml
  .replace(/href="styles\.css"/g, 'href="/styles.css"')
  .replace(/src="popup\.js"/g, 'src="/popup.js"')
  .replace(/src="icons\//g, 'src="/icons/');

/**
 * @param {Object} o
 *   tabUrl   - URL chrome.tabs.query reports
 *   notion   - value of the Submissions property in Notion (null = never synced)
 *   click    - when set, the preview clicks "Sync submissions" and the content
 *              script double replies with this object
 */
function stub(o) {
  return `
<script>
(() => {
  const problem = {
    number: 1, question: "Two Sum", title: "Two Sum", difficulty: "Easy",
    code: "", language: "", url: ${JSON.stringify(o.tabUrl)},
    scrapedTags: [], userAttempts: null, questionContent: null,
    examples: [], constraints: [],
  };
  const store = { sync: { notionApiKey: "secret_preview", notionDatabaseId: "db" }, local: {} };
  const pick = (s, k) => { if (!k) return {...s}; const out = {}; (Array.isArray(k)?k:[k]).forEach(x => { if (x in s) out[x] = s[x]; }); return out; };
  window.chrome = {
    runtime: {
      getURL: p => p, lastError: null, onMessage: { addListener() {} },
      sendMessage: async (msg) => {
        if (msg.action === "checkExisting") return {
          exists: true, pageId: "page-preview", attempts: 3,
          submissions: ${JSON.stringify(o.notion)}, remoteSnapshots: [],
          lastEdited: Date.now(), hasQuestion: false,
          timeComplexity: "", spaceComplexity: "",
        };
        if (msg.action === "updateSubmissions") return { success: true, count: msg.data.count };
        return { success: true };
      },
    },
    tabs: {
      query: async () => [{ id: 1, url: ${JSON.stringify(o.tabUrl)} }],
      sendMessage: async () => (${JSON.stringify(o.click || { success: false })}),
      create() {},
    },
    scripting: { executeScript: async () => [{ result: problem }] },
    storage: {
      sync: { get: async k => pick(store.sync, k), set: async o => Object.assign(store.sync, o), remove: async () => {} },
      local: { get: async k => pick(store.local, k), set: async o => Object.assign(store.local, o), remove: async () => {} },
    },
    alarms: { create() {}, onAlarm: { addListener() {} } },
    notifications: { create() {}, onClicked: { addListener() {} } },
    action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
  };

  // After the real popup has initialised, optionally exercise the sync action
  // and trim the long lower cards so the Submissions row is in frame.
  window.addEventListener("load", () => setTimeout(async () => {
    ${o.click ? 'await document.getElementById("btn-sync-submissions").click();' : ""}
    setTimeout(() => {
      ["card-question","card-code","card-snapshots","card-tags","card-complexity",
       "card-expertise","card-notes","card-remark","card-alt-methods"]
        .forEach(id => { const e = document.getElementById(id); if (e) e.style.display = "none"; });
      document.title = "ready";
    }, 250);
  }, 150));
})();
</script>`;
}

const states = {
  "never-synced": { tabUrl: "https://leetcode.com/problems/two-sum/", notion: null },
  "from-notion": { tabUrl: "https://leetcode.com/problems/two-sum/", notion: 17 },
  synced: {
    tabUrl: "https://leetcode.com/problems/two-sum/",
    notion: 17,
    click: { success: true, signedIn: true, count: 23, capped: false, slug: "two-sum" },
  },
  capped: {
    tabUrl: "https://leetcode.com/problems/two-sum/",
    notion: null,
    click: { success: true, signedIn: true, count: 100, capped: true, slug: "two-sum" },
  },
  "logged-out": {
    tabUrl: "https://leetcode.com/problems/two-sum/",
    notion: 17,
    click: { success: false, signedIn: false, error: "Log in to LeetCode to sync submissions." },
  },
  "leetcode-cn": { tabUrl: "https://leetcode.cn/problems/two-sum/", notion: 17 },
};

for (const [name, cfg] of Object.entries(states)) {
  const html = base.replace("</body>", `${stub(cfg)}\n</body>`);
  fs.writeFileSync(path.join(outDir, `popup-${name}.html`), html);
  console.log(`wrote preview/popup-${name}.html`);
}
