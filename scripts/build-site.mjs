/**
 * Build a self-contained static site into `site/`.
 *
 * The client is already plain ES modules with relative imports, so "bundling"
 * is really just laying the compiled tree out next to an index.html whose paths
 * are relative rather than absolute. No bundler, no framework, no build server —
 * the output is a directory any static host can serve as-is.
 *
 *   npm run build:site      # -> site/
 *   npx serve site          # or any static server
 */

import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const ROOT = resolve(process.cwd());
const OUT = join(ROOT, "site");

/** Custom domain for GitHub Pages. Delete this file to serve from *.github.io. */
const CUSTOM_DOMAIN = "dedsek.whatiwatched.com";

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

// Compiled module tree. `web/main.js` imports `../src/...`, so both halves have
// to keep their relative positions.
await cp(join(ROOT, "dist", "src"), join(OUT, "src"), { recursive: true });
await cp(join(ROOT, "dist", "web"), join(OUT, "web"), { recursive: true });
await cp(join(ROOT, "web", "style.css"), join(OUT, "style.css"));

// The dev server maps "/" to web/index.html, so the source uses absolute paths.
// A static host serves this file *as* the root, so they become relative.
const html = (await readFile(join(ROOT, "web", "index.html"), "utf8"))
  .replace('href="/web/style.css"', 'href="./style.css"')
  .replace('src="/dist/web/main.js"', 'src="./web/main.js"');
await writeFile(join(OUT, "index.html"), html);

if (CUSTOM_DOMAIN) await writeFile(join(OUT, "CNAME"), `${CUSTOM_DOMAIN}\n`);
// Without this, Pages runs Jekyll and drops anything beginning with an underscore.
await writeFile(join(OUT, ".nojekyll"), "");

console.log(`  site/ built${CUSTOM_DOMAIN ? ` for ${CUSTOM_DOMAIN}` : ""}`);
console.log(`  serve it with any static host, or: npx serve site\n`);
