/**
 * QA mock environment for issue #2 (cross-device sync).
 *
 * Pure ESM, no Node/browser-specific APIs, so the same mocks power:
 *  - the headless Node suite (test-sync.mjs), and
 *  - the visual browser harness (harness-boot.mjs).
 *
 * Provides:
 *  - createNotionMock()  : in-memory Notion "cloud" (pages, blocks, database)
 *                          implementing every endpoint background.js calls.
 *  - createNotionFetch() : fetch() replacement routing api.notion.com to the mock.
 *  - createChromeMock()  : chrome.* stub (storage/local+sync, runtime message
 *                          bus, tabs, scripting, alarms, notifications).
 *  - parseSolutionsFromPage(): independent re-parser of a mock page's
 *                          "Solution(s)" section used for assertions (kept
 *                          intentionally separate from background.js's parser).
 */

export function jsonClone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

// ---------------------------------------------------------------------------
// Notion cloud mock
// ---------------------------------------------------------------------------

const READ_DB_PROPERTIES = {
  Question: { type: "title" },
  "S No.": { type: "number" },
  Level: { type: "select" },
  Tag: { type: "multi_select" },
  "My Expertise": { type: "select" },
  Done: { type: "checkbox" },
  "Date (of first attempt)": { type: "date" },
  "Question Link": { type: "url" },
  Remark: { type: "rich_text" },
  "Alternative Method Tags": { type: "multi_select" },
  "Spaced Repetition": { type: "date" },
  "Time Complexity": { type: "select" },
  "Space Complexity": { type: "select" },
  Attempts: { type: "number" },
  // Added by #5. This fixture stands for a fully provisioned database, so it
  // has to track DATABASE_SCHEMA — without it every save here trips #4's
  // missing-column confirmation and reports "Error connecting to Notion".
  Submissions: { type: "number" },
};

function normalizeRichTextArray(arr) {
  return (arr || []).map((t) => {
    const content = t?.text?.content ?? t?.plain_text ?? "";
    const out = {
      type: "text",
      text: { content },
      plain_text: content,
    };
    if (t?.annotations) out.annotations = jsonClone(t.annotations);
    return out;
  });
}

const RICH_TEXT_BLOCK_TYPES = [
  "heading_1",
  "heading_2",
  "heading_3",
  "paragraph",
  "bulleted_list_item",
  "numbered_list_item",
  "quote",
  "code",
];

export function createNotionMock(initialState, onMutate) {
  const state = initialState || {
    databaseId: "qa-database-0001",
    nextPageId: 1,
    nextBlockId: 1,
    pages: {}, // id -> { id, properties, children[], created_time, last_edited_time }
    requestLog: [],
  };

  function touch() {
    if (onMutate) onMutate(state);
  }

  function normalizeBlock(block) {
    const nb = jsonClone(block) || {};
    nb.object = "block";
    nb.id = `blk_${state.nextBlockId++}`;
    for (const t of RICH_TEXT_BLOCK_TYPES) {
      if (nb.type === t && nb[t]) {
        if (nb[t].rich_text) nb[t].rich_text = normalizeRichTextArray(nb[t].rich_text);
        if (t === "code") nb[t].caption = normalizeRichTextArray(nb[t].caption);
      }
    }
    return nb;
  }

  function normalizeProperties(props) {
    const np = jsonClone(props) || {};
    for (const key of Object.keys(np)) {
      const p = np[key];
      if (p && p.title) p.title = normalizeRichTextArray(p.title);
      if (p && p.rich_text) p.rich_text = normalizeRichTextArray(p.rich_text);
    }
    return np;
  }

  function pageRead(page) {
    return {
      id: page.id,
      object: "page",
      created_time: page.created_time,
      last_edited_time: page.last_edited_time,
      properties: jsonClone(page.properties),
    };
  }

  const api = {
    state,

    reset() {
      state.pages = {};
      state.nextPageId = 1;
      state.nextBlockId = 1;
      state.requestLog = [];
      touch();
    },

    /** Test hook: force a page's last_edited_time (ISO string or ms). */
    setLastEdited(pageId, when) {
      const page = state.pages[pageId];
      if (!page) throw new Error(`setLastEdited: no page ${pageId}`);
      page.last_edited_time =
        typeof when === "number" ? new Date(when).toISOString() : when;
      touch();
    },

    pageByNumber(n) {
      return (
        Object.values(state.pages).find(
          (p) => p.properties?.["S No."]?.number === n,
        ) || null
      );
    },

    /** Route one request. Returns { status, payload }. */
    route(method, endpoint, body) {
      state.requestLog.push({ method, endpoint });
      const now = () => new Date().toISOString();

      // GET/PATCH databases/{id}
      let m = endpoint.match(/^databases\/([^/?]+)$/);
      if (m) {
        if (method === "GET") {
          return {
            status: 200,
            payload: {
              id: m[1],
              object: "database",
              title: [{ plain_text: "QA Mock DB", type: "text" }],
              properties: jsonClone(READ_DB_PROPERTIES),
            },
          };
        }
        if (method === "PATCH") {
          return { status: 200, payload: { id: m[1], object: "database" } };
        }
      }

      // POST databases/{id}/query
      m = endpoint.match(/^databases\/([^/?]+)\/query$/);
      if (m && method === "POST") {
        const filter = body?.filter || {};
        let results = [];
        if (filter.property === "S No." && filter.number?.equals !== undefined) {
          const page = api.pageByNumber(filter.number.equals);
          if (page) results = [pageRead(page)];
        }
        return { status: 200, payload: { results, has_more: false } };
      }

      // POST pages (create)
      if (endpoint === "pages" && method === "POST") {
        const id = `page_${state.nextPageId++}`;
        const page = {
          id,
          properties: normalizeProperties(body?.properties),
          children: (body?.children || []).map(normalizeBlock),
          created_time: now(),
          last_edited_time: now(),
        };
        state.pages[id] = page;
        touch();
        return { status: 200, payload: pageRead(page) };
      }

      // GET pages/{id} (property read) — used by the server-fresh Attempts
      // read that runs immediately before the properties PATCH (issue #1).
      m = endpoint.match(/^pages\/([^/?]+)$/);
      if (m && method === "GET") {
        const page = state.pages[m[1]];
        if (!page) return { status: 404, payload: { message: "page not found", code: "object_not_found" } };
        return { status: 200, payload: pageRead(page) };
      }

      // PATCH pages/{id} (properties update)
      if (m && method === "PATCH") {
        const page = state.pages[m[1]];
        if (!page) return { status: 404, payload: { message: "page not found", code: "object_not_found" } };
        const np = normalizeProperties(body?.properties);
        for (const key of Object.keys(np)) page.properties[key] = np[key];
        page.last_edited_time = now();
        touch();
        return { status: 200, payload: pageRead(page) };
      }

      // GET/PATCH blocks/{pageId}/children
      m = endpoint.match(/^blocks\/([^/?]+)\/children(?:\?(.*))?$/);
      if (m) {
        const page = state.pages[m[1]];
        if (!page) return { status: 404, payload: { message: "block not found", code: "object_not_found" } };
        if (method === "GET") {
          const params = new URLSearchParams(m[2] || "");
          const pageSize = parseInt(params.get("page_size") || "100", 10);
          const start = parseInt(params.get("start_cursor") || "0", 10);
          const slice = page.children.slice(start, start + pageSize);
          const hasMore = start + pageSize < page.children.length;
          return {
            status: 200,
            payload: {
              results: jsonClone(slice),
              has_more: hasMore,
              next_cursor: hasMore ? String(start + pageSize) : null,
            },
          };
        }
        if (method === "PATCH") {
          const added = (body?.children || []).map(normalizeBlock);
          page.children.push(...added);
          page.last_edited_time = now();
          touch();
          return { status: 200, payload: { results: jsonClone(added) } };
        }
      }

      // DELETE blocks/{blockId}
      m = endpoint.match(/^blocks\/([^/?]+)$/);
      if (m && method === "DELETE") {
        for (const page of Object.values(state.pages)) {
          const idx = page.children.findIndex((b) => b.id === m[1]);
          if (idx !== -1) {
            page.children.splice(idx, 1);
            page.last_edited_time = now();
            touch();
            return { status: 200, payload: { id: m[1], archived: true } };
          }
        }
        return { status: 404, payload: { message: "block not found", code: "object_not_found" } };
      }

      return {
        status: 400,
        payload: { message: `mock: unhandled ${method} ${endpoint}`, code: "validation_error" },
      };
    },
  };

  return api;
}

export function createNotionFetch(notionMock, realFetch) {
  return async function qaFetch(url, options = {}) {
    const s = String(url);
    const prefix = "https://api.notion.com/v1/";
    if (!s.startsWith(prefix)) {
      if (realFetch) return realFetch(url, options);
      throw new Error(`qaFetch: unexpected non-Notion URL ${s}`);
    }
    const endpoint = s.slice(prefix.length);
    const method = (options.method || "GET").toUpperCase();
    const body = options.body ? JSON.parse(options.body) : null;
    const { status, payload } = notionMock.route(method, endpoint, body);
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      json: async () => jsonClone(payload),
    };
  };
}

// ---------------------------------------------------------------------------
// chrome.* mock
// ---------------------------------------------------------------------------

/**
 * @param {object} opts
 * @param {object} opts.bus            shared { listeners: [] } — the runtime
 *                                     message bus connecting popup & background
 * @param {object} opts.localData      backing object for chrome.storage.local
 * @param {object} opts.syncData       backing object for chrome.storage.sync
 * @param {Array}  opts.syncSetLog     shared audit log of storage.sync.set calls
 * @param {object} opts.problemFixture what scripting.executeScript "scrapes"
 * @param {string} opts.tabUrl         active tab URL
 * @param {function} [opts.onLocalMutate] called after any storage.local write
 */
export function createChromeMock(opts) {
  const {
    bus,
    localData = {},
    syncData = {},
    syncSetLog = [],
    problemFixture = null,
    tabUrl = "https://leetcode.com/problems/two-sum/",
    onLocalMutate,
  } = opts;

  function makeArea(backing, { onSet, onMutate } = {}) {
    return {
      _data: backing,
      async get(keys) {
        const out = {};
        let list;
        if (keys == null) list = Object.keys(backing);
        else if (typeof keys === "string") list = [keys];
        else if (Array.isArray(keys)) list = keys;
        else {
          // object form: keys with defaults
          for (const [k, dflt] of Object.entries(keys)) {
            out[k] = k in backing ? jsonClone(backing[k]) : jsonClone(dflt);
          }
          return out;
        }
        for (const k of list) {
          if (k in backing) out[k] = jsonClone(backing[k]);
        }
        return out;
      },
      async set(obj) {
        if (onSet) onSet(obj);
        for (const [k, v] of Object.entries(obj)) backing[k] = jsonClone(v);
        if (onMutate) onMutate();
      },
      async remove(keys) {
        const list = typeof keys === "string" ? [keys] : keys;
        for (const k of list) delete backing[k];
        if (onMutate) onMutate();
      },
      async clear() {
        for (const k of Object.keys(backing)) delete backing[k];
        if (onMutate) onMutate();
      },
    };
  }

  const chrome = {
    storage: {
      local: makeArea(localData, { onMutate: onLocalMutate }),
      sync: makeArea(syncData, {
        onSet: (obj) =>
          syncSetLog.push({
            keys: Object.keys(obj),
            bytes: JSON.stringify(obj).length,
            value: jsonClone(obj),
          }),
      }),
      onChanged: { addListener() {} },
    },
    runtime: {
      lastError: undefined,
      onMessage: {
        addListener(fn) {
          bus.listeners.push(fn);
        },
      },
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      getURL: (p) => p,
      openOptionsPage() {},
      sendMessage(message) {
        return new Promise((resolve, reject) => {
          const msg = jsonClone(message);
          const deliver = () => {
            let responded = false;
            const sendResponse = (resp) => {
              if (responded) return;
              responded = true;
              resolve(jsonClone(resp));
            };
            let keptOpen = false;
            for (const fn of bus.listeners) {
              try {
                const r = fn(msg, { id: "qa-sender" }, sendResponse);
                if (r === true) keptOpen = true;
              } catch (e) {
                reject(e);
                return;
              }
            }
            if (!keptOpen && !responded) resolve(undefined);
          };
          if (bus.listeners.length === 0) {
            // background may not have registered yet (module load order)
            const t = setInterval(() => {
              if (bus.listeners.length > 0) {
                clearInterval(t);
                deliver();
              }
            }, 5);
          } else {
            deliver();
          }
        });
      },
    },
    tabs: {
      async query() {
        return [{ id: 1, url: tabUrl, active: true }];
      },
      sendMessage(_tabId, _msg, cb) {
        if (cb) cb();
      },
      create() {},
      onUpdated: { addListener() {} },
    },
    scripting: {
      async executeScript() {
        return [{ result: jsonClone(problemFixture) }];
      },
    },
    alarms: {
      create() {},
      clear() {},
      onAlarm: { addListener() {} },
    },
    notifications: { create() {} },
    action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
  };

  return chrome;
}

// ---------------------------------------------------------------------------
// Assertion-side page parser (independent of background.js)
// ---------------------------------------------------------------------------

function blockText(block, type) {
  return (block?.[type]?.rich_text || []).map((t) => t.plain_text).join("");
}

/**
 * Walks a mock page's children and reconstructs the "Solution(s)" section as
 * [{ heading, language, caption, code }]. Consecutive code blocks under one
 * H3 are one solution (chunk-joined with \n, mirroring the save-side split).
 */
export function parseSolutionsFromPage(page) {
  const solutions = [];
  let inSolutions = false;
  let current = null;
  for (const block of page?.children || []) {
    if (block.type === "heading_2") {
      inSolutions = blockText(block, "heading_2") === "Solution(s)";
      current = null;
      continue;
    }
    if (!inSolutions) continue;
    if (block.type === "heading_3") {
      current = {
        heading: blockText(block, "heading_3"),
        language: null,
        caption: "",
        chunks: [],
      };
      solutions.push(current);
      continue;
    }
    if (block.type === "code") {
      const codeText = (block.code?.rich_text || [])
        .map((t) => t.plain_text)
        .join("");
      const caption = block.code?.caption?.[0]?.plain_text || "";
      if (!current) {
        current = { heading: null, language: null, caption: "", chunks: [] };
        solutions.push(current);
      }
      if (current.language === null) {
        current.language = block.code?.language || "plain text";
        current.caption = caption;
      }
      current.chunks.push(codeText);
    }
  }
  return solutions.map((s) => ({
    heading: s.heading,
    language: s.language,
    caption: s.caption,
    code: s.chunks.join("\n"),
  }));
}

/** Extracts the "Notes" section as joined plain text (paragraphs + bullets). */
export function parseNotesFromPage(page) {
  const out = [];
  let inNotes = false;
  for (const block of page?.children || []) {
    if (block.type === "heading_2") {
      inNotes = blockText(block, "heading_2") === "Notes";
      continue;
    }
    if (!inNotes) continue;
    if (block.type === "paragraph") out.push(blockText(block, "paragraph"));
    if (block.type === "bulleted_list_item")
      out.push("- " + blockText(block, "bulleted_list_item"));
    if (block.type === "numbered_list_item")
      out.push("1. " + blockText(block, "numbered_list_item"));
  }
  return out.filter(Boolean).join("\n");
}
