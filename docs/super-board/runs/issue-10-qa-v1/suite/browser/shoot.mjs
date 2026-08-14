/**
 * super-board QA — issue #10, screenshot capture.
 *
 * Drives real headless Chrome over the DevTools protocol (Node's built-in
 * WebSocket — no npm dependencies, per PROJECT.md) against the popup harness:
 * navigate → wait for the page's own demo driver to settle → capture PNG →
 * pull the assertion state back out of window.__qa.
 *
 * Requires the harness server to be running:
 *   node docs/super-board/runs/issue-10-qa-v1/suite/browser/server.mjs
 *   node docs/super-board/runs/issue-10-qa-v1/suite/browser/shoot.mjs
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, "../..");
const PORT = Number(process.env.PORT || 8210);
const CDP = 9333;
const W = 420;
const H = 760;

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

/** Every shot: file name, harness URL, and what it is evidence of. */
const SHOTS = [
  ["01-before-revisit.png", "?demo=before", "starting state — Notion holds a far-future review date"],
  ["02-revisit-intervals-1-3-7.png", "?demo=revisit&intervals=1,3,7", "AC1/AC2/AC4/AC5 — Review Today with the default intervals"],
  ["03-revisit-intervals-0-0-0.png", "?demo=revisit&intervals=0,0,0", "AC3 — same result with every interval disabled"],
  ["04-due-today-alarm.png", "?demo=due&intervals=1,3,7", "AC6 — the hourly alarm sees it as due the same day"],
  ["05-review-tomorrow.png", "?demo=tomorrow", "AC7 — Review Tomorrow still writes today+1"],
  ["06-revisit-failure-rollback.png", "?demo=revisit&fail=1", "AC5 — a failed write leaves date and Attempts alone and reports the error"],
];

const userDataDir = path.join(
  process.env.TEMP || process.env.TMPDIR || "/tmp",
  `leetion-qa-chrome-${process.pid}`,
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
  { stdio: "ignore" },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdpTarget(url) {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP}/json/new?${encodeURIComponent(url)}`, {
        method: "PUT",
      });
      if (r.ok) return await r.json();
    } catch {
      /* chrome not up yet */
    }
    await sleep(250);
  }
  throw new Error("Chrome DevTools endpoint never came up");
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
  });
  const ready = new Promise((r) => ws.addEventListener("open", r));
  return {
    ready,
    send: (method, params = {}) =>
      new Promise((resolve, reject) => {
        const n = ++id;
        pending.set(n, { resolve, reject });
        ws.send(JSON.stringify({ id: n, method, params }));
      }),
    close: () => ws.close(),
  };
}

const results = [];

try {
  const target = await cdpTarget("about:blank");
  const cdp = connect(target.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: W,
    height: H,
    deviceScaleFactor: 1,
    mobile: false,
  });

  for (const [file, query, why] of SHOTS) {
    const url = `http://localhost:${PORT}/${query}`;
    await cdp.send("Page.navigate", { url });
    // The page sets __qa.demoDone once its driver has settled.
    let done = false;
    for (let i = 0; i < 80 && !done; i++) {
      await sleep(100);
      const r = await cdp.send("Runtime.evaluate", {
        expression: "!!(window.__qa && window.__qa.demoDone)",
        returnByValue: true,
      });
      done = r.result?.value === true;
    }
    if (!done) throw new Error(`demo never settled for ${file}`);

    const state = await cdp.send("Runtime.evaluate", {
      expression: `JSON.stringify({
        localDay: window.__qa.localDay,
        utcDay: window.__qa.utcDay,
        reviewDate: window.__qa.reviewDate(),
        attempts: window.__qa.attempts(),
        input: document.getElementById("input-attempts")?.value,
        status: document.getElementById("save-status")?.textContent,
        statusClass: document.getElementById("save-status")?.className,
        revisitLabel: document.getElementById("btn-revisit")?.textContent.trim(),
        revisitTitle: document.getElementById("btn-revisit")?.title,
        tomorrowLabel: document.getElementById("btn-mark-review")?.textContent.trim(),
        sent: window.__qa.messages.map(m => ({ action: m.action, data: { ...m.data, apiKey: undefined } })),
        storageKeys: window.__qa.storageKeysSeen(),
        dueMessage: window.__qa.dueMessage || null
      })`,
      returnByValue: true,
    });

    const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(outDir, file), Buffer.from(shot.data, "base64"));
    const parsed = JSON.parse(state.result.value);
    results.push({ file, query, why, state: parsed });
    console.log(`\n${file}  (${why})`);
    console.log(`   url            ${url}`);
    console.log(`   local/UTC day  ${parsed.localDay} / ${parsed.utcDay}`);
    console.log(`   Notion page    Spaced Repetition=${parsed.reviewDate}  Attempts=${parsed.attempts}`);
    console.log(`   popup          input=${parsed.input}  toast="${parsed.status}"  button="${parsed.revisitLabel}"`);
    console.log(`   sent           ${JSON.stringify(parsed.sent)}`);
    console.log(`   storage keys   ${JSON.stringify(parsed.storageKeys)}`);
    if (parsed.dueMessage) console.log(`   alarm          ${parsed.dueMessage}`);
  }

  fs.writeFileSync(
    path.join(outDir, "browser-state.json"),
    JSON.stringify(results, null, 2),
  );
  cdp.close();
  console.log(`\nCaptured ${SHOTS.length} screenshots into ${outDir}`);
} finally {
  chrome.kill();
  await sleep(300);
  fs.rmSync(userDataDir, { recursive: true, force: true });
}
