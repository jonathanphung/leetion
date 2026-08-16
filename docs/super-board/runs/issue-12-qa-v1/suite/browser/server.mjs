/**
 * super-board QA — issue #12, popup-layer static server.
 *
 * Serves the REAL extension files from the worktree root. `/` is popup.html
 * with `qa/boot.js` injected before `popup.js`; `/qa/notion-mock.js` is the
 * Node suite's notion-mock.mjs down-levelled to a classic script so both
 * layers share one Notion double.
 *
 *   node docs/super-board/runs/issue-12-qa-v1/suite/browser/server.mjs
 *   → http://localhost:8212/                 problem not yet in Notion
 *   → http://localhost:8212/?seeded=1        problem already in Notion
 *   → http://localhost:8212/?demo=marked     click "Mark to-do" and settle
 *   → http://localhost:8212/?demo=marked&fail=1   forced Notion failure
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../../../../..");
const suite = path.resolve(here, "..");
const PORT = Number(process.env.PORT || 8212);

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
    const urlPath = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
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
        // One source of truth for the Notion double: strip the ESM exports and
        // hang the factory off window instead.
        const src = fs
          .readFileSync(path.join(suite, "notion-mock.mjs"), "utf8")
          .replace(/^export function/m, "function")
          .replace(/^export const/m, "const");
        res.writeHead(200, { "content-type": MIME[".js"] });
        res.end(
          src +
            "\nwindow.__qaCreateNotionMock = createNotionMock;\nwindow.__qaFullSchema = FULL_SCHEMA;\n",
        );
        return;
      }
      const file = path.normalize(path.join(root, urlPath));
      if (!file.startsWith(root)) throw new Error("traversal");
      const data = fs.readFileSync(file);
      res.writeHead(200, {
        "content-type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
      });
      res.end(data);
    } catch {
      if (!res.headersSent) res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found: " + urlPath);
    }
  })
  .listen(PORT, () => console.log(`QA popup harness on http://localhost:${PORT}`));
