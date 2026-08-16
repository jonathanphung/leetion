/**
 * super-board QA — issue #11. In-memory Notion double.
 *
 * Stands in for `fetch` inside the REAL background.js. It is a *stateful*
 * server, not a request recorder: a PATCH mutates the stored page and a later
 * GET / database query reads that mutation back. That is what lets AC1's
 * "verified on the Notion page" be answered at the API-contract level — the
 * assertion is against what the page holds after the write, not against the
 * request body the extension happened to send.
 *
 * Grown from the issue-#10 double with the two filter forms this card needs:
 *   • compound `and` / `or` filters — checkDueReviews now sends `and: [...]`
 *   • `is_not_empty` / `is_empty` on a date property
 * Both follow Notion's documented semantics, including the one that matters
 * most here: a date comparator like `on_or_before` never matches an EMPTY
 * date property. That is the behaviour AC5 rides on, so the double models it
 * rather than assuming it.
 *
 * Supported endpoints (the only ones background.js uses on these paths):
 *   PATCH pages/{id}                → merge `properties` into the stored page
 *   GET   pages/{id}                → the stored page
 *   POST  databases/{id}/query      → results, honouring the filter
 *   GET   databases/{id}            → schema probe
 *   GET   blocks/{id}/children      → page body
 */

export function createNotionMock(seed = {}) {
  const pages = new Map();
  const requests = [];
  let failNext = null; // {status, message, remaining}

  for (const [id, properties] of Object.entries(seed)) {
    pages.set(id, { id, object: "page", properties: structuredClone(properties) });
  }

  function ensure(id) {
    if (!pages.has(id)) {
      pages.set(id, { id, object: "page", properties: {} });
    }
    return pages.get(id);
  }

  function matchesDate(prop, cond) {
    // Notion treats a date property with no value as empty; every comparator
    // except `is_empty` fails against it.
    const start = prop?.date?.start ?? null;
    if (cond.is_empty === true) return start === null;
    if (cond.is_not_empty === true) return start !== null;
    if (start === null) return false;
    if (cond.on_or_before !== undefined) return start <= cond.on_or_before;
    if (cond.on_or_after !== undefined) return start >= cond.on_or_after;
    if (cond.before !== undefined) return start < cond.before;
    if (cond.after !== undefined) return start > cond.after;
    if (cond.equals !== undefined) return start === cond.equals;
    return true;
  }

  function matchesFilter(page, filter) {
    if (!filter) return true;
    if (Array.isArray(filter.and)) {
      return filter.and.every((f) => matchesFilter(page, f));
    }
    if (Array.isArray(filter.or)) {
      return filter.or.some((f) => matchesFilter(page, f));
    }
    const prop = page.properties[filter.property];
    if (filter.date) return matchesDate(prop, filter.date);
    // checkExistingProblem looks a page up by its problem number.
    if (filter.number) {
      const n = prop?.number;
      if (filter.number.equals !== undefined) return n === filter.number.equals;
    }
    if (filter.checkbox) {
      const c = prop?.checkbox === true;
      if (filter.checkbox.equals !== undefined) return c === filter.checkbox.equals;
    }
    return true;
  }

  function json(status, body) {
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      json: async () => body,
    };
  }

  async function fetchDouble(url, options = {}) {
    const endpoint = String(url).replace("https://api.notion.com/v1/", "");
    const method = options.method || "GET";
    const body = options.body ? JSON.parse(options.body) : null;
    requests.push({ endpoint, method, body });

    if (failNext && failNext.remaining > 0) {
      failNext.remaining -= 1;
      return json(failNext.status, {
        message: failNext.message,
        code: "qa_forced_failure",
      });
    }

    // PATCH pages/{id}
    let m = endpoint.match(/^pages\/([^/?]+)$/);
    if (m && method === "PATCH") {
      const page = ensure(m[1]);
      // Object.assign mirrors Notion's per-property merge: a property in the
      // body replaces the stored one, everything else is left alone. A
      // `{date: null}` therefore lands as a stored-but-empty date, exactly as
      // Notion records a cleared date property.
      Object.assign(page.properties, structuredClone(body?.properties || {}));
      page.last_edited_time = new Date().toISOString();
      return json(200, structuredClone(page));
    }

    // GET pages/{id}
    if (m && method === "GET") {
      if (!pages.has(m[1])) return json(404, { message: "Could not find page" });
      return json(200, structuredClone(pages.get(m[1])));
    }

    // POST databases/{id}/query
    m = endpoint.match(/^databases\/([^/?]+)\/query$/);
    if (m && method === "POST") {
      const results = [...pages.values()]
        .filter((p) => matchesFilter(p, body?.filter))
        .map((p) => structuredClone(p));
      return json(200, { results, has_more: false });
    }

    // POST pages — create
    if (endpoint === "pages" && method === "POST") {
      const id = `qa-created-${pages.size + 1}`;
      pages.set(id, {
        id,
        object: "page",
        properties: structuredClone(body?.properties || {}),
      });
      return json(200, structuredClone(pages.get(id)));
    }

    // GET databases/{id} — schema probe. Answer with the full Leetion schema
    // so saveToNotion's inspect step finds nothing missing and nothing
    // mismatched, and the save proceeds to the write under test.
    m = endpoint.match(/^databases\/([^/?]+)$/);
    if (m && method === "GET") {
      return json(200, {
        id: m[1],
        object: "database",
        // Mirrors DATABASE_SCHEMA in background.js exactly (names + types), so
        // inspectDatabaseSchema finds nothing missing and nothing mismatched
        // and the save proceeds to the write under test. A name drifting here
        // would surface as a needsSchemaConfirmation bail, not a silent pass.
        properties: {
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
          // Added by #5 — this fixture stands for a fully provisioned
          // database, so it has to track DATABASE_SCHEMA. Without it every
          // save here trips #4's missing-column confirmation instead of
          // reaching the clear-review-date path under test.
          Submissions: { type: "number" },
        },
      });
    }

    // GET/PATCH blocks/{id}/children — page body.
    if (/^blocks\/[^/]+\/children/.test(endpoint)) {
      return json(200, { results: [], has_more: false, next_cursor: null });
    }
    if (/^blocks\/[^/]+$/.test(endpoint) && method === "DELETE") {
      return json(200, { id: endpoint.split("/")[1], archived: true });
    }

    return json(404, { message: `qa mock: unhandled ${method} ${endpoint}` });
  }

  return {
    fetch: fetchDouble,
    pages,
    requests,
    page: (id) => structuredClone(pages.get(id)),
    prop: (id, name) => structuredClone(pages.get(id)?.properties?.[name]),
    reviewDate: (id) => pages.get(id)?.properties?.["Spaced Repetition"]?.date?.start ?? null,
    /** True when the page carries the property at all (even emptied). */
    hasReviewProp: (id) =>
      Object.prototype.hasOwnProperty.call(
        pages.get(id)?.properties ?? {},
        "Spaced Repetition",
      ),
    /** The raw stored value, so `{date: null}` can be asserted exactly. */
    rawReview: (id) => structuredClone(pages.get(id)?.properties?.["Spaced Repetition"] ?? null),
    attempts: (id) => pages.get(id)?.properties?.["Attempts"]?.number ?? null,
    done: (id) => pages.get(id)?.properties?.["Done"]?.checkbox ?? null,
    setPage: (id, properties) => {
      pages.set(id, { id, object: "page", properties: structuredClone(properties) });
    },
    /**
     * Force the next `times` HTTP calls to fail. Defaults to 3 because
     * notionRequest retries up to MAX_RETRIES=3 — a single-shot failure would
     * be swallowed by the retry and the test would prove nothing.
     */
    failNextWith: (status, message, times = 3) => {
      failNext = { status, message, remaining: times };
    },
    clearFailure: () => {
      failNext = null;
    },
    lastRequest: () => requests[requests.length - 1] ?? null,
    requestsFor: (re) => requests.filter((r) => re.test(r.endpoint)),
    reset: () => {
      requests.length = 0;
    },
  };
}
