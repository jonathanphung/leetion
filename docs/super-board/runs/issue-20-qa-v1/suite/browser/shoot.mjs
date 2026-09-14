/**
 * super-board QA — issue #20, screenshot + assertion capture.
 *
 * Drives real headless Chrome over the DevTools protocol (Node's built-in
 * WebSocket — no npm dependencies, per PROJECT.md) against the popup harness:
 * navigate → wait for the page's own demo driver to settle → capture PNG →
 * pull the recorded assertions back out of window.__qa.checks.
 *
 * The viewport is 420×980, not the 1920/1024/375 desktop-tablet-mobile ladder
 * in the super-board Tester contract: this UI is a browser-action popup, which
 * Chrome renders at the width popup.html declares (~400px) and never at a
 * desktop or tablet width. Shooting it at 1920 would produce three copies of
 * the same 400px column on a field of empty page. The deviation is deliberate
 * and is called out in REPORT.md.
 *
 *   node docs/super-board/runs/issue-20-qa-v1/suite/browser/server.mjs &
 *   node docs/super-board/runs/issue-20-qa-v1/suite/browser/shoot.mjs
 *
 * OUT_DIR=<dir> writes elsewhere (the negative control uses this).
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = process.env.OUT_DIR
  ? path.resolve(process.env.OUT_DIR)
  : path.resolve(here, "../..");
const PORT = Number(process.env.PORT || 8221);
const CDP = Number(process.env.CDP || 9344);
const W = 420;
const H = 980;

const CHROME =
  process.env.CHROME ||
  [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "/usr/bin/google-chrome",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].find((p) => fs.existsSync(p));

if (!CHROME) {
  console.error("No Chrome binary found. Set CHROME=<path>.");
  process.exit(2);
}

/** Every shot: file name, harness query, and what it is evidence of. */
const SHOTS = [
  [
    "01-open-scheduled.png",
    "?demo=open&seed=dated",
    "AC8 — a scheduled problem opens with the switch ON and nothing staged",
  ],
  [
    "02-staged-off.png",
    "?demo=stage-off&seed=dated",
    "AC1/AC2 — flipping off writes nothing and shows as unsaved",
  ],
  [
    "03-staged-off-saved.png",
    "?demo=stage-off-save&seed=dated",
    'AC3/AC7 — "Update in Notion" empties the date and drops the staged flag',
  ],
  [
    "04-staged-on-medium.png",
    "?demo=stage-on-save&seed=empty",
    "AC4 — staged ON saves today + the Medium interval (3)",
  ],
  [
    "05-staged-on-expertise-changed.png",
    "?demo=stage-on-high-save&seed=empty",
    "AC4 — expertise switched to High AFTER staging: the save writes today + 7",
  ],
  [
    "06-interval-zero-falls-back-to-today.png",
    "?demo=stage-on-zero-save&seed=empty&intervals=0-0-0",
    "AC5 — reviews disabled for this level: an explicit ON lands TODAY",
  ],
  [
    "07-interval-zero-unstaged-untouched.png",
    "?demo=unstaged-zero-save&seed=dated&intervals=0-0-0",
    "AC5 — an ordinary save on the same level still leaves the date alone",
  ],
  [
    "08-off-on-unstages.png",
    "?demo=off-on-save&seed=dated",
    "AC6 — off → on → save: no no-op clear queued, still scheduled",
  ],
  [
    "09-failed-save-stays-staged.png",
    "?demo=fail-save-only&seed=dated",
    "AC7 — the save failed: the flip is still staged and the date is untouched",
  ],
  [
    "09b-failed-save-retry-lands.png",
    "?demo=fail-then-retry&seed=dated",
    "AC7 — the same flip retried after the failure clears the date and unstages",
  ],
  [
    "10-review-today-discards-stage.png",
    "?demo=review-today-discards-stage&seed=dated",
    "AC9 — Review Today writes now, discards the staged off, and survives the save",
  ],
  [
    "11-review-tomorrow-discards-stage.png",
    "?demo=review-tomorrow-discards-stage&seed=dated",
    "AC9 — same for Review Tomorrow (today + 1)",
  ],
  [
    "12-unstaged-off-stays-out.png",
    "?demo=unstaged-off-save&seed=empty",
    "AC10 — a cleared problem stays cleared through a plain save (issue #11)",
  ],
];

const userDataDir = path.join(
  process.env.TEMP || process.env.TMPDIR || "/tmp",
  `leetion-qa20-chrome-${process.pid}`,
);

const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    `--remote-debugging-port=${CDP}`,
    `--user-data-dir=${userDataDir}`,
    `--window-size=${W},${H}`,
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--force-device-scale-factor=1",
    "about:blank",
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
);
chrome.stderr.on("data", () => {});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function wsUrl() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP}/json/version`);
      const j = await r.json();
      if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error("Chrome DevTools endpoint never came up");
}

const ws = new WebSocket(await wsUrl());
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});

let msgId = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) reject(new Error(JSON.stringify(m.error)));
    else resolve(m.result);
  }
};
const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });

const { targetId } = await send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await send("Target.attachToTarget", {
  targetId,
  flatten: true,
});
await send("Page.enable", {}, sessionId);
await send("Runtime.enable", {}, sessionId);
await send(
  "Emulation.setDeviceMetricsOverride",
  { width: W, height: H, deviceScaleFactor: 1, mobile: false },
  sessionId,
);

const evaluate = async (expression) => {
  const r = await send(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true },
    sessionId,
  );
  if (r.exceptionDetails) {
    throw new Error(
      r.exceptionDetails.exception?.description ||
        JSON.stringify(r.exceptionDetails),
    );
  }
  return r.result.value;
};

fs.mkdirSync(outDir, { recursive: true });

const allChecks = [];
const consoleErrors = [];
const shotLog = [];

for (const [file, query, why] of SHOTS) {
  await send("Page.navigate", { url: `http://localhost:${PORT}/${query}` }, sessionId);
  await sleep(400);

  // The demo driver sets __qa.demoDone when its scenario has settled.
  let settled = false;
  for (let i = 0; i < 120; i += 1) {
    settled = await evaluate("!!(window.__qa && window.__qa.demoDone)");
    if (settled) break;
    await sleep(250);
  }

  const state = await evaluate(`JSON.stringify({
    settled: !!(window.__qa && window.__qa.demoDone),
    checks: (window.__qa && window.__qa.checks) || [],
    toggle: window.__qa ? window.__qa.toggle() : null,
    staged: window.__qa ? window.__qa.staged() : null,
    hint: window.__qa ? window.__qa.hint() : null,
    review: window.__qa ? window.__qa.reviewProp() : null,
    localDay: window.__qa ? window.__qa.localDay : null,
    utcDay: window.__qa ? window.__qa.utcDay : null,
    writes: window.__qa ? window.__qa.messages.filter(function(m){return m.action==='saveToNotion'||m.action==='updateSpacedRepetition';}).length : null
  })`);
  const parsed = JSON.parse(state);

  if (!settled) {
    consoleErrors.push(`${file}: demo driver never settled (timed out)`);
  }
  for (const c of parsed.checks) allChecks.push({ shot: file, why, ...c });

  // Clip to the popup's own column and to whatever it actually rendered, so
  // the evidence is the UI rather than the UI plus a field of empty page.
  const contentHeight = await evaluate(
    "Math.min(2000, Math.max(document.documentElement.scrollHeight, document.body.scrollHeight))",
  );
  const { data } = await send(
    "Page.captureScreenshot",
    {
      format: "png",
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: W, height: contentHeight, scale: 1 },
    },
    sessionId,
  );
  fs.writeFileSync(path.join(outDir, file), Buffer.from(data, "base64"));

  const red = parsed.checks.filter((c) => !c.ok).length;
  shotLog.push({ file, query, why, settled, checks: parsed.checks.length, red, state: parsed });
  console.log(
    `${red === 0 && settled ? "ok  " : "FAIL"}  ${file}  ${parsed.checks.length} checks` +
      `${red ? ` (${red} red)` : ""}${settled ? "" : " [NOT SETTLED]"}  — ${why}`,
  );
  for (const c of parsed.checks.filter((x) => !x.ok)) {
    console.log(`        ${c.ac}  ${c.label}`);
    console.log(`           expected  ${JSON.stringify(c.expected)}`);
    console.log(`           actual    ${JSON.stringify(c.actual)}`);
  }
}

// ── per-AC roll-up ─────────────────────────────────────────────────────────
const byAc = new Map();
for (const c of allChecks) {
  const e = byAc.get(c.ac) || { pass: 0, fail: 0 };
  e[c.ok ? "pass" : "fail"] += 1;
  byAc.set(c.ac, e);
}
console.log("\n" + "─".repeat(74));
for (const ac of [...byAc.keys()].sort()) {
  const e = byAc.get(ac);
  console.log(`  ${e.fail ? "FAIL" : "ok  "}  ${ac}  —  ${e.pass} pass, ${e.fail} fail`);
}
const failed = allChecks.filter((c) => !c.ok).length + consoleErrors.length;
console.log("─".repeat(74));
console.log(
  failed === 0
    ? `PASS — ${allChecks.length}/${allChecks.length} browser assertions green across ${SHOTS.length} scenarios`
    : `FAIL — ${failed} red (${allChecks.length} assertions, ${SHOTS.length} scenarios)`,
);
for (const e of consoleErrors) console.log(`  !! ${e}`);

fs.writeFileSync(
  path.join(outDir, process.env.ASSERTIONS || "assertions.json"),
  JSON.stringify(
    {
      viewport: `${W}x${H}`,
      port: PORT,
      total: allChecks.length,
      failed,
      byAc: Object.fromEntries(byAc),
      scenarios: shotLog,
      checks: allChecks,
    },
    null,
    2,
  ),
);

await send("Browser.close").catch(() => {});
ws.close();
chrome.kill();
await sleep(300);
try {
  fs.rmSync(userDataDir, { recursive: true, force: true });
} catch {
  /* Windows sometimes holds the profile dir briefly; harmless. */
}
process.exit(failed === 0 ? 0 : 1);
