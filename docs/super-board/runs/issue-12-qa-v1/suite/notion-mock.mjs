/**
 * super-board QA — issue #12. In-memory Notion double.
 *
 * Stands in for `fetch` inside the REAL background.js. It is a *stateful*
 * server, not a request recorder: a POST creates a page, a PATCH mutates the
 * stored page, and a later GET / database query reads that mutation back. That
 * is what lets this suite answer "confirm all six property values in Notion"
 * at the API-contract level — the assertions are against what the row holds
 * after the write, not against the request body the extension happened to
 * send.
 *
 * Extends the issue-10 double with the create path this card needs:
 *   POST  pages                     → create a row, storing properties AND
 *                                     children (so "no solution content" is
 *                                     an assertion about the stored page)
 *   GET   databases/{id}            → a real column schema, so
 *                                     inspectDatabaseSchema's missing /
 *                                     mismatch branches can be driven
 *   PATCH databases/{id}            → ensureDatabaseSchema column creation
 *   PATCH pages/{id}                → merge `properties` into the stored page
 *   GET   pages/{id}                → the stored page
 *   POST  databases/{id}/query      → results, honouring both filter shapes
 *                                     the extension uses:
 *                                     {property, date:{on_or_before}} and
 *                                     {property:"S No.", number:{equals}}
 *   GET/PATCH/DELETE blocks/...     → page body
 */

/** The full column set a correctly-set-up Leetion database has. */
export const FULL_SCHEMA = {
  Question: { type: "title", title: {} },
  "S No.": { type: "number", number: { format: "number" } },
  Level: { type: "select", select: { options: [] } },
  Tag: { type: "multi_select", multi_select: { options: [] } },
  "My Expertise": { type: "select", select: { options: [] } },
  Done: { type: "checkbox", checkbox: {} },
  "Date (of first attempt)": { type: "date", date: {} },
  "Question Link": { type: "url", url: {} },
  Remark: { type: "rich_text", rich_text: {} },
  "Alternative Method Tags": { type: "multi_select", multi_select: { options: [] } },
  "Spaced Repetition": { type: "date", date: {} },
  "Time Complexity": { type: "select", select: { options: [] } },
  "Space Complexity": { type: "select", select: { options: [] } },
  Attempts: { type: "number", number: { format: "number" } },
  // Added by #5. FULL_SCHEMA means "a database carrying every column Leetion
  // needs", so it has to track DATABASE_SCHEMA — otherwise every save in this
  // suite trips #4's missing-column confirmation instead of exercising the
  // path under test. The deliberate missing-column scenarios below build from
  // this object and delete their own targets, so they are unaffected.
  Submissions: { type: "number", number: { format: "number" } },
};

export function createNotionMock(seed = {}, options = {}) {
  const pages = new Map();
  const requests = [];
  const schema = structuredClone(options.schema || FULL_SCHEMA);
  let failNext = null; // {status, message, remaining}
  let failMatch = null; // RegExp restricting which endpoint the failure hits
  let created = 0;

  for (const [id, properties] of Object.entries(seed)) {
    pages.set(id, {
      id,
      object: "page",
      properties: structuredClone(properties),
      children: [],
      last_edited_time: new Date().toISOString(),
    });
  }

  function ensure(id) {
    if (!pages.has(id)) {
      pages.set(id, { id, object: "page", properties: {}, children: [] });
    }
    return pages.get(id);
  }

  function matchesFilter(page, filter) {
    if (!filter) return true;
    const prop = page.properties[filter.property];
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

    if (
      failNext &&
      failNext.remaining > 0 &&
      (!failMatch || failMatch.test(endpoint))
    ) {
      failNext.remaining -= 1;
      return json(failNext.status, {
        message: failNext.message,
        code: "qa_forced_failure",
      });
    }

    // POST pages — create a row.
    if (endpoint === "pages" && method === "POST") {
      const id = `qa-created-${++created}`;
      pages.set(id, {
        id,
        object: "page",
        parent: body?.parent,
        properties: structuredClone(body?.properties || {}),
        children: structuredClone(body?.children || []),
        last_edited_time: new Date().toISOString(),
      });
      return json(200, structuredClone(pages.get(id)));
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

    // GET databases/{id} — the schema probe inspectDatabaseSchema reads.
    m = endpoint.match(/^databases\/([^/?]+)$/);
    if (m && method === "GET") {
      return json(200, {
        id: m[1],
        object: "database",
        title: [{ plain_text: "QA DB" }],
        properties: structuredClone(schema),
      });
    }

    // PATCH databases/{id} — ensureDatabaseSchema column creation.
    if (m && method === "PATCH") {
      Object.assign(schema, structuredClone(body?.properties || {}));
      return json(200, { id: m[1], object: "database", properties: structuredClone(schema) });
    }

    // GET blocks/{id}/children — page body.
    m = endpoint.match(/^blocks\/([^/?]+)\/children/);
    if (m && method === "GET") {
      const page = pages.get(m[1]);
      return json(200, {
        results: structuredClone(page?.children || []),
        has_more: false,
        next_cursor: null,
      });
    }
    if (m && method === "PATCH") {
      const page = ensure(m[1]);
      page.children.push(...structuredClone(body?.children || []));
      return json(200, { results: [] });
    }

    // DELETE blocks/{id}
    m = endpoint.match(/^blocks\/([^/?]+)$/);
    if (m && method === "DELETE") {
      return json(200, { id: m[1], archived: true });
    }

    return json(404, { message: `qa mock: unhandled ${method} ${endpoint}` });
  }

  return {
    fetch: fetchDouble,
    pages,
    requests,
    schema,
    page: (id) => structuredClone(pages.get(id)),
    /** The single row created during this scenario (creates are asserted 1:1). */
    createdPages: () => [...pages.values()].filter((p) => p.id.startsWith("qa-created-")),
    onlyCreated: () => {
      const list = [...pages.values()].filter((p) => p.id.startsWith("qa-created-"));
      return list.length === 1 ? structuredClone(list[0]) : null;
    },
    createCount: () => requests.filter((r) => r.endpoint === "pages" && r.method === "POST").length,
    prop: (id, name) => structuredClone(pages.get(id)?.properties?.[name]),
    reviewDate: (id) => pages.get(id)?.properties?.["Spaced Repetition"]?.date?.start ?? null,
    attempts: (id) => pages.get(id)?.properties?.["Attempts"]?.number ?? null,
    setPage: (id, properties) => {
      pages.set(id, {
        id,
        object: "page",
        properties: structuredClone(properties),
        children: [],
        last_edited_time: new Date().toISOString(),
      });
    },
    /**
     * Force the next `times` HTTP calls to fail. Defaults to 3 because
     * notionRequest retries up to MAX_RETRIES=3 — a single-shot failure would
     * be swallowed by the retry and the test would prove nothing.
     * `match` restricts the failure to endpoints matching that RegExp, so a
     * write can be failed without also taking down the read before it.
     */
    failNextWith: (status, message, times = 3, match = null) => {
      failNext = { status, message, remaining: times };
      failMatch = match;
    },
    lastRequest: () => requests[requests.length - 1] ?? null,
    requestsFor: (re) => requests.filter((r) => re.test(r.endpoint)),
    reset: () => {
      requests.length = 0;
    },
  };
}
