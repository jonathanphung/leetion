/**
 * super-board QA — issue #20, popup-layer static server.
 *
 * Serves the REAL extension files. `/` is popup.html with `qa/boot.js`
 * injected immediately before `popup.js`, so the popup boots against the
 * harness's `chrome` object; `/qa/notion-mock.js` is the Node suite's
 * notion-mock.mjs down-levelled to a classic script, so both layers of this
 * QA run share one Notion double.
 *
 *   node docs/super-board/runs/issue-20-qa-v1/suite/browser/server.mjs
 *   → http://localhost:8221/?seed=dated    entry with a review date
 *   → http://localhost:8221/?seed=empty    entry whose review date is empty
 *   → http://localhost:8221/?seed=none     problem not in Notion yet
 *
 * PRODUCT_ROOT=<dir> serves popup.html / popup.js / styles.css / background.js
 * from somewhere other than the worktree root. The negative control points it
 * at a checkout of `main`, which is what proves these assertions are actually
 * load-bearing rather than vacuously true.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const suite = path.resolve(here, "..");
const root = process.env.PRODUCT_ROOT
  ? path.resolve(process.env.PRODUCT_ROOT)
  : path.resolve(here, "../../../../../..");
const PORT = Number(process.env.PORT || 8221);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

http
  .createServer((req, res) => {
    const urlPath = decodeURIComponent(
      new URL(req.url, "http://localhost").pathname,
    );
    try {
      if (urlPath === "/" || urlPath === "/harness.html") {
        let html = fs.readFileSync(path.join(root, "popup.html"), "utf8");
        if (!html.includes('<script src="popup.js"></script>')) {
          throw new Error("popup.html no longer loads popup.js the expected way");
        }
        html = html.replace(
          '<script src="popup.js"></script>',
          '<script src="qa/boot.js"></script>\n    <script src="popup.js"></script>',
        );
        res.writeHead(200, { "content-type": MIME[".html"] });
        res.end(html);
        return;
      }
      if (urlPath === "/qa/boot.js") {
        res.writeHead(200, { "content-type": MIME[".js"] });
        res.end(fs.readFileSync(path.join(here, "boot.js")));
        return;
      }
      if (urlPath === "/qa/notion-mock.js") {
        // One source of truth for the Notion double: strip the ESM export and
        // hang the factory off window instead.
        const src = fs
          .readFileSync(path.join(suite, "notion-mock.mjs"), "utf8")
          .replace(
            "export function createNotionMock",
            "window.__qaCreateNotionMock = function createNotionMock",
          );
        res.writeHead(200, { "content-type": MIME[".js"] });
        res.end(src);
        return;
      }

      const file = path.join(root, urlPath.replace(/^\/+/, ""));
      if (!file.startsWith(root) || !fs.existsSync(file)) {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      res.writeHead(200, {
        "content-type": MIME[path.extname(file)] || "application/octet-stream",
      });
      res.end(fs.readFileSync(file));
    } catch (err) {
      res.writeHead(500);
      res.end(String(err && err.stack ? err.stack : err));
    }
  })
  .listen(PORT, () => {
    console.log(`qa harness (issue #20) on http://localhost:${PORT}/`);
    console.log(`serving product files from ${root}`);
  });
