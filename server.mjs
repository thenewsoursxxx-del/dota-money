// Local preview server — serves the static site in docs/ (identical to what GitHub Pages serves).
// The app is fully client-side; there is no API. This is only for local development.

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "docs");
const PORT = Number(process.env.PORT || 5173);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    let rel = decodeURIComponent(url.pathname);
    if (rel === "/" || rel === "") rel = "/index.html";
    const filePath = normalize(join(ROOT, rel));
    if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end("Forbidden"); return; }
    if (!existsSync(filePath)) { res.writeHead(404); res.end("Not found"); return; }
    const s = await stat(filePath);
    if (s.isDirectory()) { res.writeHead(404); res.end("Not found"); return; }
    const data = await readFile(filePath);
    res.writeHead(200, { "Content-Type": MIME[extname(filePath)] || "application/octet-stream" });
    res.end(data);
  } catch (err) {
    res.writeHead(500);
    res.end(String(err && err.message ? err.message : err));
  }
});

server.listen(PORT, () => {
  console.log(`DOTA MONEY (static preview) → http://localhost:${PORT}`);
});
