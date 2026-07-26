/**
 * Browser smoke test — the street.
 *
 * A 3D client fails in ways a unit test cannot see: three fails to resolve
 * through the import map, the canvas gets no context, the crowd renders at the
 * origin, cards project behind the camera. So this drives the real page with a
 * real GPU-less Chromium and asserts on things that can only be true if the
 * whole chain worked — WebGL actually drew, people actually got profiled as the
 * player walked, and a card actually landed on screen over one of them.
 *
 *   npm run serve                   # in one shell
 *   node scripts/smoke-street.mjs   # in another (needs playwright available)
 */

import { existsSync } from "node:fs";

import { chromium } from "playwright";

const BASE = process.env.BASE_URL ?? "http://localhost:5173";

function launchOptions() {
  const configured = process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium";
  return {
    // Headless Chromium has no GPU; SwiftShader is what makes WebGL work at all
    // in CI, and without it this test would pass by never rendering anything.
    args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
    ...(existsSync(configured) ? { executablePath: configured } : {}),
  };
}

const browser = await chromium.launch(launchOptions());
const page = await browser.newPage({ viewport: { width: 1440, height: 860 } });

const problems = [];
page.on("console", (m) => {
  if (m.type() === "error") problems.push(m.text());
});
page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
page.on("response", (r) => {
  if (r.status() >= 400) problems.push(`${r.status()} ${r.url()}`);
});

const check = (label, condition, detail = "") => {
  console.log(`${condition ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!condition) problems.push(`assertion failed: ${label}`);
};

await page.goto(`${BASE}/?seed=demo`, { waitUntil: "networkidle" });
await page.waitForTimeout(1200);

/* --- 1. the scene exists ------------------------------------------------- */

const canvas = await page.evaluate(() => {
  const el = document.getElementById("scene");
  return { width: el.width, height: el.height, webgl: Boolean(el.getContext("webgl2") || el.getContext("webgl")) };
});
check("the canvas is sized and has a GL context", canvas.width > 100 && canvas.webgl, `${canvas.width}×${canvas.height}`);

const world = await page.evaluate(() => {
  const state = window.dednec.state();
  return {
    people: state.npcs.size,
    cases: state.cases.length,
    places: state.city.graph.places.size,
    outdoors: [...state.city.graph.places.values()].filter((p) => !p.indoor).length,
  };
});
check("the city booted with people and a caseload", world.people > 20 && world.cases > 0, `${world.people} people · ${world.cases} cases`);

/* --- 2. anything at all got drawn ---------------------------------------- */

// Sampling pixels does not work here: a WebGL canvas without
// `preserveDrawingBuffer` reads back blank once the frame is composited, so a
// perfectly good scene would fail. Ask the renderer what it drew instead.
const drawn = await page.evaluate(() => window.dednec.stats());
check(
  "the renderer drew the city",
  drawn.triangles > 1000 && drawn.calls > 4,
  `${drawn.triangles} triangles · ${drawn.calls} draw calls`,
);

/* --- 3. walking profiles the street -------------------------------------- */

await page.mouse.click(720, 430); // takes pointer lock and starts the walk
await page.waitForTimeout(150);

const scannedBefore = await page.evaluate(
  () => [...window.dednec.state().npcs.values()].filter((n) => n.revealedFields.has("identity")).length,
);

for (const key of ["KeyW", "KeyA", "KeyW", "KeyD"]) {
  await page.keyboard.down(key);
  await page.waitForTimeout(900);
  await page.keyboard.up(key);
}
await page.waitForTimeout(600);

const after = await page.evaluate(() => {
  const state = window.dednec.state();
  return {
    scanned: [...state.npcs.values()].filter((n) => n.revealedFields.has("identity")).length,
    placeId: state.player.placeId,
    flagged: state.cases.filter((c) => c.status !== "unseen").length,
    ledger: state.ledger.scanned,
  };
});
check("ctOS profiles people as you walk", after.scanned > scannedBefore, `${scannedBefore} → ${after.scanned}`);
check("the ledger counts what the walk turned up", after.ledger === after.scanned, `${after.ledger} profiled`);

/* --- 4. cards land on screen --------------------------------------------- */

// Where the free walk above ends up is not deterministic enough to assert on,
// so stand somewhere there provably *is* somebody and look straight at them.
const stood = await page.evaluate(() => {
  const state = window.dednec.state();
  const graph = state.city.graph;
  const counts = new Map();
  for (const person of state.npcs.values()) {
    const place = graph.places.get(person.placeId);
    if (!place || place.indoor) continue;
    counts.set(place.id, (counts.get(place.id) ?? 0) + 1);
  }
  const [busiest] = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (!busiest) return null;
  const place = graph.place(busiest[0]);
  window.dednec.goTo(place.x - 17, place.y, place.x, place.y);
  return { name: place.name, people: busiest[1] };
});
check("there is somewhere with people standing in it", stood !== null, stood ? `${stood.people} in ${stood.name}` : "nobody outdoors");
await page.waitForTimeout(900);

const overlay = await page.evaluate(() => window.dednec.stats());
check(
  "ctOS cards project over people",
  overlay.cards > 0,
  `${overlay.cards} card(s) up · ${overlay.profiled} in ctOS range, ${overlay.optical} of them in sight`,
);

const named = await page.evaluate(() => {
  const el = [...document.querySelectorAll(".ctos-card:not([hidden]) .ctos-name")].find(
    (n) => !n.classList.contains("is-unknown"),
  );
  return el ? el.textContent : null;
});
check("at least one card has resolved to a name", Boolean(named), named ?? "all still scanning");

/* --- 5. a case can be seen and closed ------------------------------------ */

const resolved = await page.evaluate(async () => {
  const state = window.dednec.state();
  // The compiled tree sits at a different depth in the repo and in the built
  // site, so resolve against the page's own entry module rather than guessing.
  const entry = document.querySelector('script[type="module"]').src;
  const from = (path) => import(new URL(`../../src/${path}`, entry).href);
  const { refreshCases, resolveCase } = await from("case/cases.js");
  const { breachNode } = await from("hack/breach.js");
  const { refreshProfiles } = await from("sim/actions.js");

  // Open a case the hard way — breach its evidence — then act on it. The
  // evidence is scattered across the city by design, so lift the radio range
  // rather than teleporting: everything else stays the real code path.
  state.player.hackRange = 100_000;
  const target = state.cases[0];
  for (const id of target.evidenceNodeIds) {
    for (let i = 0; i < 25 && !state.player.breachedNodeIds.has(id); i++) breachNode(state, id);
  }
  for (const person of state.npcs.values()) person.revealedFields.add("identity");
  refreshProfiles(state);
  refreshCases(state);

  const status = target.status;
  const outcome = resolveCase(state, target.id, target.resolutions[0].kind);
  return { status, outcome, ledger: { ...state.ledger } };
});
check("reading the evidence opens a case", resolved.status === "open", `status ${resolved.status}`);
check("acting on a case lands in the ledger", resolved.outcome.ok, resolved.outcome.message);

await page.screenshot({ path: "docs/screenshot.png" });
console.log("      screenshot -> docs/screenshot.png");

if (problems.length > 0) {
  console.log("\nproblems:\n  " + problems.join("\n  "));
  process.exitCode = 1;
} else {
  console.log("\nall checks passed, no console errors, no failed requests");
}

await browser.close();
