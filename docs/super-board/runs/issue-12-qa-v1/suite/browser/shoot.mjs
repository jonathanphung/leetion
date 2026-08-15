/**
 * super-board QA — issue #12, screenshot capture + browser-layer assertions.
 *
 * Drives real headless Chrome over the DevTools protocol (Node's built-in
 * WebSocket — no npm dependencies, per PROJECT.md) against the popup harness:
 * navigate → wait for the page's own demo driver to settle → capture PNG →
 * pull the assertion state back out of window.__qa → assert on it.
 *
 * Requires the harness server to be running:
 *   node docs/super-board/runs/issue-12-qa-v1/suite/browser/server.mjs
 *   node docs/super-board/runs/issue-12-qa-v1/suite/browser/shoot.mjs
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, "../..");
const PORT = Number(process.env.PORT || 8212);
const CDP = Number(process.env.CDP || 9335);
// The popup is a fixed 400px panel (see popup.html / styles.css), not a
// responsive page, so the standard 3-viewport matrix does not apply. 420x780
// is the popup at its real width with the chrome the browser gives it.
const W = 420;
const H = 780;

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
  [
    "01-button-visible-new-problem.png",
    "?demo=none",
    "AC1/AC2 — unsaved problem: the button sits right-aligned on the header row",
  ],
  [
    "02-button-hidden-existing-entry.png",
    "?seeded=1&demo=none",
    "AC2 — the same problem already in Notion: no button",
  ],
  [
    "03-marked-todo.png",
    "?demo=marked",
    "AC3/AC5 — after the click: row queued, button gone, save reads Update in Notion",
  ],
  [
    "04-update-after-attempt.png",
    "?demo=update",
    "AC6 — the first real Update in Notion backfills the date and moves Attempts 0 → 1",
  ],
  [
    "05-due-today-alarm.png",
    "?demo=due",
    "AC7 — the hourly review check sees the queued row as due the same day",
  ],
  [
    "06-failure-retry.png",
    "?demo=marked&fail=1",
    "AC8 — a failed create surfaces the error and leaves the button clickable",
  ],
  [
    "07-duplicate-guard.png",
    "?demo=marked&race=1",
    "AC9 — a row that appeared after the lookup is adopted, not duplicated",
  ],
  [
    "08-layout-short-number.png",
    "?number=1&difficulty=Easy&title=Two Sum&demo=none",
    "AC1 — the other end of the layout range: shortest number, shortest badge",
  ],
  [
    "09-notion-not-configured.png",
    "?nokey=1&demo=marked",
    "AC8 — Notion not configured: the button is never offered, so there is nothing to half-create",
  ],
];

const userDataDir = path.join(
  process.env.TEMP || process.env.TMPDIR || "/tmp",
  `leetion-qa12-chrome-${process.pid}`,
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

// ------------------------------------------------------------------ asserts

const checks = [];
const check = (ac, label, pass, detail = "") =>
  checks.push({ ac, label, pass: !!pass, detail: String(detail) });
const eq = (ac, label, actual, expected) =>
  check(
    ac,
    label,
    JSON.stringify(actual) === JSON.stringify(expected),
    `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`,
  );

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
    for (let i = 0; i < 200 && !done; i++) {
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
        layout: window.__qa.layout(),
        ui: window.__qa.ui(),
        row: window.__qa.row(),
        createCount: window.__qa.createCount(),
        createRequests: window.__qa.createRequests(),
        sent: window.__qa.sent(),
        dueMessage: window.__qa.dueMessage || null
      })`,
      returnByValue: true,
    });

    const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(outDir, file), Buffer.from(shot.data, "base64"));
    const s = JSON.parse(state.result.value);
    results.push({ file, query, why, state: s });

    console.log(`\n${file}  (${why})`);
    console.log(`   url          ${url}`);
    console.log(`   button       hidden=${s.layout.buttonHidden} label="${s.layout.buttonLabel ?? ""}" disabled=${s.layout.buttonDisabled}`);
    console.log(`   header rects number=${JSON.stringify(s.layout.number)}\n                badge =${JSON.stringify(s.layout.badge)}\n                button=${JSON.stringify(s.layout.button)}\n                header=${JSON.stringify(s.layout.header)}`);
    console.log(`   ui           save="${s.ui.saveLabel}" quickHidden=${s.ui.quickActionsHidden} attempts=${s.ui.attempts} done=${s.ui.doneChecked}`);
    console.log(`   toast        "${s.ui.status}" (${s.ui.statusClass})`);
    console.log(`   creates      ${s.createCount}`);
    if (s.row) {
      const p = s.row.properties;
      console.log(
        `   Notion row   SR=${p["Spaced Repetition"]?.date?.start} Attempts=${p["Attempts"]?.number} ` +
          `Done=${p["Done"]?.checkbox} First=${p["Date (of first attempt)"]?.date?.start ?? "(empty)"} ` +
          `Expertise=${p["My Expertise"]?.select?.name ?? "(empty)"} body=${s.row.children?.length}`,
      );
    }
    if (s.dueMessage) console.log(`   alarm        ${s.dueMessage}`);

    // ---------------------------------------------------------- assertions
    const L = s.layout;
    if (file.startsWith("01") || file.startsWith("08")) {
      const tag = file.startsWith("01") ? "long #/Hard" : "short #/Easy";
      eq("AC2", `[${tag}] button visible for an unsaved problem`, L.buttonHidden, false);
      eq("AC1", `[${tag}] label reads "Mark to-do"`, L.buttonLabel, "Mark to-do");
      check(
        "AC1",
        `[${tag}] button is on the header row (vertically centred with the badge)`,
        Math.abs(L.button.cy - L.badge.cy) <= 2,
        `button.cy=${L.button.cy} badge.cy=${L.badge.cy}`,
      );
      check(
        "AC1",
        `[${tag}] number and badge keep the left group, button is to their right`,
        L.number.x < L.badge.x && L.badge.right < L.button.x,
        `number.x=${L.number.x} badge=[${L.badge.x},${L.badge.right}] button.x=${L.button.x}`,
      );
      check(
        "AC1",
        `[${tag}] right-aligned to the header's content edge`,
        Math.abs(L.header.right - L.button.right) <= 1,
        `header.right=${L.header.right} button.right=${L.button.right}`,
      );
      check(
        "AC1",
        `[${tag}] header is one line — no taller than its tallest child`,
        L.header.h <= Math.max(L.number.h, L.badge.h, L.button.h) + 1,
        `header.h=${L.header.h} number.h=${L.number.h} badge.h=${L.badge.h} button.h=${L.button.h}`,
      );
      check(
        "AC1",
        `[${tag}] button does not wrap (white-space: nowrap, one line high)`,
        L.buttonWhiteSpace === "nowrap" && L.button.h <= 26,
        `whiteSpace=${L.buttonWhiteSpace} h=${L.button.h}`,
      );
      check(
        "AC1",
        `[${tag}] popup body is still the fixed 400px panel`,
        L.bodyW === 400,
        `body width=${L.bodyW}`,
      );
      check(
        "AC1",
        `[${tag}] nothing overflows the popup horizontally`,
        L.appScrollW <= L.appClientW && L.cardScrollW <= L.cardClientW,
        `app ${L.appScrollW}/${L.appClientW} card ${L.cardScrollW}/${L.cardClientW}`,
      );
      check(
        "AC1",
        `[${tag}] badge is not squeezed (keeps its natural width)`,
        L.badge.w >= 44,
        `badge.w=${L.badge.w}`,
      );
      eq("AC2", `[${tag}] no row was created just by showing the button`, s.createCount, 0);
    }

    if (file.startsWith("02")) {
      eq("AC2", "button hidden when the problem already has a Notion row", L.buttonHidden, true);
      eq("AC2", "save button reads Update in Notion", s.ui.saveLabel, "Update in Notion");
      eq("AC2", "no row created", s.createCount, 0);
    }

    if (file.startsWith("03")) {
      const p = s.row?.properties || {};
      eq("AC3", "exactly one row created", s.createCount, 1);
      eq("AC3a", "Spaced Repetition = local today", p["Spaced Repetition"]?.date?.start, s.localDay);
      check(
        "AC3a",
        "…and not the UTC day",
        p["Spaced Repetition"]?.date?.start !== s.utcDay,
        `utcDay=${s.utcDay}`,
      );
      eq("AC3b", "Attempts = 0", p["Attempts"]?.number, 0);
      eq("AC3c", "Date (of first attempt) empty", p["Date (of first attempt)"], undefined);
      eq("AC3d", "Done unchecked", p["Done"]?.checkbox, false);
      eq("AC3e", "My Expertise empty", p["My Expertise"], undefined);
      eq("AC4", "no page content", s.row?.children?.length, 0);
      eq("AC5", "button hidden after the create", L.buttonHidden, true);
      eq("AC5", "save button now reads Update in Notion", s.ui.saveLabel, "Update in Notion");
      eq("AC5", "Quick Actions card is visible", s.ui.quickActionsHidden, false);
      eq("AC5", "attempts display shows 0", s.ui.attempts, "0");
      eq("AC5", "Done toggle reset to match the row", s.ui.doneChecked, false);
      check("AC5", "success toast shown", /Marked to-do/.test(s.ui.status || ""), s.ui.status);
      check(
        "AC5",
        "toast styled as success",
        /status-success/.test(s.ui.statusClass || ""),
        s.ui.statusClass,
      );
    }

    if (file.startsWith("04")) {
      const p = s.row?.properties || {};
      eq("AC6", "still exactly one row", s.createCount, 1);
      eq("AC6", "Attempts 0 → 1 on the first real update", p["Attempts"]?.number, 1);
      eq(
        "AC6",
        "Date (of first attempt) backfilled to local today",
        p["Date (of first attempt)"]?.date?.start,
        s.localDay,
      );
      check("AC6", "expertise now written", !!p["My Expertise"]?.select?.name, JSON.stringify(p["My Expertise"]));
      check(
        "AC6",
        "notes written into the (previously empty) page body",
        (s.row?.children?.length || 0) > 0,
        `children=${s.row?.children?.length}`,
      );
      const save = s.sent.find((m) => m.action === "saveToNotion");
      eq("AC6", "popup asked for the backfill", save?.data?.backfillFirstAttemptDate, true);
      eq("AC6", "popup asked for the increment", save?.data?.incrementAttempts, true);
      eq("AC6", "attempts field shows 1", s.ui.attempts, "1");
    }

    if (file.startsWith("05")) {
      eq(
        "AC7",
        "the hourly review check fires for the queued problem",
        s.dueMessage,
        "You have 1 problem due for review today.",
      );
    }

    if (file.startsWith("06")) {
      eq("AC8", "no row exists after a failed create", s.createCount, 0);
      eq("AC8", "no row in the database at all", s.row, null);
      eq("AC8", "button still visible", L.buttonHidden, false);
      eq("AC8", "button re-enabled for a retry", L.buttonDisabled, false);
      eq("AC8", "label restored", L.buttonLabel, "Mark to-do");
      check("AC8", "error surfaced in the status bar", !!s.ui.status, s.ui.status);
      check(
        "AC8",
        "toast styled as error",
        /status-error/.test(s.ui.statusClass || ""),
        s.ui.statusClass,
      );
      eq("AC8", "save button still reads Save to Notion (no half-created state)", s.ui.saveLabel, "Save to Notion");
      eq("AC8", "Quick Actions stay hidden", s.ui.quickActionsHidden, true);
    }

    if (file.startsWith("09")) {
      eq("AC8", "unconfigured: no row created", s.createCount, 0);
      eq("AC8", "unconfigured: no row in the database", s.row, null);
      eq(
        "AC8",
        "unconfigured: the button is never offered (the lookup never resolves)",
        L.buttonHidden,
        true,
      );
      eq("AC8", "unconfigured: no markTodo request reached Notion", s.createRequests, 0);
      check(
        "AC8",
        "unconfigured: forcing the handler surfaces the settings prompt",
        /Configure Notion settings first/.test(s.ui.status || ""),
        s.ui.status,
      );
      check(
        "AC8",
        "unconfigured: toast styled as error",
        /status-error/.test(s.ui.statusClass || ""),
        s.ui.statusClass,
      );
    }

    if (file.startsWith("07")) {
      eq("AC9", "no second row created", s.createCount, 0);
      eq("AC9", "button hidden — the popup adopted the existing row", L.buttonHidden, true);
      eq("AC9", "existing row's Attempts untouched", s.row?.properties?.["Attempts"]?.number, 2);
      eq(
        "AC9",
        "existing row's review date untouched",
        s.row?.properties?.["Spaced Repetition"]?.date?.start,
        "2026-09-30",
      );
    }
  }

  // Cross-shot: shots 01 and 02 are the SAME problem at the same difficulty,
  // with and without the button. If the button squeezed anything, the badge
  // and the number would measure differently between them.
  const withBtn = results.find((r) => r.file.startsWith("01"))?.state.layout;
  const withoutBtn = results.find((r) => r.file.startsWith("02"))?.state.layout;
  if (withBtn && withoutBtn) {
    eq("AC1", "badge width identical with and without the button", withBtn.badge.w, withoutBtn.badge.w);
    eq("AC1", "number width identical with and without the button", withBtn.number.w, withoutBtn.number.w);
    eq("AC1", "badge x position unchanged by the button", withBtn.badge.x, withoutBtn.badge.x);
    eq("AC1", "header height unchanged by the button", withBtn.header.h, withoutBtn.header.h);
  }

  fs.writeFileSync(
    path.join(outDir, "browser-state.json"),
    JSON.stringify({ checks, results }, null, 2),
  );
  cdp.close();

  const failed = checks.filter((c) => !c.pass);
  console.log("\nbrowser-layer assertions");
  for (const c of checks) {
    console.log(`  ${c.pass ? "PASS" : "FAIL"} [${c.ac}] ${c.label}${c.pass ? "" : `\n        ${c.detail}`}`);
  }
  console.log(
    `\n${failed.length === 0 ? "ALL GREEN" : "FAILURES"}: ${checks.length - failed.length}/${checks.length} browser assertions passed`,
  );
  console.log(`Captured ${SHOTS.length} screenshots into ${outDir}`);
  process.exitCode = failed.length === 0 ? 0 : 1;
} finally {
  chrome.kill();
  await sleep(300);
  fs.rmSync(userDataDir, { recursive: true, force: true });
}
