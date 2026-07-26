/**
 * Playtest harness.
 *
 * Drives the real client the way a player would and prints what they would see
 * at each step: which contracts are legible, what the first ten minutes offer,
 * whether the tutorial's objectives are discoverable without reading the source.
 *
 * This is not a pass/fail test — it is a read-out for judging *friction*. The
 * suite in test/ proves the simulation is correct; this shows whether the
 * correct simulation is playable.
 *
 *   npm run serve && node scripts/playtest.mjs
 */

import { existsSync } from "node:fs";

import { chromium } from "playwright";

const BASE = process.env.BASE_URL ?? "http://localhost:5173";
/** This sandbox preinstalls Chromium; CI uses Playwright's own download. */
function launchOptions() {
  const configured = process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium";
  return existsSync(configured) ? { executablePath: configured } : {};
}

const browser = await chromium.launch(launchOptions());
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on("pageerror", (e) => console.log(`  !! pageerror: ${e.message}`));

await page.goto(`${BASE}/?seed=playtest`, { waitUntil: "networkidle" });
await page.waitForTimeout(700);

const section = (title) => console.log(`\n── ${title} ${"─".repeat(Math.max(0, 58 - title.length))}`);
const state = () => page.evaluate(() => window.dednec.state());

/* --------------------------------------------------- what you open onto --- */

section("opening state");
console.log(`  clock        ${await page.textContent("#clock-time")}`);
console.log(`  contracts    ${await page.locator(".mission").count()} visible`);
console.log(`  in reach     ${await page.locator("#network .node-row").count()} devices`);
console.log(`  inspector    "${(await page.textContent("#inspector-title"))?.trim()}"`);
console.log(`  first hint   ${(await page.textContent("#inspector"))?.trim().slice(0, 120)}`);

/* ------------------------------------------------- can you see anybody? --- */

section("first minute: sweep, without being told how");
await page.keyboard.press("s");
await page.waitForTimeout(300);
console.log(`  S key        ${(await page.textContent("#toast"))?.trim()}`);

const visible = await page.evaluate(
  () => [...window.dednec.state().npcs.values()].filter((n) => n.revealedFields.has("identity")).length,
);
const identified = await page.evaluate(
  () => [...window.dednec.state().npcs.values()].filter((n) => n.profileLayer > 0).length,
);
console.log(`  profiled     ${visible} named, ${identified} at layer 1+`);

/* --------------------------------------- what can you actually do at t=0 --- */

section("what the plaza offers with no prior work");
const kinds = await page.evaluate(() => {
  const rows = [...document.querySelectorAll("#network .node-row")];
  const counts = {};
  for (const r of rows) {
    const label = r.textContent ?? "";
    const kind = label.includes("phone")
      ? "phone"
      : label.includes("scooter")
        ? "scooter"
        : label.includes("camera")
          ? "camera"
          : label.includes("junction")
            ? "relay"
            : "other";
    counts[kind] = (counts[kind] ?? 0) + 1;
  }
  return counts;
});
console.log(`  reachable    ${JSON.stringify(kinds)}`);

// Click the first device and see whether the panel explains itself.
await page.locator("#network .node-row").first().click();
await page.waitForTimeout(200);
console.log(`  selected     "${(await page.textContent("#inspector-title"))?.trim()}"`);
console.log(`  plays        ${await page.locator(".verb").count()} listed, ${await page.locator(".verb:not([disabled])").count()} available`);
const deadEnd = (await page.textContent("#inspector"))?.includes("Nothing applies here");
console.log(`  dead end?    ${deadEnd ? "YES — panel offers nothing and does not say why" : "no"}`);

/* ----------------------------------------------- the tutorial objectives --- */

section("tutorial: are the objectives discoverable?");
const objectives = await page.evaluate(() =>
  [...document.querySelectorAll(".mission .objectives li")].map((li) => li.textContent?.replace(/\s+/g, " ").trim()),
);
for (const o of objectives) console.log(`  ${o}`);

/* --------------------------------------------------- play it for a while --- */

section("ten simulated minutes of ordinary play");
await page.click("#btn-drone");
await page.evaluate(() => {
  const s = window.dednec.state();
  const lobby = [...s.city.graph.places.values()].find((p) => p.name === "Nodalis lobby");
  window.dednec.select("place", lobby.id);
});
await page.waitForTimeout(150);
await page.click("[data-fly-to]");
await page.waitForTimeout(200);

let breaches = 0;
for (let i = 0; i < 25; i++) {
  const phones = page.locator("#network .node-row:not(.is-breached)", { hasText: "phone" });
  if ((await phones.count()) === 0) break;
  await phones.first().click();
  await page.waitForTimeout(90);
  const button = page.locator("[data-breach-node]");
  if ((await button.count()) === 0) break;
  await button.first().click();
  await page.waitForTimeout(160);
  breaches = await page.evaluate(() => window.dednec.state().player.breachedNodeIds.size);
  const layered = await page.evaluate(
    () => [...window.dednec.state().npcs.values()].filter((n) => n.profileLayer >= 1).length,
  );
  if (layered >= 3) break;
}

const after = await page.evaluate(() => {
  const s = window.dednec.state();
  const people = [...s.npcs.values()];
  return {
    layer1: people.filter((n) => n.profileLayer >= 1).length,
    layer2: people.filter((n) => n.profileLayer >= 2).length,
    secrets: people.reduce((sum, n) => sum + n.secrets.filter((x) => x.revealed).length, 0),
    trace: s.trace.level,
  };
});
console.log(`  layer 1      ${after.layer1} people`);
console.log(`  layer 2      ${after.layer2} people`);
console.log(`  secrets      ${after.secrets} surfaced`);
console.log(`  trace        ${(after.trace * 100).toFixed(0)}%`);

/* --------------------------------------------------- next step legibility --- */

section("does the game tell you how to go deeper?");
const deep = await page.evaluate(() => {
  const s = window.dednec.state();
  const person = [...s.npcs.values()].find((n) => n.profileLayer === 1);
  if (person) window.dednec.select("npc", person.id);
  return person?.name ?? null;
});
await page.waitForTimeout(250);
const body = (await page.textContent("#inspector")) ?? "";
const nextStep = /Breach a second source[^.]*\./.exec(body)?.[0];
console.log(`  target       ${deep}`);
console.log(`  next step    ${nextStep ?? "(no guidance shown)"}`);

// Is that second source actually reachable from where the player is standing?
// Is the second source the guidance names actually reachable from here?
const reachable = await page.evaluate(() => {
  const s = window.dednec.state();
  const person = [...s.npcs.values()].find((n) => n.profileLayer === 1);
  if (!person) return null;
  const wanted = new Set(
    person.secrets.flatMap((x) => x.sourceNodeIds).concat(person.deviceIds).filter((id) => id !== person.phoneNodeId),
  );
  const listed = new Set(
    [...document.querySelectorAll("#network .node-row")].map((r) => r.textContent?.trim()),
  );
  const names = [...wanted].map((id) => s.city.nodes.get(id)?.label).filter(Boolean);
  return { needed: names.length, inReachNow: names.filter((n) => listed.has(n)).length };
});
console.log(`  sources      ${JSON.stringify(reachable)} (0 in reach = you must travel, by design)`);

const tutorialDone = await page.evaluate(() => {
  const t = window.dednec.state().missions.find((r) => r.mission.id === "pattern_of_life");
  return { completed: t ? t.completed.size : 0, total: t?.mission.objectives.length ?? 0 };
});
console.log(`  tutorial     ${tutorialDone.completed}/${tutorialDone.total} objectives met`);

await page.screenshot({ path: "docs/playtest.png" });
console.log("\n  screenshot -> docs/playtest.png\n");
await browser.close();
