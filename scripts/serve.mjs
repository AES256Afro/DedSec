/**
 * Zero-dependency static server for the web client.
 *
 * With no argument it serves the repo root, so `web/index.html` can load the
 * compiled modules out of `dist/web/`. Pass a directory to serve that instead —
 * `node scripts/serve.mjs site` serves the built bundle exactly as a host would,
 * which is what CI points the browser smoke test at.
 */

import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";

const ROOT = resolve(process.argv[2] ?? process.cwd());
const SERVING_SITE = process.argv[2] !== undefined;
const PORT = Number(process.env.PORT ?? (SERVING_SITE ? 5174 : 5173));

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    let path = decodeURIComponent(url.pathname);
    if (path === "/") path = SERVING_SITE ? "/index.html" : "/web/index.html";

    // Contain everything under the repo root — no traversal out of it.
    const filePath = join(ROOT, normalize(path));
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403).end("Forbidden");
      return;
    }

    const info = await stat(filePath).catch(() => null);
    if (!info || info.isDirectory()) {
      res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
      return;
    }

    res.writeHead(200, {
      "content-type": TYPES[extname(filePath)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    createReadStream(filePath).pipe(res);
  } catch (error) {
    res.writeHead(500, { "content-type": "text/plain" }).end(String(error));
  }
});

server.listen(PORT, () => {
  console.log(`\n  DedNec running at http://localhost:${PORT}/ (serving ${ROOT})`);
  console.log(`  Try a different city with http://localhost:${PORT}/?seed=marina\n`);
});
