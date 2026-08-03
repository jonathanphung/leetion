/**
 * Minimal DOM double for running the REAL popup.js inside a Node `vm` context.
 *
 * popup.js is exercised unmodified; only the host environment is faked.
 * Elements are auto-created by id on first getElementById so the top-level
 * `const DOM = {...}` lookup table resolves. Values (.value/.checked/
 * .textContent/.innerHTML) persist per id, which is what the suite asserts on.
 *
 * Non-goals: layout, selectors over generated innerHTML (querySelectorAll on a
 * fake element returns []). UI-level rendering is covered separately by the
 * browser harness + screenshots; this double exists for logic-level assertions.
 */

export function createFakeDom() {
  const registry = new Map();
  const documentListeners = new Map(); // type -> [fn]

  function makeElement(id, tag = "div") {
    const classSet = new Set();
    const listeners = [];
    const el = {
      id,
      tagName: tag.toUpperCase(),
      value: "",
      checked: false,
      textContent: "",
      innerHTML: "",
      disabled: false,
      hidden: false,
      style: {},
      dataset: {},
      children: [],
      classList: {
        add: (...c) => c.forEach((x) => classSet.add(x)),
        remove: (...c) => c.forEach((x) => classSet.delete(x)),
        toggle: (c, force) => {
          const want = force === undefined ? !classSet.has(c) : force;
          if (want) classSet.add(c);
          else classSet.delete(c);
          return want;
        },
        contains: (c) => classSet.has(c),
      },
      _classes: classSet,
      _listeners: listeners,
      addEventListener: (type, fn) => listeners.push({ type, fn }),
      removeEventListener: () => {},
      dispatch: (type, event = {}) => {
        for (const l of listeners) {
          if (l.type === type) l.fn({ ...event, target: el, stopPropagation() {}, preventDefault() {} });
        }
      },
      appendChild: (child) => {
        el.children.push(child);
        return child;
      },
      removeChild: (child) => {
        const i = el.children.indexOf(child);
        if (i !== -1) el.children.splice(i, 1);
      },
      remove: () => {},
      querySelector: () => null,
      querySelectorAll: () => [],
      closest: () => null,
      focus: () => {},
      blur: () => {},
      click: () => {},
      select: () => {},
      setAttribute: () => {},
      getAttribute: () => null,
      scrollIntoView: () => {},
      get className() {
        return [...classSet].join(" ");
      },
      set className(v) {
        classSet.clear();
        String(v)
          .split(/\s+/)
          .filter(Boolean)
          .forEach((c) => classSet.add(c));
      },
    };
    return el;
  }

  const body = makeElement("__body__", "body");

  const document = {
    body,
    documentElement: makeElement("__html__", "html"),
    title: "QA harness",
    getElementById(id) {
      if (!registry.has(id)) registry.set(id, makeElement(id));
      return registry.get(id);
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: (tag) => makeElement(`__anon_${tag}_${registry.size}`, tag),
    createTextNode: (text) => ({ textContent: text }),
    addEventListener(type, fn) {
      if (!documentListeners.has(type)) documentListeners.set(type, []);
      documentListeners.get(type).push(fn);
    },
    removeEventListener() {},
  };

  const window = {
    close() {},
    open() {},
    addEventListener() {},
    location: { href: "chrome-extension://qa/popup.html" },
    getComputedStyle: () => ({}),
  };

  return {
    document,
    window,
    elements: registry,
    /** Fire a document-level event (e.g. DOMContentLoaded) and await async handlers. */
    async dispatchDocumentEvent(type) {
      const fns = documentListeners.get(type) || [];
      for (const fn of fns) {
        await fn({ type });
      }
    },
  };
}
