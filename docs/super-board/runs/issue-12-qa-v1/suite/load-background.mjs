/**
 * super-board QA — issue #12. Loader for the REAL background.js.
 *
 * background.js is a plain (non-module) service-worker script, so it can be
 * evaluated inside a `Function` whose parameters shadow the three globals it
 * touches at the boundary: `chrome`, `fetch`, `Date`. Nothing in the product
 * file is rewritten — the code under test is byte-identical to what ships.
 *
 * The loader deliberately exposes the message router (`chrome.runtime
 * .onMessage`) rather than only the internal functions: the popup's real entry
 * point is `chrome.runtime.sendMessage`, so `send()` exercises the same path a
 * click does, dispatcher included. `markTodo` is a message action, so this is
 * the only honest way to test it.
 */
import fs from "node:fs";

const noop = () => {};

export function frozenDateAt(isoNow) {
  const fixed = new Date(isoNow).getTime();
  return class FrozenDate extends Date {
    constructor(...args) {
      if (args.length === 0) super(fixed);
      else super(...args);
    }
    static now() {
      return fixed;
    }
  };
}

/**
 * @param {object} opts
 * @param {string} opts.file       path to background.js
 * @param {string} opts.isoNow     instant to freeze the clock at
 * @param {Function} opts.fetch    fetch double (see notion-mock.mjs)
 * @param {object} [opts.sync]     chrome.storage.sync contents
 */
export function loadBackground({ file, isoNow, fetch: fetchDouble, sync = {} }) {
  const src = fs.readFileSync(file, "utf8");

  const listeners = { message: [], alarm: [], installed: [], startup: [] };
  const notifications = [];
  const badges = [];

  const chromeStub = {
    runtime: {
      onMessage: { addListener: (fn) => listeners.message.push(fn) },
      onStartup: { addListener: (fn) => listeners.startup.push(fn) },
      onInstalled: { addListener: (fn) => listeners.installed.push(fn) },
      sendMessage: noop,
      getURL: (p) => p,
      lastError: null,
    },
    alarms: {
      create: noop,
      clear: noop,
      onAlarm: { addListener: (fn) => listeners.alarm.push(fn) },
    },
    storage: {
      sync: {
        get: async (keys) => {
          if (!keys) return { ...sync };
          const list = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(
            list.filter((k) => k in sync).map((k) => [k, sync[k]]),
          );
        },
        set: async (obj) => Object.assign(sync, obj),
        remove: async (k) => {
          for (const key of Array.isArray(k) ? k : [k]) delete sync[key];
        },
      },
      local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
    },
    tabs: { create: noop, query: async () => [], onUpdated: { addListener: noop } },
    notifications: {
      create: (id, opts, cb) => {
        notifications.push({ id, ...opts });
        cb?.(id);
      },
      onClicked: { addListener: noop },
    },
    action: {
      setBadgeText: (o) => badges.push(o),
      setBadgeBackgroundColor: noop,
    },
  };

  const exposed = [
    "handleMessage",
    "saveToNotion",
    "checkExistingProblem",
    "checkDueReviews",
    "handleGetStats",
    "buildProperties",
    "buildTodoProperties",
    "localDateString",
    "localDateInDays",
  ];

  // `typeof` guards so the same loader can also be pointed at a PRE-fix
  // background.js (the negative control), where buildTodoProperties does not
  // exist yet — that run must produce assertion failures, not a ReferenceError
  // at load time.
  const returns = exposed
    .map((n) => `${n}: typeof ${n} === "function" ? ${n} : undefined`)
    .join(", ");

  const factory = new Function("chrome", "fetch", "Date", `${src}\n; return { ${returns} };`);

  const api = factory(chromeStub, fetchDouble, frozenDateAt(isoNow));

  /** Dispatch through the REAL onMessage listener, exactly as the popup does. */
  function send(message) {
    return new Promise((resolve, reject) => {
      if (listeners.message.length === 0) {
        reject(new Error("background.js registered no onMessage listener"));
        return;
      }
      let settled = false;
      const keepAlive = listeners.message[0](message, { id: "qa" }, (response) => {
        settled = true;
        resolve(response);
      });
      if (keepAlive !== true && !settled) {
        reject(new Error("listener returned falsy without responding"));
      }
    });
  }

  return { api, send, chrome: chromeStub, notifications, badges, sync, listeners };
}
