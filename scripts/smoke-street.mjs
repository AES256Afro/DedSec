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

/**
 * Wait for the page to agree, rather than for the clock.
 *
 * Everything here is driven per animation frame, and software WebGL renders
 * this scene at a few frames a second. A fixed wait that is generous on a GPU
 * is one or two frames in CI, which is how the first versions of half these
 * assertions failed against a client that was working perfectly.
 */
async function until(fn, ms = 6000) {
  const deadline = Date.now() + ms;
  let last;
  while (Date.now() < deadline) {
    last = await page.evaluate(fn);
    if (last) return last;
    await page.waitForTimeout(200);
  }
  return last;
}

await page.goto(`${BASE}/?seed=demo`, { waitUntil: "networkidle" });
await page.waitForTimeout(1200);

/* --- 1. the scene exists ------------------------------------------------- */

const canvas = await page.evaluate(() => {
  const el = document.getElementById("scene");
  return { width: el.width, height: el.height, webgl: Boolean(el.getContext("webgl2") || el.getContext("webgl")) };
});
check("the canvas is sized and has a GL context", canvas.width > 100 && canvas.webgl, `${canvas.width}×${canvas.height}`);

const world = await page.evaluate(() => {
  const state = window.dedsec.state();
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
const drawn = await page.evaluate(() => window.dedsec.stats());
check(
  "the renderer drew the city",
  drawn.triangles > 1000 && drawn.calls > 4,
  `${drawn.triangles} triangles · ${drawn.calls} draw calls`,
);

/* --- 3. walking profiles the street -------------------------------------- */

await page.mouse.click(720, 430); // takes pointer lock and starts the walk
await page.waitForTimeout(150);

const scannedBefore = await page.evaluate(
  () => [...window.dedsec.state().npcs.values()].filter((n) => n.revealedFields.has("identity")).length,
);

for (const key of ["KeyW", "KeyA", "KeyW", "KeyD"]) {
  await page.keyboard.down(key);
  await page.waitForTimeout(900);
  await page.keyboard.up(key);
}
await page.waitForTimeout(600);

const after = await page.evaluate(() => {
  const state = window.dedsec.state();
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

// The card only exists for whoever is under the crosshair, so the test has to
// actually aim: stand a few metres from somebody outdoors and look at them.
const aimed = await page.evaluate(() => window.dedsec.aimAtSomebody());
check("there is somebody outdoors to aim at", aimed !== null, aimed ?? "nobody outdoors");

const opened = await until(() => (window.dedsec.stats().cards === 1 ? window.dedsec.stats() : null));
check(
  "aiming at somebody opens their card",
  Boolean(opened),
  opened
    ? `${opened.cards} card up · ${opened.profiled} in ctOS range, ${opened.optical} of them in sight`
    : "no card appeared",
);

const named = await page.evaluate(() => {
  const el = document.querySelector(".ctos-card:not([hidden]) .ctos-name");
  return el && !el.classList.contains("is-unknown") ? el.textContent : null;
});
check("the card resolves to a name", Boolean(named), named ?? "still reading");

// And nothing at all when you look away — the whole point of the change.
await page.evaluate(() => window.dedsec.goTo(60, 60, 1600, 1200));
const closed = await until(() => window.dedsec.stats().cards === 0);
check("looking away closes it", closed === true, closed ? "" : "a card stayed up");

/* --- 5. you can walk indoors --------------------------------------------- */

// The one question that matters about a doorway: can you get through it. The
// walls are built out of the same collider list as everything else, so a
// mis-sized gap seals the room without anything looking wrong from outside.
const rooms = await page.evaluate(() => window.dedsec.rooms());
const open = rooms.filter((r) => !r.locked);
check("public rooms are open to the street", open.length >= 3, open.map((r) => r.name).join(", "));
check(
  "and the locked ones are shut",
  rooms.length > open.length,
  rooms.filter((r) => r.locked).map((r) => r.name).join(", ") || "nothing locked",
);

let entered = null;
let walked = 0;
for (const room of open) {
  await page.evaluate(
    (r) => window.dedsec.goTo(r.approach[0], r.approach[1], r.inside[0], r.inside[1]),
    room,
  );
  await page.waitForTimeout(150);
  await page.keyboard.down("KeyW");
  // Poll rather than guess at a duration. Software WebGL renders this scene at
  // a few frames a second, and the controller advances per frame, so a fixed
  // wait that is generous on a GPU covers about two metres here.
  for (let tick = 0; tick < 20 && entered === null; tick++) {
    await page.waitForTimeout(400);
    const at = await page.evaluate(() => ({
      place: window.dedsec.state().player.placeId,
      z: window.dedsec.stats().at,
    }));
    walked = Math.hypot(at.z[0] - room.approach[0], at.z[1] - room.approach[1]);
    if (room.placeIds.includes(at.place)) entered = room.name;
  }
  await page.keyboard.up("KeyW");
  if (entered) break;
}
check(
  "walking at a door puts you inside the room",
  entered !== null,
  entered ?? `blocked after ${walked.toFixed(1)}m`,
);

/* --- 6. the building goes up --------------------------------------------- */

// Every floor of every building is now built, not just the ground one. The
// question that proves it is whether the stairs actually arrive somewhere: a
// stairwell that lands you inside a wall, or on a storey that was never built,
// leaves the player in a solid block with no way back.
const climbed = await page.evaluate(() => {
  const state = window.dedsec.state();
  const places = [...state.city.graph.places.values()];
  const ground = places.find((p) => p.kind === "stairwell" && p.floor === 0);
  if (!ground) return null;
  window.dedsec.goTo(ground.x, ground.y);
  return { want: ground.id, got: state.player.placeId, floors: places.filter((p) => p.buildingId === ground.buildingId).reduce((n, p) => Math.max(n, p.floor), 0) };
});
check(
  "standing in a stairwell puts you in the stairwell",
  climbed && climbed.want === climbed.got,
  climbed ? `${climbed.got} · ${climbed.floors + 1} floors above it` : "no stairwell",
);

await page.keyboard.press("Space");
const upstairs = await until(() => {
  const s = window.dedsec.stats();
  return s.floor === 1 ? { floor: s.floor, place: window.dedsec.state().player.placeId } : null;
});
check(
  "the stairs go up",
  Boolean(upstairs),
  upstairs ? `floor ${upstairs.floor} · ${upstairs.place}` : "still on the ground",
);

// And the storey you arrived on is a real one, with rooms you can be in. Note
// that repositioning keeps your height: a floor is somewhere you stay.
const above = await page.evaluate(() => {
  const state = window.dedsec.state();
  const here = state.city.graph.places.get(state.player.placeId);
  const stair = here.id;
  const room = [...state.city.graph.places.values()].find(
    (p) => p.buildingId === here.buildingId && p.floor === here.floor && p.kind !== "stairwell",
  );
  window.dedsec.goTo(room.x, room.y);
  const at = state.player.placeId;
  // Back to the stairs, so the way down is the way anyone would take it.
  const back = state.city.graph.places.get(stair);
  window.dedsec.goTo(back.x, back.y);
  return { room: room.name, at, want: room.id, floor: window.dedsec.stats().floor };
});
check("floor 1 has rooms you can stand in", above.at === above.want, `${above.room} · floor ${above.floor}`);

await page.keyboard.press("KeyC");
const down = await until(() => (window.dedsec.stats().floor === 0 ? true : null));
check("and back down again", down === true, down ? "" : "stuck upstairs");

/* --- 7. and you can move once you are in there --------------------------- */

// Rooms now have columns and furniture in them, and both are real colliders.
// The failure mode that costs a player the session is being put down inside
// one with every direction blocked, so stand in a few and check you can walk.
// Ground floor only, because repositioning keeps your height — but every floor
// is furnished by the same code, so this is a fair sample of it.
const stuck = [];
const sample = await page.evaluate(() =>
  [...window.dedsec.state().city.graph.places.values()]
    .filter((p) => p.indoor && p.floor === 0 && p.kind !== "stairwell" && p.kind !== "corridor")
    .slice(0, 4)
    .map((p) => ({ name: p.name, x: p.x, y: p.y })),
);
for (const room of sample) {
  const from = await page.evaluate((r) => {
    window.dedsec.goTo(r.x, r.y, r.x + 20, r.y);
    return window.dedsec.stats().at;
  }, room);
  await page.keyboard.down("KeyW");
  let best = 0;
  for (let tick = 0; tick < 8 && best < 1; tick++) {
    await page.waitForTimeout(300);
    const at = await page.evaluate(() => window.dedsec.stats().at);
    best = Math.max(best, Math.hypot(at[0] - from[0], at[1] - from[1]));
  }
  await page.keyboard.up("KeyW");
  if (best < 1) stuck.push(`${room.name} (${best.toFixed(1)}m)`);
}
check(
  "nothing in a room can trap you in it",
  stuck.length === 0,
  stuck.length ? `stuck in ${stuck.join(", ")}` : sample.map((r) => r.name).join(", "),
);

/* --- 8. a case can be seen and closed ------------------------------------ */

const resolved = await page.evaluate(async () => {
  const state = window.dedsec.state();
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
