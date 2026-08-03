/**
 * super-board QA harness static server — issue #1, popup layer.
 * Serves the REAL extension files from the worktree root, with /harness.html
 * being popup.html + the chrome-stub injected before popup.js.
 *
 * Run:  node docs/super-board/runs/issue-1-qa-v1/harness/popup-harness/server.mjs
 * Then: open http://localhost:8123/harness.html         (existing entry)
 *       open http://localhost:8123/harness.html?new=1   (first-save scenario)
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../../../../.."); // → worktree root
const PORT = 8123;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

http
  .createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    try {
      if (urlPath === "/" || urlPath === "/harness.html") {
        let html = fs.readFileSync(path.join(root, "popup.html"), "utf8");
        html = html.replace(
          '<script src="popup.js"></script>',
          '<script src="qa/chrome-stub.js"></script>\n    <script src="popup.js"></script>',
        );
        res.writeHead(200, { "content-type": MIME[".html"] });
        res.end(html);
        return;
      }
      if (urlPath === "/qa/chrome-stub.js") {
        res.writeHead(200, { "content-type": MIME[".js"] });
        res.end(fs.readFileSync(path.join(here, "chrome-stub.js")));
        return;
      }
      const file = path.normalize(path.join(root, urlPath));
      if (!file.startsWith(root)) throw new Error("traversal");
      const data = fs.readFileSync(file); // read BEFORE writeHead so a miss 404s cleanly
      res.writeHead(200, {
        "content-type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
      });
      res.end(data);
    } catch {
      if (!res.headersSent) res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found: " + urlPath);
    }
  })
  .listen(PORT, () => console.log(`QA harness serving ${root} on http://localhost:${PORT}`));
