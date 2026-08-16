/**
 * Leetion Popup Script
 *
 * Main controller for the Chrome extension popup interface.
 * Handles UI interactions, data scraping, and communication with background script.
 *
 * @author Leetion
 * @version 1.1.5
 */

// CONFIGURATION & CONSTANTS

/**
 * Maps LeetCode tag names to our standardized tag names.
 * Used for auto-selecting tags when scraping from the problem page.
 */
const TAG_MAPPING = {
  array: "Arrays",
  "hash table": "Hashing",
  "hash-table": "Hashing",
  hashtable: "Hashing",
  "two pointers": "Two Pointers",
  "two-pointers": "Two Pointers",
  "sliding window": "Sliding Window",
  "sliding-window": "Sliding Window",
  "binary search": "Binary Search",
  "binary-search": "Binary Search",
  stack: "Stack",
  "linked list": "Linked List",
  "linked-list": "Linked List",
  tree: "Trees",
  "binary tree": "Trees",
  "binary-tree": "Trees",
  heap: "Heap",
  "priority queue": "Heap",
  "priority-queue": "Heap",
  backtracking: "Backtracking",
  graph: "Graphs",
  "depth-first search": "Graphs",
  "breadth-first search": "Graphs",
  dfs: "Graphs",
  bfs: "Graphs",
  "dynamic programming": "Dynamic Programming",
  "dynamic-programming": "Dynamic Programming",
  dp: "Dynamic Programming",
  greedy: "Greedy",
  interval: "Intervals",
  intervals: "Intervals",
  math: "Math",
  "bit manipulation": "Bit Manipulation",
  "bit-manipulation": "Bit Manipulation",
  string: "String",
  recursion: "Recursion",
  sorting: "Sorting",
  sort: "Sorting",
  matrix: "Matrix",
};

/**
 * Expertise levels that own their own spaced-repetition interval.
 * Order matters: it drives the settings inputs and the storage object.
 */
const EXPERTISE_LEVELS = ["Low", "Medium", "High"];

/**
 * Default review interval (in days) per expertise level.
 * Lower expertise => sooner review.
 */
const DEFAULT_REVIEW_INTERVALS = { Low: 1, Medium: 3, High: 7 };

/** Storage key holding the per-expertise intervals object. */
const INTERVALS_KEY = "spacedRepetitionIntervals";

/** Legacy storage key: a single flat interval used before per-expertise intervals. */
const LEGACY_INTERVAL_KEY = "spacedRepetitionDays";

/** Upper bound for a stored interval, mirrors the settings inputs' max. */
const MAX_INTERVAL_DAYS = 365;

// APPLICATION STATE

/** @type {Object} Current problem data from LeetCode */
let problemData = {
  number: null,
  question: null,
  title: null,
  difficulty: null,
  code: null,
  language: null,
  url: null,
  scrapedTags: [],
  userAttempts: null,
  questionContent: null,
  examples: [],
  constraints: [],
};

/** @type {string[]} Currently selected tags */
let selectedTags = [];

/** @type {string} Current expertise level */
let selectedExpertise = "Medium";

/** @type {string|null} Existing Notion page ID */
let existingPageId = null;

/** @type {string} Current view name */
let currentView = "not-leetcode";

/** @type {string} Previous view for back navigation */
let previousView = "not-leetcode";

/** Upper bound for a hand-entered attempt count; matches the input's max. */
const ATTEMPTS_MAX = 9999;

/** @type {number} Attempt count as last known from Notion */
let userAttemptCount = 0;

/**
 * @type {number|null} Attempt count staged by the user, or null if untouched.
 * Both the editable field and the "+" button write here only — nothing about
 * Attempts reaches Notion until "Update in Notion" is pressed. On save this
 * value is sent verbatim and the automatic increment is suppressed, so a
 * staged edit can never be double-counted.
 */
let pendingAttempts = null;

/**
 * @type {boolean} Whether this popup session already incremented Attempts.
 * "Update in Notion" adds +1 once per popup session — repeat updates in the
 * same session (e.g. fixing a typo in notes) must not add more.
 */
let attemptSessionIncremented = false;

/**
 * @type {boolean} Whether the Notion row has no "Date (of first attempt)".
 * True for a row created by "Mark to-do" (queued, never attempted) and for
 * any pre-existing row Notion reports the property empty on. The background
 * only writes that date when creating a page, so the next "Update in Notion"
 * carries this flag to backfill it — otherwise a to-do row would stay dateless
 * forever.
 */
let firstAttemptDateMissing = false;

/**
 * @type {"save"|"todo"} Which action opened the missing-columns confirmation.
 * "Add columns & save" must resume the action the user actually started — a
 * to-do create must not fall through to a full save (which would write
 * Attempts = 1 and today's first-attempt date).
 */
let pendingSchemaAction = "save";

// DOM ELEMENT REFERENCES

const DOM = {
  views: {
    notLeetcode: document.getElementById("view-not-leetcode"),
    settings: document.getElementById("view-settings"),
    main: document.getElementById("view-main"),
  },
  settings: {
    apiKeyInput: document.getElementById("input-api-key"),
    databaseIdInput: document.getElementById("input-database-id"),
    intervalInputs: {
      Low: document.getElementById("input-interval-low"),
      Medium: document.getElementById("input-interval-medium"),
      High: document.getElementById("input-interval-high"),
    },
    toggleApiKeyBtn: document.getElementById("btn-toggle-api-key"),
    toggleDbIdBtn: document.getElementById("btn-toggle-db-id"),
    saveBtn: document.getElementById("btn-save-settings"),
    status: document.getElementById("settings-status"),
    runSetupBtn: document.getElementById("btn-run-setup"),
  },
  nav: {
    settingsEmpty: document.getElementById("btn-settings-empty"),
    settingsMain: document.getElementById("btn-settings-main"),
    back: document.getElementById("btn-back"),
    drawing: document.getElementById("btn-drawing"),
  },
  problem: {
    number: document.getElementById("problem-number"),
    title: document.getElementById("problem-title"),
    difficulty: document.getElementById("problem-difficulty"),
    codePreview: document.getElementById("code-preview"),
    codeLanguage: document.getElementById("code-language"),
    refreshBtn: document.getElementById("btn-refresh-code"),
    questionPreview: document.getElementById("question-preview"),
    statsContainer: document.getElementById("problem-stats"),
    statAcceptance: document.getElementById("stat-acceptance"),
    statSubmissions: document.getElementById("stat-submissions"),
    statAttempts: document.getElementById("stat-attempts"),
    // Empty/filled state containers
    codeEmpty: document.getElementById("code-empty"),
    codeFilled: document.getElementById("code-filled"),
    questionEmpty: document.getElementById("question-empty"),
    questionFilled: document.getElementById("question-filled"),
    refreshCodeEmptyBtn: document.getElementById("btn-refresh-code-empty"),
    refreshQuestionBtn: document.getElementById("btn-refresh-question"),
    refreshQuestionEmptyBtn: document.getElementById(
      "btn-refresh-question-empty",
    ),
    markTodoBtn: document.getElementById("btn-mark-todo"),
    saveQuestionToggle: document.getElementById("input-save-question"),
    codeDetectedIcon: document.getElementById("code-detected-icon"),
    cardCode: document.getElementById("card-code"),
  },
  snapshots: {
    btn: document.getElementById("btn-snapshot"),
    list: document.getElementById("snapshots-list"),
    count: document.getElementById("snapshot-count"),
  },
  quickActions: {
    card: document.getElementById("card-quick-actions"),
    markReview: document.getElementById("btn-mark-review"),
    revisit: document.getElementById("btn-revisit"),
    spacedRepetition: document.getElementById("input-spaced-repetition"),
    spacedRepetitionHint: document.getElementById("spaced-repetition-hint"),
  },
  attempts: {
    control: document.getElementById("attempts-control"),
    input: document.getElementById("input-attempts"),
    plus: document.getElementById("btn-attempt-plus"),
  },
  complexity: {
    time: document.getElementById("input-time-complexity"),
    space: document.getElementById("input-space-complexity"),
    suggestion: document.getElementById("complexity-suggestion"),
  },
  form: {
    tagsContainer: document.getElementById("tags-container"),
    notes: document.getElementById("input-notes"),
    remark: document.getElementById("input-remark"),
    altMethods: document.getElementById("input-alt-methods"),
    done: document.getElementById("input-done"),
  },
  save: {
    btn: document.getElementById("btn-save"),
    status: document.getElementById("save-status"),
    schemaConfirm: document.getElementById("schema-confirm"),
    schemaList: document.getElementById("schema-confirm-list"),
    schemaCreateBtn: document.getElementById("btn-schema-create"),
    schemaCancelBtn: document.getElementById("btn-schema-cancel"),
  },
  stats: {
    modal: document.getElementById("stats-modal"),
    openBtn: document.getElementById("btn-stats"),
    closeBtn: document.getElementById("btn-close-stats"),
    content: document.getElementById("stats-content"),
    loading: document.getElementById("stats-loading"),
    error: document.getElementById("stats-error"),
    total: document.getElementById("stat-total"),
    easy: document.getElementById("stat-easy"),
    medium: document.getElementById("stat-medium"),
    hard: document.getElementById("stat-hard"),
    dueReview: document.getElementById("stat-due-review"),
  },
};

/** @type {Array} Code snapshots for current problem */
let codeSnapshots = [];

// VIEW MANAGEMENT

/**
 * Shows the specified view and hides all others.
 * @param {string} viewName - View to show ('not-leetcode', 'settings', 'main')
 */
function showView(viewName) {
  previousView = currentView;
  currentView = viewName;

  Object.values(DOM.views).forEach((view) => {
    if (view) view.classList.add("hidden");
  });

  const viewMap = {
    "not-leetcode": DOM.views.notLeetcode,
    settings: DOM.views.settings,
    main: DOM.views.main,
  };

  if (viewMap[viewName]) {
    viewMap[viewName].classList.remove("hidden");
  }
}

// INITIALIZATION

document.addEventListener("DOMContentLoaded", async () => {
  await loadSettings();
  await checkCurrentTab();
  setupEventListeners();
});

// SPACED REPETITION INTERVALS

/**
 * Coerces a stored or user-entered interval into a whole number of days.
 * @param {*} value - Raw value from storage or an input element
 * @returns {number|null} Sanitized day count, or null when unusable
 */
function sanitizeInterval(value) {
  if (value === null || value === undefined || value === "") return null;
  const days = Math.floor(Number(value));
  if (!Number.isFinite(days) || days < 0) return null;
  return Math.min(days, MAX_INTERVAL_DAYS);
}

/**
 * Resolves the per-expertise review intervals from a settings object.
 *
 * Migration rule: a profile that only carries the legacy flat
 * `spacedRepetitionDays` scalar seeds ALL THREE levels with that scalar, so an
 * upgrade never silently changes an existing user's cadence — including the
 * deliberate "0 = disabled" case. Fresh profiles get the 1/3/7 defaults.
 *
 * @param {Object} [settings] - Result of chrome.storage.sync.get
 * @returns {{Low: number, Medium: number, High: number}} Intervals in days
 */
function resolveReviewIntervals(settings = {}) {
  const stored = settings[INTERVALS_KEY];
  const legacy = sanitizeInterval(settings[LEGACY_INTERVAL_KEY]);
  const intervals = {};

  EXPERTISE_LEVELS.forEach((level) => {
    const storedDays =
      stored && typeof stored === "object"
        ? sanitizeInterval(stored[level])
        : null;

    if (storedDays !== null) {
      intervals[level] = storedDays;
    } else if (legacy !== null) {
      intervals[level] = legacy;
    } else {
      intervals[level] = DEFAULT_REVIEW_INTERVALS[level];
    }
  });

  return intervals;
}

/**
 * Picks the review interval for an expertise level.
 * Unknown levels fall back to Medium so a save never loses its review date.
 * @param {Object} intervals - Map returned by resolveReviewIntervals
 * @param {string} expertise - "Low" | "Medium" | "High"
 * @returns {number} Days until the next review (0 = disabled for this level)
 */
function intervalForExpertise(intervals, expertise) {
  const days = sanitizeInterval(intervals?.[expertise]);
  if (days !== null) return days;
  return sanitizeInterval(intervals?.Medium) ?? DEFAULT_REVIEW_INTERVALS.Medium;
}

/**
 * Loads saved settings from Chrome storage.
 */
async function loadSettings() {
  try {
    const result = await chrome.storage.sync.get([
      "notionApiKey",
      "notionDatabaseId",
      INTERVALS_KEY,
      LEGACY_INTERVAL_KEY,
    ]);
    if (result.notionApiKey)
      DOM.settings.apiKeyInput.value = result.notionApiKey;
    if (result.notionDatabaseId)
      DOM.settings.databaseIdInput.value = result.notionDatabaseId;

    const intervals = resolveReviewIntervals(result);
    EXPERTISE_LEVELS.forEach((level) => {
      const input = DOM.settings.intervalInputs[level];
      if (input) input.value = intervals[level];
    });
  } catch (error) {
    console.error("Error loading settings:", error);
  }
}

/**
 * Loads persisted form state for a problem.
 * @param {number} problemNumber - Problem number
 */
async function loadPersistedFormState(problemNumber) {
  if (!problemNumber) return;

  try {
    const key = `form_state_${problemNumber}`;
    const result = await chrome.storage.local.get([key]);
    const state = result[key];

    if (state) {
      if (state.notes) DOM.form.notes.value = state.notes;
      if (state.remark) DOM.form.remark.value = state.remark;
      if (state.altMethods) DOM.form.altMethods.value = state.altMethods;
      if (state.timeComplexity)
        DOM.complexity.time.value = state.timeComplexity;
      if (state.spaceComplexity)
        DOM.complexity.space.value = state.spaceComplexity;
      if (typeof state.done === "boolean") DOM.form.done.checked = state.done;

      if (state.expertise) {
        selectedExpertise = state.expertise;
        document.querySelectorAll(".expertise-btn").forEach((btn) => {
          btn.classList.remove(
            "selected-low",
            "selected-medium",
            "selected-high",
          );
          if (btn.dataset.expertise === state.expertise) {
            btn.classList.add(`selected-${state.expertise.toLowerCase()}`);
          }
        });
      }

      if (state.tags?.length) {
        state.tags.forEach((tag) => {
          if (!selectedTags.includes(tag)) {
            selectedTags.push(tag);
            const btn = document.querySelector(`[data-tag="${tag}"]`);
            if (btn) btn.classList.add("selected");
          }
        });
      }

      console.log("Leetion: Restored form state for problem", problemNumber);
    }
  } catch (error) {
    console.error("Error loading form state:", error);
  }
}

/**
 * Persists current form state for a problem.
 */
async function persistFormState() {
  if (!problemData.number) return;

  try {
    const key = `form_state_${problemData.number}`;
    const state = {
      notes: DOM.form.notes.value,
      remark: DOM.form.remark.value,
      altMethods: DOM.form.altMethods.value,
      timeComplexity: DOM.complexity.time.value,
      spaceComplexity: DOM.complexity.space.value,
      done: DOM.form.done.checked,
      expertise: selectedExpertise,
      tags: selectedTags,
      timestamp: Date.now(),
    };

    await chrome.storage.local.set({ [key]: state });
  } catch (error) {
    console.error("Error persisting form state:", error);
  }
}

/**
 * Clears persisted form state for a problem.
 * @param {number} problemNumber - Problem number
 */
async function clearPersistedFormState(problemNumber) {
  if (!problemNumber) return;

  try {
    const key = `form_state_${problemNumber}`;
    await chrome.storage.local.remove([key]);
  } catch (error) {
    console.error("Error clearing form state:", error);
  }
}

/**
 * Checks if current tab is a LeetCode problem page.
 */
async function checkCurrentTab() {
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    const url = tab?.url || "";
    const isLeetCode =
      url.includes("leetcode.com/problems/") ||
      url.includes("leetcode.cn/problems/");

    if (isLeetCode) {
      showView("main");
      await scrapeProblemData(tab.id);
    } else {
      showView("not-leetcode");
    }
  } catch (error) {
    console.error("Error checking tab:", error);
    showView("not-leetcode");
  }
}

// DATA SCRAPING

/**
 * Scrapes problem data from the LeetCode page.
 * @param {number} tabId - Chrome tab ID
 */
async function scrapeProblemData(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: extractProblemDataFromPage,
      world: "MAIN",
    });

    if (results?.[0]?.result) {
      problemData = results[0].result;
      updateProblemUI();
      autoSelectScrapedTags(problemData.scrapedTags);

      await loadSnapshots(problemData.number);
      await loadPersistedFormState(problemData.number);

      await checkExistingEntry();
    }
  } catch (error) {
    console.error("Error scraping:", error);
  }
}

/**
 * Refreshes problem data from the page.
 */
async function refreshData() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await scrapeProblemData(tab.id);
}

/**
 * Injected function to extract problem data from page.
 * @returns {Object} Problem data
 */
function extractProblemDataFromPage() {
  const data = {
    number: null,
    title: null,
    difficulty: null,
    code: null,
    language: null,
    url: window.location.href,
    scrapedTags: [],
    questionContent: null,
    examples: [],
    constraints: [],
  };

  // Extract title/number
  const titleSelectors = [
    '[data-cy="question-title"]',
    'a[href*="/problems/"][class*="text-title-large"]',
    'div[class*="text-title-large"]',
  ];

  for (const sel of titleSelectors) {
    const el = document.querySelector(sel);
    if (el) {
      const match = el.textContent.trim().match(/^(\d+)\.\s*(.+)$/);
      if (match) {
        data.number = parseInt(match[1]);
        data.title = match[2];
        break;
      }
    }
  }

  // Fallback to document title
  if (!data.number) {
    const match = document.title.match(/^(\d+)\.\s*([^-|]+)/);
    if (match) {
      data.number = parseInt(match[1]);
      data.title = match[2].trim();
    }
  }

  // Extract difficulty
  const diffMap = { easy: "Easy", medium: "Medium", hard: "Hard" };
  const diffSelectors = [
    'div[class*="text-difficulty-easy"]',
    'div[class*="text-difficulty-medium"]',
    'div[class*="text-difficulty-hard"]',
    'div[class*="text-olive"]',
    'div[class*="text-yellow"]',
    'div[class*="text-pink"]',
  ];

  for (const sel of diffSelectors) {
    const el = document.querySelector(sel);
    if (el) {
      const text = el.textContent.toLowerCase().trim();
      for (const [key, val] of Object.entries(diffMap)) {
        if (text.includes(key) || sel.includes(key)) {
          data.difficulty = val;
          break;
        }
      }
      if (data.difficulty) break;
    }
  }

  // Extract code via Monaco
  try {
    const models = monaco.editor.getModels();
    if (models && models.length > 0) {
      for (const model of models) {
        const value = model.getValue();
        if (value && value.length > 10) {
          data.code = value;
          console.log(
            "Leetion: Got code via monaco.editor.getModels(), length:",
            value.length,
          );
          break;
        }
      }
    }
  } catch (e) {
    console.log("Leetion: monaco.editor.getModels() failed:", e);
  }

  // Fallback: DOM scraping
  if (!data.code) {
    const linesContent = document.querySelector(".monaco-editor .view-lines");
    if (linesContent) {
      const lines = linesContent.querySelectorAll(".view-line");
      const lineData = Array.from(lines).map((line) => {
        const style = line.getAttribute("style") || "";
        const topMatch = style.match(/top:\s*([\d.]+)px/);
        const top = topMatch ? parseFloat(topMatch[1]) : 0;

        let text = line.innerText || "";
        text = text.replace(
          /[\u00A0\u1680\u180E\u2000-\u200B\u202F\u205F\u3000\uFEFF]/g,
          " ",
        );
        text = text.replace(/·/g, " ");
        text = text.replace(/[\u200B\u200C\u200D]/g, "");

        return { top, text };
      });

      lineData.sort((a, b) => a.top - b.top);
      data.code = lineData.map((l) => l.text).join("\n");
      console.log(
        "Leetion: Got code via DOM fallback (may be incomplete), lines:",
        lineData.length,
      );
    }
  }

  // Extract language
  const languages = [
    "Python3",
    "Python",
    "JavaScript",
    "TypeScript",
    "Java",
    "C++",
    "C",
    "C#",
    "Go",
    "Ruby",
    "Swift",
    "Kotlin",
    "Rust",
    "Scala",
  ];
  for (const btn of document.querySelectorAll('button, div[role="button"]')) {
    if (languages.includes(btn.textContent.trim())) {
      data.language = btn.textContent.trim();
      break;
    }
  }
  if (!data.language) data.language = "Python3";

  // Extract tags
  document
    .querySelectorAll('a[href*="/tag/"], a[href*="/topics/"]')
    .forEach((el) => {
      const t = el.textContent.trim();
      if (t && t.length > 1 && t.length < 30 && !data.scrapedTags.includes(t)) {
        data.scrapedTags.push(t);
      }
    });

  // Extract question content, examples, and constraints
  try {
    const descriptionSelectors = [
      '[data-track-load="description_content"]',
      ".elfjS",
      '[class*="question-content"]',
      ".content__u3I1",
      'div[class*="_1l1MA"]',
    ];

    let questionContainer = null;
    for (const sel of descriptionSelectors) {
      questionContainer = document.querySelector(sel);
      if (questionContainer) break;
    }

    if (questionContainer) {
      const fullText = questionContainer.innerText;
      data.questionContent = fullText;

      // Extract examples
      data.examples = [];
      const exampleRegex =
        /Example\s*(\d+):\s*\n?Input:\s*(.+?)\s*\n?Output:\s*(.+?)(?:\s*\n?Explanation:\s*(.+?))?(?=\n\s*Example|\n\s*Constraints|$)/gis;

      let match;
      while ((match = exampleRegex.exec(fullText)) !== null) {
        data.examples.push({
          number: parseInt(match[1]),
          input: match[2]?.trim(),
          output: match[3]?.trim(),
          explanation: match[4]?.trim() || null,
        });
      }

      // DOM-based fallback
      if (data.examples.length === 0) {
        const preElements = questionContainer.querySelectorAll("pre");
        preElements.forEach((pre, index) => {
          const text = pre.innerText;
          const inputMatch = text.match(/Input:\s*(.+)/);
          const outputMatch = text.match(/Output:\s*(.+)/);
          const explanationMatch = text.match(/Explanation:\s*(.+)/s);

          if (inputMatch || outputMatch) {
            data.examples.push({
              number: index + 1,
              input: inputMatch ? inputMatch[1].trim() : "",
              output: outputMatch ? outputMatch[1].trim() : "",
              explanation: explanationMatch ? explanationMatch[1].trim() : null,
            });
          }
        });
      }

      // Extract constraints
      data.constraints = [];
      const constraintsMatch = fullText.match(
        /Constraints:\s*([\s\S]*?)(?=\n\s*Follow|$)/i,
      );
      if (constraintsMatch) {
        const constraintsText = constraintsMatch[1];
        const constraintLines = constraintsText
          .split(/\n|•|·/)
          .map((c) => c.trim())
          .filter((c) => c.length > 0 && !c.match(/^\s*$/));
        data.constraints = constraintLines;
      }

      if (data.constraints.length === 0) {
        const constraintsHeader = Array.from(
          questionContainer.querySelectorAll("p, strong"),
        ).find((el) => el.textContent.includes("Constraints"));

        if (constraintsHeader) {
          const nextUl =
            constraintsHeader.closest("div")?.querySelector("ul") ||
            constraintsHeader.nextElementSibling;
          if (nextUl && nextUl.tagName === "UL") {
            data.constraints = Array.from(nextUl.querySelectorAll("li")).map(
              (li) => li.innerText.trim(),
            );
          }
        }
      }

      console.log(
        "Leetion: Extracted question content, examples:",
        data.examples.length,
        "constraints:",
        data.constraints.length,
      );
    }
  } catch (e) {
    console.log("Leetion: Error extracting question details:", e);
  }

  return data;
}

/**
 * Auto-selects tags based on scraped data.
 * @param {string[]} scrapedTags - Tags from page
 */
function autoSelectScrapedTags(scrapedTags) {
  if (!scrapedTags?.length) return;

  scrapedTags.forEach((tag) => {
    const normalized = tag.toLowerCase().trim();
    const mapped = TAG_MAPPING[normalized];

    if (mapped && !selectedTags.includes(mapped)) {
      selectedTags.push(mapped);
      const btn = document.querySelector(`[data-tag="${mapped}"]`);
      if (btn) btn.classList.add("selected");
    }
  });
}

// UI UPDATES

/**
 * Updates UI with problem data.
 */
function updateProblemUI() {
  if (problemData.number)
    DOM.problem.number.textContent = `#${problemData.number}`;
  if (problemData.title) DOM.problem.title.textContent = problemData.title;

  if (problemData.difficulty) {
    DOM.problem.difficulty.textContent = problemData.difficulty;
    DOM.problem.difficulty.className =
      "difficulty-badge " + problemData.difficulty.toLowerCase();
  }

  // Handle CODE empty/filled states
  if (problemData.code) {
    DOM.problem.codeEmpty?.classList.add("hidden");
    DOM.problem.codeFilled?.classList.remove("hidden");
    DOM.problem.codeDetectedIcon?.classList.remove("hidden");
    DOM.problem.cardCode?.classList.remove("expanded"); // Collapse if code found

    const escaped = problemData.code
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    DOM.problem.codePreview.innerHTML = escaped;
  } else {
    DOM.problem.codeEmpty?.classList.remove("hidden");
    DOM.problem.codeFilled?.classList.add("hidden");
    DOM.problem.codeDetectedIcon?.classList.add("hidden");
    DOM.problem.cardCode?.classList.add("expanded"); // Expand if no code found
  }

  if (problemData.language)
    DOM.problem.codeLanguage.textContent = problemData.language;

  // Handle QUESTION empty/filled states
  if (problemData.questionContent) {
    DOM.problem.questionEmpty?.classList.add("hidden");
    DOM.problem.questionFilled?.classList.remove("hidden");

    // Display formatted question
    let html = "";

    // Get description (before examples)
    const descEnd = problemData.questionContent.indexOf("Example");
    const description =
      descEnd > 0
        ? problemData.questionContent.substring(0, descEnd).trim()
        : problemData.questionContent.substring(0, 300).trim();

    html += `<span class="section-label">Problem</span>`;
    html += `<div>${escapeHtml(description).substring(0, 200)}${description.length > 200 ? "..." : ""}</div>`;

    // Add first example if available
    if (problemData.examples?.length > 0) {
      const ex = problemData.examples[0];
      html += `<span class="section-label">Example</span>`;
      html += `<div class="example">`;
      html += `<div class="example-io">Input: ${escapeHtml(ex.input)}</div>`;
      html += `<div class="example-io">Output: ${escapeHtml(ex.output)}</div>`;
      html += `</div>`;
    }

    // Add constraints preview
    if (problemData.constraints?.length > 0) {
      html += `<span class="section-label">Constraints</span>`;
      problemData.constraints.slice(0, 2).forEach((c) => {
        html += `<span class="constraint">${escapeHtml(c)}</span>`;
      });
      if (problemData.constraints.length > 2) {
        html += `<span class="constraint" style="color: var(--text-tertiary)">+${problemData.constraints.length - 2} more...</span>`;
      }
    }

    DOM.problem.questionPreview.innerHTML = html;
  } else {
    DOM.problem.questionEmpty?.classList.remove("hidden");
    DOM.problem.questionFilled?.classList.add("hidden");
  }

  // Update problem stats if available
  updateProblemStats();
}

/**
 * Cleans code of Unicode artifacts.
 * @param {string} code - Raw code
 * @returns {string} Cleaned code
 */
function cleanCodeString(code) {
  if (!code) return "";
  return code
    .replace(/[\u00A0\u1680\u180E\u2000-\u200A\u202F\u205F\u3000]/g, " ")
    .replace(/[\u200B\u200C\u200D\uFEFF]/g, "")
    .replace(/·/g, " ");
}

/**
 * Escapes HTML special characters.
 * @param {string} text - Raw text
 * @returns {string} Escaped text
 */
function escapeHtml(text) {
  if (!text) return "";
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Populates form with existing entry data.
 * @param {Object} data - Existing data
 */
function populateExistingData(data) {
  if (data.tags?.length) {
    data.tags.forEach((tag) => {
      if (!selectedTags.includes(tag)) {
        selectedTags.push(tag);
        const btn = document.querySelector(`[data-tag="${tag}"]`);
        if (btn) btn.classList.add("selected");
      }
    });
  }

  if (data.expertise) {
    selectedExpertise = data.expertise;
    document.querySelectorAll(".expertise-btn").forEach((btn) => {
      btn.classList.remove("selected-low", "selected-medium", "selected-high");
      if (btn.dataset.expertise === data.expertise) {
        btn.classList.add(`selected-${data.expertise.toLowerCase()}`);
      }
    });
  }

  if (data.remark) DOM.form.remark.value = data.remark;
  if (data.notes) DOM.form.notes.value = data.notes;
  if (data.altMethods?.length)
    DOM.form.altMethods.value = data.altMethods.join(", ");
  DOM.form.done.checked = data.done || false;
}

/**
 * Clears the Notion-synced form fields before repopulating from Notion.
 * Used when the Notion page is newer than a stale local draft, so values
 * deleted remotely (e.g. cleared notes) don't linger from the draft.
 * Tags stay additive (scraped tags were auto-selected) and expertise is
 * overwritten by populateExistingData when Notion has a value.
 */
function resetSyncedFormFields() {
  if (DOM.form.notes) DOM.form.notes.value = "";
  if (DOM.form.remark) DOM.form.remark.value = "";
  if (DOM.form.altMethods) DOM.form.altMethods.value = "";
  if (DOM.complexity.time) DOM.complexity.time.value = "";
  if (DOM.complexity.space) DOM.complexity.space.value = "";
  if (DOM.form.done) DOM.form.done.checked = false;
}

// NOTION INTEGRATION

/**
 * Checks if problem exists in Notion.
 */
async function checkExistingEntry() {
  const settings = await chrome.storage.sync.get([
    "notionApiKey",
    "notionDatabaseId",
  ]);
  if (
    !settings.notionApiKey ||
    !settings.notionDatabaseId ||
    !problemData.number
  )
    return;

  try {
    const response = await chrome.runtime.sendMessage({
      action: "checkExisting",
      data: {
        apiKey: settings.notionApiKey,
        databaseId: settings.notionDatabaseId,
        problemNumber: problemData.number,
      },
    });

    if (response?.exists) {
      existingPageId = response.pageId;
      setMarkTodoVisible(false);
      firstAttemptDateMissing = response.hasFirstAttemptDate === false;

      // Hydrate/reconcile the snapshot list from the Notion page so every
      // machine sees the same solutions (Notion is the source of truth).
      await reconcileSnapshots(response.remoteSnapshots || []);

      const formStateKey = `form_state_${problemData.number}`;
      const localState = await chrome.storage.local.get([formStateKey]);
      const draft = localState[formStateKey];

      // Freshness gate: a local form draft only wins while it is newer than
      // the Notion page. If the page was edited after the draft was written
      // (e.g. saved from another machine), Notion data populates the form.
      const notionIsNewer =
        !!draft &&
        typeof response.lastEdited === "number" &&
        response.lastEdited > (draft.timestamp || 0);
      const useNotionData = !draft || notionIsNewer;

      if (useNotionData) {
        if (notionIsNewer) {
          console.log(
            "Leetion: Notion page is newer than the local draft - using Notion data",
          );
          resetSyncedFormFields();
          await clearPersistedFormState(problemData.number);
        }
        populateExistingData(response);
      }

      updateSaveButton(true);

      DOM.quickActions.card?.classList.remove("hidden");

      // `typeof`, not truthiness: a to-do row reports 0 attempts, and a
      // falsy check would leave the display on a stale count.
      if (typeof response.attempts === "number") {
        userAttemptCount = response.attempts;
      }
      // Notion is the only source for this switch — there is no local draft of
      // it, so it is hydrated regardless of the draft-freshness gate above.
      setSpacedRepetitionToggle(!!response.spacedRepetition);
      updateProblemStats();
      showAttemptsControl();

      if (useNotionData) {
        if (response.timeComplexity && DOM.complexity.time) {
          DOM.complexity.time.value = response.timeComplexity;
        }
        if (response.spaceComplexity && DOM.complexity.space) {
          DOM.complexity.space.value = response.spaceComplexity;
        }

        // If question exists in Notion, check the toggle so we don't wipe it on save
        if (response.hasQuestion && DOM.problem.saveQuestionToggle) {
          DOM.problem.saveQuestionToggle.checked = true;
        }
      } else {
        // If we have local state, we rely on that, BUT if local state didn't track the toggle (old version)
        // verify against Notion.
        if (
          response.hasQuestion &&
          DOM.problem.saveQuestionToggle &&
          !draft.hasOwnProperty("saveQuestion")
        ) {
          DOM.problem.saveQuestionToggle.checked = true;
        }
      }

      showStatus(
        DOM.save.status,
        notionIsNewer
          ? "Loaded latest data from Notion (newer than local draft)"
          : "Found existing entry - will update on save",
        "success",
      );
    } else {
      // Nothing in Notion for this problem yet, so offer to queue it.
      // Gated on the resolved lookup rather than shown optimistically at
      // popup-open, so the button never flashes for a problem that is
      // already saved.
      setMarkTodoVisible(true);
    }
  } catch (error) {
    console.error("Error checking existing:", error);
  }
}

/**
 * Shows or hides the header's "Mark to-do" button.
 * Only ever visible for a problem with no Notion row — once `existingPageId`
 * is set there is nothing left to queue, and "Update in Notion" is the path.
 * @param {boolean} visible
 */
function setMarkTodoVisible(visible) {
  DOM.problem.markTodoBtn?.classList.toggle(
    "hidden",
    !visible || !!existingPageId,
  );
}

/**
 * Queues an unattempted problem: creates its Notion row with Spaced
 * Repetition = today, Attempts = 0, Done unchecked, no expertise and no
 * first-attempt date, and no solution content.
 *
 * The real values land later, when the user actually attempts the problem and
 * presses "Update in Notion": that update increments Attempts 0 → 1
 * server-fresh and backfills "Date (of first attempt)" with that day.
 * `attemptSessionIncremented` is deliberately NOT set here — queuing a
 * problem is not an attempt at it.
 * @param {boolean} confirmSchemaChanges - True only when the user has just
 *   confirmed the missing-columns warning.
 */
async function markTodo(confirmSchemaChanges = false) {
  if (existingPageId) {
    setMarkTodoVisible(false);
    return;
  }
  hideSchemaConfirmation();

  const settings = await chrome.storage.sync.get([
    "notionApiKey",
    "notionDatabaseId",
  ]);

  if (!settings.notionApiKey || !settings.notionDatabaseId) {
    showStatus(DOM.save.status, "Configure Notion settings first", "error");
    showView("settings");
    return;
  }

  if (!problemData.title) {
    showStatus(DOM.save.status, "No problem data. Try refreshing.", "error");
    return;
  }

  setMarkTodoLoading(true);

  try {
    const response = await chrome.runtime.sendMessage({
      action: "markTodo",
      data: {
        apiKey: settings.notionApiKey,
        databaseId: settings.notionDatabaseId,
        confirmSchemaChanges: confirmSchemaChanges === true,
        problem: {
          number: problemData.number,
          title: problemData.title,
          difficulty: problemData.difficulty,
          url: problemData.url,
          tags: selectedTags,
        },
      },
    });

    if (response?.alreadyExists) {
      // The lookup that revealed the button was stale (or errored into "not
      // found"). No second row was created; adopt the existing one instead.
      existingPageId = response.pageId;
      setMarkTodoVisible(false);
      showStatus(DOM.save.status, "Already in Notion - loading entry", "error");
      await checkExistingEntry();
      return;
    }

    if (response?.success) {
      existingPageId = response.pageId;
      setMarkTodoVisible(false);
      firstAttemptDateMissing = true;
      userAttemptCount = 0;
      pendingAttempts = null;

      // The row was created with Done unchecked, but the markup ships the
      // toggle checked. Without this the popup would contradict Notion, and
      // the user's first "Update in Notion" would silently flip Done to true.
      if (DOM.form.done) DOM.form.done.checked = false;
      await persistFormState();

      let message = "Marked to-do - due for review today";
      if (response.schemaCreated?.length > 0) {
        message += ` Added ${response.schemaCreated.length} column${
          response.schemaCreated.length === 1 ? "" : "s"
        }: ${response.schemaCreated.join(", ")}`;
      }
      if (response.schemaWarning) {
        console.warn("Leetion: Schema warning:", response.schemaWarning);
        message += " (column check warning - see extension console)";
      }
      showStatus(DOM.save.status, message, "success");

      updateSaveButton(true);
      DOM.quickActions.card?.classList.remove("hidden");
      updateProblemStats();
      showAttemptsControl();
    } else if (response?.needsSchemaConfirmation) {
      pendingSchemaAction = "todo";
      showSchemaConfirmation(response.missingColumns || []);
    } else {
      // Nothing was created: the button stays visible and enabled to retry.
      showStatus(DOM.save.status, response?.error || "Failed", "error");
    }
  } catch (error) {
    console.error("Mark to-do error:", error);
    showStatus(DOM.save.status, "Error connecting to Notion", "error");
  } finally {
    setMarkTodoLoading(false);
  }
}

/**
 * Disables the "Mark to-do" button while its create is in flight, so a double
 * click cannot fire two creates. Restores the label either way — on failure
 * the button must stay clickable to retry.
 * @param {boolean} loading
 */
function setMarkTodoLoading(loading) {
  const btn = DOM.problem.markTodoBtn;
  if (!btn) return;
  btn.disabled = loading;
  btn.innerHTML = loading
    ? "Adding..."
    : `
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M12 5v14M5 12h14"/>
      </svg>
      Mark to-do
    `;
}

/**
 * Saves problem to Notion.
 * @param {boolean} confirmSchemaChanges - True only when the user has just
 *   confirmed the missing-columns warning; lets the background create them.
 */
async function saveToNotion(confirmSchemaChanges = false) {
  hideSchemaConfirmation();
  pendingSchemaAction = "save";

  const settings = await chrome.storage.sync.get([
    "notionApiKey",
    "notionDatabaseId",
    INTERVALS_KEY,
    LEGACY_INTERVAL_KEY,
  ]);

  if (!settings.notionApiKey || !settings.notionDatabaseId) {
    showStatus(DOM.save.status, "Configure Notion settings first", "error");
    showView("settings");
    return;
  }

  if (!problemData.title) {
    showStatus(DOM.save.status, "No problem data. Try refreshing.", "error");
    return;
  }

  setSaveButtonLoading(true);

  try {
    const cleanedCode = cleanCodeString(problemData.code);
    const spacedRepDays = intervalForExpertise(
      resolveReviewIntervals(settings),
      selectedExpertise,
    );
    console.log(
      `Leetion: Sending spacedRepetitionDays for ${selectedExpertise} expertise:`,
      spacedRepDays,
    );

    const snapshotsToSave = getSnapshotsForSave();

    let description = problemData.questionContent || "";
    const descEnd = description.indexOf("Example");
    if (descEnd > 0) {
      description = description.substring(0, descEnd).trim();
    }

    // A staged count is an explicit "make it this", so it is sent as-is and
    // the automatic increment is suppressed — otherwise typing 5 and pressing
    // Update in Notion would land on 6. With nothing staged, Attempts is
    // incremented once per popup session, computed server-fresh in the
    // background.
    const stagedAttempts = pendingAttempts;
    const shouldIncrementAttempts =
      !!existingPageId && !attemptSessionIncremented && stagedAttempts === null;

    // A problem the user switched out of the review rotation must stay out: an
    // ordinary "Update in Notion" would otherwise re-schedule it from the
    // expertise interval and quietly undo the clear.
    const clearSpacedRepetition = !!existingPageId && !isSpacedRepetitionOn();

    const response = await chrome.runtime.sendMessage({
      action: "saveToNotion",
      data: {
        apiKey: settings.notionApiKey,
        databaseId: settings.notionDatabaseId,
        existingPageId,
        incrementAttempts: shouldIncrementAttempts,
        // A row queued by "Mark to-do" was created without a first-attempt
        // date; this update is that first attempt, so ask the background to
        // fill it in. No-op for a create, and for a row that already has one.
        backfillFirstAttemptDate: !!existingPageId && firstAttemptDateMissing,
        ...(stagedAttempts !== null ? { attempts: stagedAttempts } : {}),
        spacedRepetitionDays: spacedRepDays,
        clearSpacedRepetition,
        confirmSchemaChanges: confirmSchemaChanges === true,
        problem: {
          number: problemData.number,
          title: problemData.title,
          difficulty: problemData.difficulty,
          code: cleanedCode,
          language: problemData.language,
          url: problemData.url,
          tags: selectedTags,
          expertise: selectedExpertise,
          notes: DOM.form.notes.value,
          remark: DOM.form.remark.value,
          altMethods: DOM.form.altMethods.value,
          done: DOM.form.done.checked,
          timeComplexity: DOM.complexity.time?.value || "",
          spaceComplexity: DOM.complexity.space?.value || "",
          snapshots: snapshotsToSave,
          saveQuestion: DOM.problem.saveQuestionToggle?.checked || false,
          questionContent: {
            content: problemData.questionContent, // Keep original full content just in case
            description: description, // Send trimmed description
            examples: problemData.examples,
            constraints: problemData.constraints,
          },
        },
      },
    });

    if (response.success) {
      let message;
      if (response.updated) {
        if (response.contentUpdated) {
          message = "Updated with new code/notes!";
        } else {
          message = "Updated properties (code/notes preserved)";
        }
      } else {
        message = "Saved to Notion!";
      }
      if (response.schemaCreated?.length > 0) {
        message += ` Added ${response.schemaCreated.length} column${
          response.schemaCreated.length === 1 ? "" : "s"
        }: ${response.schemaCreated.join(", ")}`;
      }
      if (response.schemaWarning) {
        console.warn("Leetion: Schema warning:", response.schemaWarning);
        message += " (column check warning — see extension console)";
      }
      showStatus(DOM.save.status, message, "success");

      await clearPersistedFormState(problemData.number);

      const wasFirstSave = !existingPageId;

      // The saved state is now the reconciled baseline: mark every snapshot
      // as synced and persist, so a stale pre-hydration snapshot list can
      // never resurrect solutions that were deleted on another machine.
      codeSnapshots = codeSnapshots.map((s) =>
        s.synced ? s : { ...s, synced: true },
      );
      try {
        await chrome.storage.local.set({
          [`snapshots_${problemData.number}`]: codeSnapshots,
        });
      } catch (persistError) {
        console.error("Error persisting synced snapshots:", persistError);
      }

      if (!existingPageId && response.pageId) {
        existingPageId = response.pageId;
        updateSaveButton(true);
        DOM.quickActions.card?.classList.remove("hidden");
      }
      // The row now has a first-attempt date: written on create, or
      // backfilled by the update just above.
      firstAttemptDateMissing = false;
      setMarkTodoVisible(false);

      // Resync the switch to what this save actually wrote. A first save only
      // schedules a review when the expertise interval is non-zero; an update
      // either cleared the date or re-scheduled it.
      if (wasFirstSave) {
        setSpacedRepetitionToggle(spacedRepDays > 0);
      } else if (clearSpacedRepetition) {
        setSpacedRepetitionToggle(false);
      } else if (spacedRepDays > 0) {
        setSpacedRepetitionToggle(true);
      }

      // Per-popup-session attempt accounting: a first save wrote
      // Attempts = 1 (this session's attempt); an update incremented
      // server-fresh only on the session's first update.
      if (typeof response.attempts === "number") {
        userAttemptCount = response.attempts;
      }
      // The staged edit has landed, so the field is no longer unsaved. Cleared
      // only on success — a failed save leaves it staged to retry.
      if (stagedAttempts !== null && response.attempts === stagedAttempts) {
        pendingAttempts = null;
      }
      if (wasFirstSave || shouldIncrementAttempts) {
        attemptSessionIncremented = true;
      }
      updateProblemStats();
      showAttemptsControl();
    } else if (response.needsSchemaConfirmation) {
      showSchemaConfirmation(response.missingColumns || []);
    } else {
      showStatus(DOM.save.status, response.error || "Failed", "error");
    }
  } catch (error) {
    console.error("Save error:", error);
    showStatus(DOM.save.status, "Error connecting to Notion", "error");
  } finally {
    setSaveButtonLoading(false);
  }
}

// UI HELPERS

/**
 * Shows status message.
 * @param {HTMLElement} el - Status element
 * @param {string} msg - Message
 * @param {string} type - 'success' or 'error'
 */
function showStatus(el, msg, type) {
  if (!el) return;
  el.classList.remove("hidden", "status-success", "status-error");
  el.classList.add(`status-${type}`);
  el.textContent = msg;
  setTimeout(() => el.classList.add("hidden"), 4000);
}

/**
 * Shows the one-time warning listing the Notion columns Leetion is about to
 * create, before creating them. Columns are only created after the user
 * clicks "Add columns & save".
 * @param {Array<{name: string, type: string, similarExisting: string[]}>} columns
 */
function showSchemaConfirmation(columns) {
  if (!DOM.save.schemaConfirm || !DOM.save.schemaList) return;

  // Built with textContent (not innerHTML): names come from the user's
  // Notion database and must be treated as plain text.
  DOM.save.schemaList.replaceChildren();
  for (const col of columns) {
    const li = document.createElement("li");
    li.textContent = `${col.name} (${col.type.replace(/_/g, " ")})`;
    if (col.similarExisting?.length > 0) {
      const hint = document.createElement("span");
      hint.className = "schema-confirm-similar";
      hint.textContent = ` — existing ${col.type.replace(/_/g, " ")} column${
        col.similarExisting.length === 1 ? "" : "s"
      }: ${col.similarExisting.join(", ")}`;
      li.appendChild(hint);
    }
    DOM.save.schemaList.appendChild(li);
  }

  DOM.save.schemaConfirm.classList.remove("hidden");
}

function hideSchemaConfirmation() {
  DOM.save.schemaConfirm?.classList.add("hidden");
}

/**
 * Updates save button text.
 * @param {boolean} isUpdate - Is updating existing
 */
function updateSaveButton(isUpdate) {
  const span = DOM.save.btn.querySelector("span");
  if (span) span.textContent = isUpdate ? "Update in Notion" : "Save to Notion";
}

/**
 * Sets save button loading state.
 * @param {boolean} loading - Is loading
 */
function setSaveButtonLoading(loading) {
  DOM.save.btn.disabled = loading;

  if (loading) {
    DOM.save.btn.innerHTML = `
      <svg class="animate-spin" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
      </svg>
      <span>Saving...</span>
    `;
  } else {
    DOM.save.btn.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"/>
        <polyline points="17,21 17,13 7,13 7,21"/>
        <polyline points="7,3 7,8 15,8"/>
      </svg>
      <span>${existingPageId ? "Update in Notion" : "Save to Notion"}</span>
    `;
  }
}

// EVENT LISTENERS

function setupEventListeners() {
  // Navigation
  DOM.nav.settingsEmpty?.addEventListener("click", () => showView("settings"));
  DOM.nav.settingsMain?.addEventListener("click", () => showView("settings"));
  DOM.nav.back?.addEventListener("click", () =>
    showView(previousView === "settings" ? "main" : previousView),
  );

  // Settings toggles
  DOM.settings.toggleApiKeyBtn?.addEventListener("click", () =>
    toggleInputVisibility(
      DOM.settings.apiKeyInput,
      DOM.settings.toggleApiKeyBtn,
    ),
  );
  DOM.settings.toggleDbIdBtn?.addEventListener("click", () =>
    toggleInputVisibility(
      DOM.settings.databaseIdInput,
      DOM.settings.toggleDbIdBtn,
    ),
  );

  // Save settings
  DOM.settings.saveBtn?.addEventListener("click", saveSettings);
  DOM.settings.runSetupBtn?.addEventListener("click", openSetupWizard);

  // Refresh buttons (both filled and empty states)
  DOM.problem.refreshBtn?.addEventListener("click", refreshData);
  DOM.problem.refreshCodeEmptyBtn?.addEventListener("click", refreshData);
  DOM.problem.refreshQuestionBtn?.addEventListener("click", refreshData);
  DOM.problem.refreshQuestionEmptyBtn?.addEventListener("click", refreshData);

  // Drawing canvas
  DOM.nav.drawing?.addEventListener("click", openDrawingCanvas);

  // Snapshot button
  DOM.snapshots.btn?.addEventListener("click", saveSnapshot);

  // Tags - with form persistence
  DOM.form.tagsContainer?.querySelectorAll(".tag-chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      toggleTag(btn);
      persistFormState();
    });
  });

  // Expertise - with form persistence
  document.querySelectorAll(".expertise-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      selectExpertise(btn);
      persistFormState();
    });
  });

  // Quick Actions
  DOM.quickActions.markReview?.addEventListener("click", markForReviewTomorrow);
  DOM.quickActions.revisit?.addEventListener("click", revisitProblem);
  DOM.quickActions.spacedRepetition?.addEventListener(
    "change",
    toggleSpacedRepetition,
  );

  // Manual +1 attempt (stats row, existing entries only)
  DOM.attempts.plus?.addEventListener("click", addManualAttempt);
  DOM.attempts.input?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      // Commit directly rather than relying on the blur handler: a popup that
      // closes on Enter may never dispatch blur, silently dropping the edit.
      e.preventDefault();
      commitAttemptEdit();
      DOM.attempts.input.blur();
    } else if (e.key === "Escape") {
      e.preventDefault();
      updateAttemptDisplay(); // discard, so the blur below is a no-op
      DOM.attempts.input.blur();
    }
  });
  // Backup path for clicking away without pressing Enter. Re-entrant by
  // design: commitAttemptEdit no-ops when the field already matches the count.
  DOM.attempts.input?.addEventListener("blur", commitAttemptEdit);

  // Complexity - auto-suggest and persist
  DOM.complexity.time?.addEventListener("change", () => {
    suggestComplexity();
    persistFormState();
  });
  DOM.complexity.space?.addEventListener("change", () => {
    suggestComplexity();
    persistFormState();
  });

  // Form inputs - persist on input (debounced) AND blur (immediate)
  DOM.form.notes?.addEventListener("input", debounce(persistFormState, 500));
  DOM.form.notes?.addEventListener("blur", persistFormState);
  DOM.form.remark?.addEventListener("input", debounce(persistFormState, 500));
  DOM.form.remark?.addEventListener("blur", persistFormState);
  DOM.form.altMethods?.addEventListener(
    "input",
    debounce(persistFormState, 500),
  );
  DOM.form.altMethods?.addEventListener("blur", persistFormState);
  DOM.form.done?.addEventListener("change", persistFormState);

  // Save (wrapped so the click event isn't passed as confirmSchemaChanges)
  DOM.save.btn?.addEventListener("click", () => saveToNotion());

  // Mark to-do (header row) - queue an unattempted problem
  DOM.problem.markTodoBtn?.addEventListener("click", () => markTodo());

  // Schema confirmation (missing Notion columns warning). Resumes whichever
  // action raised it, so confirming from a to-do create does not fall through
  // to a full save.
  DOM.save.schemaCreateBtn?.addEventListener("click", () =>
    pendingSchemaAction === "todo" ? markTodo(true) : saveToNotion(true),
  );
  DOM.save.schemaCancelBtn?.addEventListener("click", () => {
    hideSchemaConfirmation();
    showStatus(
      DOM.save.status,
      pendingSchemaAction === "todo"
        ? "Mark to-do canceled — no columns were added"
        : "Save canceled — no columns were added",
      "error",
    );
  });

  // Stats modal
  DOM.stats.openBtn?.addEventListener("click", openStatsModal);
  DOM.stats.closeBtn?.addEventListener("click", closeStatsModal);
  DOM.stats.modal?.addEventListener("click", (e) => {
    if (e.target === DOM.stats.modal) closeStatsModal();
  });

  document.getElementById("card-code-toggle").addEventListener("click", (e) => {
    // Don't toggle if clicking the refresh button
    if (e.target.closest("#btn-refresh-code")) return;

    document.getElementById("card-code").classList.toggle("expanded");
  });
  document
    .getElementById("card-question-toggle")
    .addEventListener("click", (e) => {
      if (e.target.closest("#btn-refresh-question")) return;
      document.getElementById("card-question").classList.toggle("expanded");
    });
}

/**
 * Debounce helper function.
 */
function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

function toggleInputVisibility(input, btn) {
  const isPass = input.type === "password";
  input.type = isPass ? "text" : "password";
  btn.classList.toggle("showing", isPass);
}

async function saveSettings() {
  const apiKey = DOM.settings.apiKeyInput.value.trim();
  const dbId = DOM.settings.databaseIdInput.value.trim();

  const intervals = {};
  EXPERTISE_LEVELS.forEach((level) => {
    const input = DOM.settings.intervalInputs[level];
    intervals[level] =
      sanitizeInterval(input?.value) ?? DEFAULT_REVIEW_INTERVALS[level];
  });

  const toSave = { [INTERVALS_KEY]: intervals };
  if (apiKey) toSave.notionApiKey = apiKey;
  if (dbId) toSave.notionDatabaseId = dbId;

  try {
    await chrome.storage.sync.set(toSave);
    // The legacy flat interval has been migrated into the object above; drop it
    // so it can never be re-read as a stale fallback.
    await chrome.storage.sync.remove(LEGACY_INTERVAL_KEY);

    // Reflect the sanitized values back into the inputs.
    EXPERTISE_LEVELS.forEach((level) => {
      const input = DOM.settings.intervalInputs[level];
      if (input) input.value = intervals[level];
    });

    showStatus(DOM.settings.status, "Settings saved!", "success");
  } catch (error) {
    console.error("Error saving settings:", error);
    showStatus(DOM.settings.status, "Failed to save settings", "error");
  }
}

/**
 * Opens the drawing canvas on the LeetCode page.
 */
async function openDrawingCanvas() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"],
    });
  } catch (e) {
    // Content script may already be loaded
  }

  setTimeout(() => {
    chrome.tabs.sendMessage(tab.id, { action: "openFloatingCanvas" }, () => {
      if (!chrome.runtime.lastError) window.close();
    });
  }, 100);
}

function toggleTag(btn) {
  const tag = btn.dataset.tag;
  if (selectedTags.includes(tag)) {
    selectedTags = selectedTags.filter((t) => t !== tag);
    btn.classList.remove("selected");
  } else {
    selectedTags.push(tag);
    btn.classList.add("selected");
  }
}

function selectExpertise(btn) {
  document.querySelectorAll(".expertise-btn").forEach((b) => {
    b.classList.remove("selected-low", "selected-medium", "selected-high");
  });
  selectedExpertise = btn.dataset.expertise;
  btn.classList.add(`selected-${selectedExpertise.toLowerCase()}`);
}

// QUICK ACTIONS

/**
 * Sets spaced repetition to tomorrow.
 */
async function markForReviewTomorrow() {
  console.log(
    "Leetion: markForReviewTomorrow called, existingPageId:",
    existingPageId,
  );
  if (!existingPageId) {
    console.log("Leetion: No existingPageId, returning");
    return;
  }

  const settings = await chrome.storage.sync.get(["notionApiKey"]);
  console.log("Leetion: Got API key:", settings.notionApiKey ? "yes" : "no");
  if (!settings.notionApiKey) {
    showStatus(DOM.save.status, "Configure API key first", "error");
    return;
  }

  try {
    DOM.quickActions.markReview.disabled = true;
    DOM.quickActions.markReview.textContent = "Setting...";

    console.log("Leetion: Sending updateSpacedRepetition message...");
    const response = await chrome.runtime.sendMessage({
      action: "updateSpacedRepetition",
      data: {
        apiKey: settings.notionApiKey,
        pageId: existingPageId,
        days: 1,
      },
    });

    console.log("Leetion: Got response:", response);

    if (response?.success) {
      DOM.quickActions.markReview.classList.add("quick-btn-success");
      DOM.quickActions.revisit.classList.remove("quick-btn-success");
      // A date now exists, so the on/off switch must read "on".
      setSpacedRepetitionToggle(true);
      showStatus(DOM.save.status, "Review set for tomorrow!", "success");
    } else {
      showStatus(
        DOM.save.status,
        response?.error || "Failed to update",
        "error",
      );
    }
  } catch (error) {
    console.error("Leetion: Error in markForReviewTomorrow:", error);
    showStatus(DOM.save.status, "Failed to update", "error");
  } finally {
    DOM.quickActions.markReview.disabled = false;
    DOM.quickActions.markReview.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
        <line x1="16" y1="2" x2="16" y2="6"/>
        <line x1="8" y1="2" x2="8" y2="6"/>
        <line x1="3" y1="10" x2="21" y2="10"/>
        <path d="M9 16l2 2 4-4"/>
      </svg>
      Tomorrow
    `;
  }
}

/**
 * Sets spaced repetition to TODAY — "review this now".
 *
 * Deliberately independent of the per-expertise intervals: those govern the
 * save path (issue #3), where the question is "when should I see this next?".
 * Here the user has just decided they need another pass, so the answer is
 * always today's review queue — pushing it 1-7 days out (or skipping the
 * write entirely when that expertise's interval is 0) defeats the button.
 *
 * Scheduling only — Attempts is left alone. Queuing a problem for review is
 * not an attempt at it; the attempt happens later, and is counted then by the
 * `+` button, the Attempts field, or the next save. Incrementing here would
 * inflate the count for anyone who queues a problem and never gets to it.
 */
async function revisitProblem() {
  if (!existingPageId) return;

  const settings = await chrome.storage.sync.get(["notionApiKey"]);
  if (!settings.notionApiKey) {
    showStatus(DOM.save.status, "Configure API key first", "error");
    return;
  }

  try {
    DOM.quickActions.revisit.disabled = true;
    DOM.quickActions.revisit.textContent = "Setting...";

    const response = await chrome.runtime.sendMessage({
      action: "updateSpacedRepetition",
      data: {
        apiKey: settings.notionApiKey,
        pageId: existingPageId,
        setToday: true,
      },
    });

    if (response?.success) {
      DOM.quickActions.revisit.classList.add("quick-btn-success");
      DOM.quickActions.markReview.classList.remove("quick-btn-success");
      // A date now exists, so the on/off switch must read "on".
      setSpacedRepetitionToggle(true);
      showStatus(DOM.save.status, "Reset! Due today", "success");
    } else {
      showStatus(
        DOM.save.status,
        response?.error || "Failed to update",
        "error",
      );
    }
  } catch (error) {
    showStatus(DOM.save.status, "Failed to update", "error");
  } finally {
    DOM.quickActions.revisit.disabled = false;
    DOM.quickActions.revisit.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M23 4v6h-6"/>
        <path d="M1 20v-6h6"/>
        <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>
      </svg>
      Review Today
    `;
  }
}

/**
 * True when the "Spaced Repetition" switch is on. Missing element (older
 * popup markup) reads as on so the save path keeps its historic behaviour.
 */
function isSpacedRepetitionOn() {
  return DOM.quickActions.spacedRepetition?.checked !== false;
}

/**
 * Drives the switch from known Notion state (never from a guess) and keeps the
 * hint beside it in sync.
 */
function setSpacedRepetitionToggle(on) {
  if (DOM.quickActions.spacedRepetition) {
    DOM.quickActions.spacedRepetition.checked = on;
  }
  if (DOM.quickActions.spacedRepetitionHint) {
    DOM.quickActions.spacedRepetitionHint.textContent = on
      ? "Due date set"
      : "No reviews";
  }
}

/**
 * Takes the problem out of the review rotation, or puts it back.
 *
 * Off writes an empty date to Notion, which is the only thing that stops the
 * hourly due-review query (and its notification) from matching the page. On
 * re-queues it for TODAY — the same rule "Review Today" uses (issue #10), and
 * for the same reason: turning the switch back on is an explicit "I want to
 * see this again" and should not be silently deferred by an expertise interval
 * that may be days out, or 0 (which writes nothing at all).
 *
 * The switch is optimistic in the DOM only because the browser flips a
 * checkbox before the handler runs; a failed write puts it straight back, so
 * it never shows a clear that did not happen.
 */
async function toggleSpacedRepetition() {
  const toggle = DOM.quickActions.spacedRepetition;
  if (!toggle) return;

  const turningOn = toggle.checked;

  if (!existingPageId) {
    // Nothing to write to yet. The card is hidden until the problem exists in
    // Notion, so this is a defensive revert rather than a reachable path.
    setSpacedRepetitionToggle(!turningOn);
    return;
  }

  const settings = await chrome.storage.sync.get(["notionApiKey"]);
  if (!settings.notionApiKey) {
    setSpacedRepetitionToggle(!turningOn);
    showStatus(DOM.save.status, "Configure API key first", "error");
    return;
  }

  try {
    toggle.disabled = true;

    const response = await chrome.runtime.sendMessage({
      action: "updateSpacedRepetition",
      data: {
        apiKey: settings.notionApiKey,
        pageId: existingPageId,
        ...(turningOn ? { setToday: true } : { clear: true }),
      },
    });

    if (response?.success) {
      setSpacedRepetitionToggle(turningOn);
      if (turningOn) {
        DOM.quickActions.revisit?.classList.add("quick-btn-success");
        DOM.quickActions.markReview?.classList.remove("quick-btn-success");
        showStatus(DOM.save.status, "Review set for today!", "success");
      } else {
        // There is no date left, so a lingering "review scheduled" highlight
        // on either button would be a lie.
        DOM.quickActions.revisit?.classList.remove("quick-btn-success");
        DOM.quickActions.markReview?.classList.remove("quick-btn-success");
        showStatus(DOM.save.status, "Review cleared!", "success");
      }
    } else {
      setSpacedRepetitionToggle(!turningOn);
      showStatus(
        DOM.save.status,
        response?.error || "Failed to update",
        "error",
      );
    }
  } catch (error) {
    console.error("Leetion: Error in toggleSpacedRepetition:", error);
    setSpacedRepetitionToggle(!turningOn);
    showStatus(DOM.save.status, "Failed to update", "error");
  } finally {
    toggle.disabled = false;
  }
}

/**
 * Reveals the Attempts control and syncs it to the current count. Gated on an
 * existing Notion entry — before the first save there is no page to write to.
 */
function showAttemptsControl() {
  if (!existingPageId) return;
  DOM.attempts.control?.classList.remove("hidden");
  updateAttemptDisplay();
}

/**
 * The count the field is showing: the staged edit if there is one, otherwise
 * the value last read from Notion.
 */
function effectiveAttemptCount() {
  return pendingAttempts ?? userAttemptCount;
}

/**
 * Stages a count. Nothing is sent to Notion here — `saveToNotion` picks the
 * staged value up on the next "Update in Notion". Staging back to the stored
 * value clears the pending state rather than queuing a no-op write.
 */
function stageAttempts(count) {
  pendingAttempts = count === userAttemptCount ? null : count;
  updateAttemptDisplay();
}

/**
 * Adds one attempt (the "+" button beside the count). Stages only — it bumps
 * whatever the field is currently showing.
 */
function addManualAttempt() {
  if (!existingPageId) return;
  stageAttempts(Math.min(effectiveAttemptCount() + 1, ATTEMPTS_MAX));
}

/**
 * Reads the hand-typed count out of the field and stages it. Called on Enter
 * and on blur; an empty or invalid field just restores the display.
 */
function commitAttemptEdit() {
  const raw = DOM.attempts.input?.value ?? "";
  if (raw.trim() === "") {
    updateAttemptDisplay();
    return;
  }

  const parsed = Math.floor(Number(raw));
  if (!Number.isFinite(parsed) || parsed < 0) {
    showStatus(DOM.save.status, "Attempts must be 0 or more", "error");
    updateAttemptDisplay();
    return;
  }

  stageAttempts(Math.min(parsed, ATTEMPTS_MAX));
}

/**
 * Updates the attempt count display, flagging the field as unsaved while an
 * edit is staged so the deferred write is visible rather than implied.
 */
function updateAttemptDisplay() {
  const count = effectiveAttemptCount();
  const staged = pendingAttempts !== null;

  if (DOM.attempts.input) {
    DOM.attempts.input.value = count.toString();
    DOM.attempts.input.classList.toggle("is-staged", staged);
    DOM.attempts.input.title = staged
      ? "Unsaved — press Update in Notion to apply"
      : "Type a new count and press Enter";
  }
  DOM.attempts.control?.classList.toggle("is-staged", staged);

  const attSpan = DOM.problem.statAttempts?.querySelector("span:last-child");
  if (attSpan) attSpan.textContent = count.toString();
}

// COMPLEXITY SUGGESTIONS

/**
 * Suggests complexity based on selected tags.
 */
function suggestComplexity() {
  const suggestions = [];

  if (selectedTags.includes("Binary Search")) {
    if (!DOM.complexity.time.value)
      suggestions.push("Binary Search typically has O(log n) time");
  }
  if (selectedTags.includes("Two Pointers")) {
    if (!DOM.complexity.time.value)
      suggestions.push("Two Pointers typically has O(n) time");
  }
  if (selectedTags.includes("Dynamic Programming")) {
    if (!DOM.complexity.space.value)
      suggestions.push("DP often uses O(n) or O(n²) space");
  }
  if (selectedTags.includes("Sorting")) {
    if (!DOM.complexity.time.value)
      suggestions.push("Sorting typically has O(n log n) time");
  }
  if (selectedTags.includes("Hashing")) {
    if (!DOM.complexity.time.value)
      suggestions.push("Hash operations are typically O(1)");
    if (!DOM.complexity.space.value)
      suggestions.push("Hash tables use O(n) space");
  }

  if (suggestions.length > 0 && DOM.complexity.suggestion) {
    DOM.complexity.suggestion.textContent = "💡 " + suggestions[0];
    DOM.complexity.suggestion.classList.remove("hidden");
  } else if (DOM.complexity.suggestion) {
    DOM.complexity.suggestion.classList.add("hidden");
  }
}

/**
 * Updates problem stats display.
 */
function updateProblemStats() {
  if (problemData.acceptanceRate || problemData.totalSubmissions) {
    DOM.problem.statsContainer?.classList.remove("hidden");

    if (problemData.acceptanceRate) {
      const accSpan =
        DOM.problem.statAcceptance?.querySelector("span:last-child");
      if (accSpan) accSpan.textContent = problemData.acceptanceRate;
    }

    if (problemData.totalSubmissions) {
      const subSpan =
        DOM.problem.statSubmissions?.querySelector("span:last-child");
      if (subSpan)
        subSpan.textContent = formatNumber(problemData.totalSubmissions);
    }

    const attSpan = DOM.problem.statAttempts?.querySelector("span:last-child");
    if (attSpan) attSpan.textContent = userAttemptCount.toString();
  }
}

// CODE SNAPSHOTS

/**
 * Loads snapshots for a problem from storage.
 * @param {number} problemNumber - Problem number
 */
async function loadSnapshots(problemNumber) {
  if (!problemNumber) return;

  try {
    const key = `snapshots_${problemNumber}`;
    const result = await chrome.storage.local.get([key]);
    codeSnapshots = result[key] || [];
    renderSnapshots();
  } catch (error) {
    console.error("Error loading snapshots:", error);
    codeSnapshots = [];
  }
}

/**
 * Reconciles the local snapshot list with the solutions on the Notion page.
 * Notion is the source of truth for solutions that have been saved:
 * - Remote solutions replace their local (synced) copies, so an empty local
 *   list hydrates fully from Notion and remote deletions propagate here.
 * - Local snapshots never marked `synced` (not yet saved to Notion, and not
 *   matching any remote code) are kept and appended after the remote ones.
 * - Question-type snapshots are local-only and kept as-is.
 * The reconciled list is persisted immediately so a stale pre-hydration
 * `snapshots_<n>` cannot be used by a later save.
 * @param {Array} remoteSnapshots - Snapshots reconstructed from the Notion page
 */
async function reconcileSnapshots(remoteSnapshots) {
  if (!problemData.number) return;

  const remoteSolutions = (remoteSnapshots || []).filter(
    (s) => s.type !== "question",
  );
  const localQuestions = codeSnapshots.filter((s) => s.type === "question");
  const remoteCodes = new Set(remoteSolutions.map((s) => (s.code || "").trim()));
  const localUnsynced = codeSnapshots.filter(
    (s) =>
      s.type !== "question" &&
      !s.synced &&
      !remoteCodes.has((s.code || "").trim()),
  );

  codeSnapshots = [...localQuestions, ...remoteSolutions, ...localUnsynced];

  try {
    const key = `snapshots_${problemData.number}`;
    await chrome.storage.local.set({ [key]: codeSnapshots });
  } catch (error) {
    console.error("Error persisting reconciled snapshots:", error);
  }

  renderSnapshots();
}

/**
 * Saves a new code snapshot.
 */
async function saveSnapshot() {
  if (!problemData.code || !problemData.number) {
    showStatus(DOM.save.status, "No code to snapshot", "error");
    return;
  }

  const cleanedCode = cleanCodeString(problemData.code);

  const isDuplicate = codeSnapshots.some(
    (s) => s.type !== "question" && s.code === cleanedCode,
  );
  if (isDuplicate) {
    showStatus(DOM.save.status, "This exact code is already saved", "error");
    return;
  }

  const solutionCount = codeSnapshots.filter(
    (s) => s.type !== "question",
  ).length;

  const snapshot = {
    id: Date.now().toString(),
    code: cleanedCode,
    language: problemData.language,
    timestamp: Date.now(),
    label: `Solution ${solutionCount + 1}`,
  };

  codeSnapshots.push(snapshot);

  try {
    const key = `snapshots_${problemData.number}`;
    await chrome.storage.local.set({ [key]: codeSnapshots });
    renderSnapshots();
    showStatus(DOM.save.status, "Solution saved!", "success");
  } catch (error) {
    console.error("Error saving snapshot:", error);
    codeSnapshots.pop();
    showStatus(DOM.save.status, "Failed to save solution", "error");
  }
}

/**
 * Saves question details as a special snapshot.
 */
async function saveQuestionDetails() {
  if (!problemData.questionContent || !problemData.number) {
    showStatus(
      DOM.save.status,
      "No question data found. Try refreshing.",
      "error",
    );
    return;
  }

  // Check if question already saved
  const hasQuestion = codeSnapshots.some((s) => s.type === "question");
  if (hasQuestion) {
    showStatus(DOM.save.status, "Question already saved", "error");
    return;
  }

  // Format the question content
  let formattedQuestion = `# ${problemData.number}. ${problemData.title}\n\n`;
  formattedQuestion += `**Difficulty:** ${problemData.difficulty}\n\n`;
  formattedQuestion += `## Problem\n\n`;

  const descEnd = problemData.questionContent.indexOf("Example");
  const description =
    descEnd > 0
      ? problemData.questionContent.substring(0, descEnd).trim()
      : problemData.questionContent;
  formattedQuestion += description + "\n\n";

  if (problemData.examples?.length > 0) {
    formattedQuestion += `## Examples\n\n`;
    problemData.examples.forEach((ex) => {
      formattedQuestion += `**Example ${ex.number}:**\n`;
      formattedQuestion += `- Input: \`${ex.input}\`\n`;
      formattedQuestion += `- Output: \`${ex.output}\`\n`;
      if (ex.explanation) {
        formattedQuestion += `- Explanation: ${ex.explanation}\n`;
      }
      formattedQuestion += "\n";
    });
  }

  if (problemData.constraints?.length > 0) {
    formattedQuestion += `## Constraints\n\n`;
    problemData.constraints.forEach((c) => {
      formattedQuestion += `- ${c}\n`;
    });
  }

  const questionSnapshot = {
    id: "question_" + Date.now().toString(),
    type: "question",
    code: formattedQuestion,
    language: "markdown",
    timestamp: Date.now(),
    label: "Problem Statement",
  };

  // Insert at beginning so question appears first
  codeSnapshots.unshift(questionSnapshot);

  try {
    const key = `snapshots_${problemData.number}`;
    await chrome.storage.local.set({ [key]: codeSnapshots });
    renderSnapshots();
    showStatus(DOM.save.status, "Question saved!", "success");
  } catch (error) {
    console.error("Error saving question:", error);
    codeSnapshots.shift();
    showStatus(DOM.save.status, "Failed to save question", "error");
  }
}

/**
 * Deletes a snapshot.
 * @param {string} snapshotId - Snapshot ID
 */
async function deleteSnapshot(snapshotId) {
  codeSnapshots = codeSnapshots.filter((s) => s.id !== snapshotId);

  try {
    const key = `snapshots_${problemData.number}`;
    await chrome.storage.local.set({ [key]: codeSnapshots });
    renderSnapshots();
    showStatus(DOM.save.status, "Deleted", "success");
  } catch (error) {
    console.error("Error deleting snapshot:", error);
  }
}

/**
 * Shows code preview modal.
 * @param {Object} snapshot - Snapshot to preview
 * @param {number} index - Snapshot index
 */
function showCodeModal(snapshot, index) {
  const escapedCode = snapshot.code.replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const isQuestion = snapshot.type === "question";

  const modal = document.createElement("div");
  modal.className = "code-modal-overlay";
  modal.innerHTML = `
    <div class="code-modal">
      <div class="code-modal-header">
        <span class="code-modal-title">${isQuestion ? "Problem Statement" : `${snapshot.language} - Solution ${index}`}</span>
        <button class="code-modal-close" title="Close">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
      <div class="code-modal-body">
        <pre>${escapedCode}</pre>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  modal
    .querySelector(".code-modal-close")
    .addEventListener("click", () => modal.remove());
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.remove();
  });
}

/**
 * Renders snapshots list in UI.
 */
function renderSnapshots() {
  if (!DOM.snapshots.list) return;

  if (DOM.snapshots.count) {
    DOM.snapshots.count.textContent = codeSnapshots.length.toString();
  }

  if (codeSnapshots.length === 0) {
    DOM.snapshots.list.innerHTML =
      '<p class="snapshots-empty">No solutions saved yet</p>';
    return;
  }

  let solutionIndex = 0;

  DOM.snapshots.list.innerHTML = codeSnapshots
    .map((snapshot, index) => {
      const date = new Date(snapshot.timestamp);
      const timeStr = date.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      });
      const dateStr = date.toLocaleDateString([], {
        month: "short",
        day: "numeric",
      });

      const isQuestion = snapshot.type === "question";

      if (!isQuestion) {
        solutionIndex++;
      }

      const displayIndex = isQuestion ? 0 : solutionIndex;

      const icon = isQuestion
        ? `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
          </svg>`
        : "";

      return `
      <div class="snapshot-item" data-id="${snapshot.id}" data-index="${displayIndex}" style="${isQuestion ? "border-left: 2px solid var(--accent);" : ""}">
        <div class="snapshot-header">
          <div class="snapshot-info">
            <span class="snapshot-lang" style="${isQuestion ? "color: var(--accent);" : ""}">
              ${icon}
              ${isQuestion ? "Problem Statement" : `${snapshot.language} - Solution ${displayIndex}`}
            </span>
            <span class="snapshot-meta">${dateStr} at ${timeStr}${!isQuestion ? ` · ${snapshot.code.split("\n").length} lines` : ""}</span>
          </div>
          <div class="snapshot-actions-btns">
            <button class="snapshot-btn preview" title="View" data-action="preview">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                <circle cx="12" cy="12" r="3"/>
              </svg>
            </button>
            <button class="snapshot-btn delete" title="Delete" data-action="delete">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="3,6 5,6 21,6"/>
                <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/>
              </svg>
            </button>
          </div>
        </div>
      </div>
    `;
    })
    .join("");

  // Add event listeners
  DOM.snapshots.list.querySelectorAll(".snapshot-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const item = btn.closest(".snapshot-item");
      const id = item.dataset.id;
      const index = parseInt(item.dataset.index);
      const action = btn.dataset.action;

      if (action === "delete") {
        deleteSnapshot(id);
      } else if (action === "preview") {
        const snapshot = codeSnapshots.find((s) => s.id === id);
        if (snapshot) showCodeModal(snapshot, index);
      }
    });
  });
}

/**
 * Gets all snapshots to save to Notion.
 * @returns {Array} Array of snapshot objects
 */
function getSnapshotsForSave() {
  return codeSnapshots;
}

/**
 * Opens stats modal and loads data.
 */
async function openStatsModal() {
  DOM.stats.modal?.classList.remove("hidden");
  await loadStats();
}

/**
 * Closes stats modal.
 */
function closeStatsModal() {
  DOM.stats.modal?.classList.add("hidden");
}

/**
 * Loads stats from Notion database.
 */
async function loadStats() {
  const settings = await chrome.storage.sync.get([
    "notionApiKey",
    "notionDatabaseId",
  ]);

  if (!settings.notionApiKey || !settings.notionDatabaseId) {
    DOM.stats.content?.classList.add("hidden");
    DOM.stats.loading?.classList.add("hidden");
    DOM.stats.error?.classList.remove("hidden");
    return;
  }

  DOM.stats.content?.classList.add("hidden");
  DOM.stats.error?.classList.add("hidden");
  DOM.stats.loading?.classList.remove("hidden");

  try {
    const response = await chrome.runtime.sendMessage({
      action: "getStats",
      data: {
        apiKey: settings.notionApiKey,
        databaseId: settings.notionDatabaseId,
      },
    });

    if (response?.success) {
      DOM.stats.total.textContent = response.total || 0;
      DOM.stats.easy.textContent = response.easy || 0;
      DOM.stats.medium.textContent = response.medium || 0;
      DOM.stats.hard.textContent = response.hard || 0;

      const dueCount = response.dueForReview || 0;
      DOM.stats.dueReview.textContent =
        dueCount === 0
          ? "No problems due for review 🎉"
          : `${dueCount} problem${dueCount > 1 ? "s" : ""} due for review`;

      DOM.stats.loading?.classList.add("hidden");
      DOM.stats.content?.classList.remove("hidden");
    } else {
      throw new Error(response?.error || "Failed to load stats");
    }
  } catch (error) {
    console.error("Error loading stats:", error);
    DOM.stats.loading?.classList.add("hidden");
    DOM.stats.error?.classList.remove("hidden");
  }
}

/**
 * Opens the setup wizard in a new tab.
 */
function openSetupWizard() {
  chrome.tabs.create({ url: chrome.runtime.getURL("onboarding.html") });
  window.close();
}
