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
const CUSTOM_DOMAIN = "dedsec.whatiwatched.com";

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

// Compiled module tree. `web/main.js` imports `../src/...`, so both halves have
// to keep their relative positions.
await cp(join(ROOT, "dist", "src"), join(OUT, "src"), { recursive: true });
await cp(join(ROOT, "dist", "web"), join(OUT, "web"), { recursive: true });
await cp(join(ROOT, "web", "style.css"), join(OUT, "style.css"));
await cp(join(ROOT, "web", "street.css"), join(OUT, "street.css"));

// three is the only runtime dependency, and it ships as a single ES module. It
// gets copied rather than bundled, and the import map below is redirected to
// the copy — which is the entire reason this project still has no bundler.
await mkdir(join(OUT, "vendor"), { recursive: true });
await cp(
  join(ROOT, "node_modules", "three", "build", "three.module.js"),
  join(OUT, "vendor", "three.module.js"),
);

// The dev server maps "/" to web/index.html, so the source uses absolute paths.
// A static host serves this file *as* the root, so they become relative.
const rewrite = (html) =>
  html
    .replaceAll('href="/web/style.css"', 'href="./style.css"')
    .replaceAll('href="/web/street.css"', 'href="./street.css"')
    .replaceAll('"/node_modules/three/build/three.module.js"', '"./vendor/three.module.js"')
    .replaceAll('src="/dist/web/three/main.js"', 'src="./web/three/main.js"')
    .replaceAll('src="/dist/web/main.js"', 'src="./web/main.js"');

// Two clients, two pages, one simulation: the street is the front door and the
// field terminal sits behind it for anyone who wants every instrument at once.
for (const page of ["index.html", "terminal.html"]) {
  await writeFile(join(OUT, page), rewrite(await readFile(join(ROOT, "web", page), "utf8")));
}

if (CUSTOM_DOMAIN) await writeFile(join(OUT, "CNAME"), `${CUSTOM_DOMAIN}\n`);
// Without this, Pages runs Jekyll and drops anything beginning with an underscore.
await writeFile(join(OUT, ".nojekyll"), "");

console.log(`  site/ built${CUSTOM_DOMAIN ? ` for ${CUSTOM_DOMAIN}` : ""}`);
console.log(`  serve it with any static host, or: npx serve site\n`);
