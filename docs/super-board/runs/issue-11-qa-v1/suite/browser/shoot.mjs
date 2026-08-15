/**
 * super-board QA — issue #11, screenshot capture.
 *
 * Drives real headless Chrome over the DevTools protocol (Node's built-in
 * WebSocket — no npm dependencies, per PROJECT.md) against the popup harness:
 * navigate → wait for the page's own demo driver to settle → capture PNG →
 * pull the assertion state back out of window.__qa.
 *
 * Requires the harness server to be running:
 *   node docs/super-board/runs/issue-11-qa-v1/suite/browser/server.mjs
 *   node docs/super-board/runs/issue-11-qa-v1/suite/browser/shoot.mjs
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, "../..");
const PORT = Number(process.env.PORT || 8211);
const CDP = 9334;
const W = 420;
const H = 900;

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
  ["01-toggle-on-hydrated.png", "?demo=open&seed=dated", "AC2 — entry with a review date opens with the switch ON"],
  ["02-cleared.png", "?demo=clear&seed=dated", "AC1/AC8 — switching off empties the Notion date and toasts"],
  ["03-reopened-still-off.png", "?demo=open&seed=empty", "AC2 — reopening on a cleared entry reads OFF"],
  ["04-re-enabled-today.png", "?demo=enable&seed=empty", "AC3 — switching back on re-queues it for TODAY"],
  ["05-failure-rollback.png", "?demo=clear&seed=dated&fail=1", "AC7 — a Notion error reverts the switch and reports"],
  ["06-gated-not-in-notion.png", "?demo=open&seed=none", "AC4 — the control is unreachable before the page exists"],
  ["07-save-keeps-it-cleared.png", "?demo=save&seed=empty", "AC6 — a later plain save does not re-add a date"],
  ["08-revisit-flips-switch-on.png", "?demo=revisit&seed=empty", "Notes/#10 — Review Today on a cleared problem flips the switch ON"],
  ["09-clear-drops-highlight.png", "?demo=revisit-then-clear&seed=empty", "Notes/#10 — clearing drops the stale Review-Today highlight"],
];

const userDataDir = path.join(
  process.env.TEMP || process.env.TMPDIR || "/tmp",
  `leetion-qa11-chrome-${process.pid}`,
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
    let done = false;
    for (let i = 0; i < 120 && !done; i++) {
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
        seed: window.__qa.seed,
        localDay: window.__qa.localDay,
        utcDay: window.__qa.utcDay,
        reviewDate: window.__qa.reviewDate(),
        reviewProp: window.__qa.reviewProp(),
        toggle: window.__qa.toggle(),
        hint: window.__qa.hint(),
        quickActionsHidden: window.__qa.quickActionsHidden(),
        successClasses: window.__qa.successClasses(),
        status: document.getElementById("save-status")?.textContent,
        statusClass: document.getElementById("save-status")?.className,
        sent: window.__qa.messages.map(m => ({ action: m.action, data: { ...m.data, apiKey: undefined, problem: undefined } })),
        dueMessage: window.__qa.dueMessage || null,
        successBeforeClear: window.__qa.successBeforeClear || null
      })`,
      returnByValue: true,
    });

    const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(outDir, file), Buffer.from(shot.data, "base64"));
    const p = JSON.parse(state.result.value);
    results.push({ file, query, why, state: p });
    console.log(`\n${file}  (${why})`);
    console.log(`   url            ${url}`);
    console.log(`   local/UTC day  ${p.localDay} / ${p.utcDay}`);
    console.log(`   Notion page    "Spaced Repetition" = ${p.reviewProp}`);
    console.log(`   switch         ${JSON.stringify(p.toggle)}  hint="${p.hint}"  quickActionsHidden=${p.quickActionsHidden}`);
    console.log(`   toast          "${p.status}"  (${p.statusClass})`);
    console.log(`   success class  ${JSON.stringify(p.successClasses)}`);
    console.log(`   sent           ${JSON.stringify(p.sent)}`);
    if (p.successBeforeClear)
      console.log(`   before clear   ${JSON.stringify(p.successBeforeClear)}`);
    if (p.dueMessage) console.log(`   hourly alarm   ${p.dueMessage}`);
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
