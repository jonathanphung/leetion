/**
 * super-board QA — issue #10. In-memory Notion double.
 *
 * Stands in for `fetch` inside the REAL background.js. It is a *stateful*
 * server, not a request recorder: a PATCH mutates the stored page and a later
 * GET / database query reads that mutation back. That is what lets this suite
 * answer AC1's "verified on the Notion page, not just the popup toast" at the
 * API-contract level — the assertion is against what the page holds after the
 * write, not against the request body the extension happened to send.
 *
 * Supported endpoints (the only ones background.js uses on these paths):
 *   PATCH pages/{id}                → merge `properties` into the stored page
 *   GET   pages/{id}                → the stored page
 *   POST  databases/{id}/query      → results, honouring the date filter shape
 *                                     checkDueReviews uses
 *                                     ({property, date:{on_or_before}})
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

  function matchesFilter(page, filter) {
    if (!filter) return true;
    // #11 made checkDueReviews send a compound `and:` (is_not_empty +
    // on_or_before) so a cleared review date cannot read as due. Without this
    // branch the flat-shape logic below matches nothing it understands and
    // falls through to `return true`, i.e. EVERY page comes back "due" — which
    // reads as a product regression when it is only the double being blind.
    if (Array.isArray(filter.and)) {
      return filter.and.every((f) => matchesFilter(page, f));
    }
    if (Array.isArray(filter.or)) {
      return filter.or.some((f) => matchesFilter(page, f));
    }
    const prop = page.properties[filter.property];
    if (filter.date?.is_not_empty) return !!prop?.date?.start;
    if (filter.date) {
      const start = prop?.date?.start;
      if (!start) return false;
      if (filter.date.on_or_before) return start <= filter.date.on_or_before;
      if (filter.date.on_or_after) return start >= filter.date.on_or_after;
      if (filter.date.equals) return start === filter.date.equals;
    }
    // checkExistingProblem looks a page up by its problem number.
    if (filter.number) {
      const n = prop?.number;
      if (filter.number.equals !== undefined) return n === filter.number.equals;
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

    // GET databases/{id} — schema probe; irrelevant to this card, answer benignly
    m = endpoint.match(/^databases\/([^/?]+)$/);
    if (m && method === "GET") {
      return json(200, { id: m[1], object: "database", properties: {} });
    }

    // GET blocks/{id}/children — page body. The popup's checkExisting path
    // walks it; this card touches no page content, so an empty body is honest.
    if (/^blocks\/[^/]+\/children/.test(endpoint) && method === "GET") {
      return json(200, { results: [], has_more: false, next_cursor: null });
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
    attempts: (id) => pages.get(id)?.properties?.["Attempts"]?.number ?? null,
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
    lastRequest: () => requests[requests.length - 1] ?? null,
    requestsFor: (re) => requests.filter((r) => re.test(r.endpoint)),
    reset: () => {
      requests.length = 0;
    },
  };
}
