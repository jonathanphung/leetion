/**
 * Static server for the issue #2 visual QA harness.
 *
 *   node docs/super-board/runs/issue-2-qa-v1/suite/serve.mjs [port]
 *
 * Serves the repo root as-is, plus /qa-harness.html: popup.html with the QA
 * boot module + the real background.js injected ahead of the real popup.js
 * (all deferred, so they execute in that order before DOMContentLoaded).
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SUITE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SUITE_DIR, "../../../../..");
const PORT = parseInt(process.argv[2] || "8123", 10);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function harnessHtml() {
  const popupHtml = fs.readFileSync(path.join(REPO_ROOT, "popup.html"), "utf8");
  const injected = [
    '<script type="module" src="/docs/super-board/runs/issue-2-qa-v1/suite/harness-boot.mjs"></script>',
    '<script type="module" src="/background.js"></script>',
    '<script src="/popup.js" defer></script>',
  ].join("\n    ");
  if (!popupHtml.includes('<script src="popup.js"></script>')) {
    throw new Error("popup.html no longer contains the popup.js script tag");
  }
  return popupHtml.replace('<script src="popup.js"></script>', injected);
}

const server = http.createServer((req, res) => {
  try {
    const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (urlPath === "/qa-harness.html" || urlPath === "/") {
      const body = harnessHtml();
      res.writeHead(200, { "Content-Type": MIME[".html"], "Cache-Control": "no-store" });
      res.end(body);
      return;
    }
    const safe = path
      .normalize(urlPath)
      .replace(/^([/\\])+/, "")
      .replace(/\.\./g, "");
    const file = path.join(REPO_ROOT, safe);
    if (!file.startsWith(REPO_ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(fs.readFileSync(file));
  } catch (e) {
    res.writeHead(500);
    res.end(String(e));
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`qa-harness serving ${REPO_ROOT} on http://127.0.0.1:${PORT}/qa-harness.html`);
});
