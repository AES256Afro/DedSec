/**
 * Browser smoke test — the field terminal.
 *
 * Walks the real client through the opening of the intended loop: sweep the
 * plaza, put the drone through the lobby glass to get radio reach on people you
 * can see but cannot touch, breach a handset, and confirm the dossier deepens
 * and new plays appear. Fails on any console error or failed request.
 *
 * The unit suite proves the simulation is right; this proves the thing you
 * actually click is wired to it.
 *
 *   npm run serve                     # in one shell
 *   node scripts/smoke-terminal.mjs   # in another (needs playwright available)
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

// The street client is the front door now; the terminal lives one click in.
await page.goto(`${BASE}/terminal.html?seed=demo`, { waitUntil: "networkidle" });
await page.waitForTimeout(700);

check("boots with a clock and a contract", (await page.locator(".mission").count()) >= 1, await page.textContent("#clock-time"));

/* --- 1. passive sweep -------------------------------------------------- */
await page.keyboard.press("s");
await page.waitForTimeout(300);
const sweep = (await page.textContent("#toast"))?.trim() ?? "";
check("passive sweep finds people in view", /Profiled \d+ /.test(sweep), sweep);

/* --- 2. drone through the lobby glass ---------------------------------- */
await page.click("#btn-drone");
await page.waitForTimeout(200);
check("drone deploys", (await page.textContent("#btn-drone"))?.includes("Recall") ?? false);

const lobbyId = await page.evaluate(() => {
  const state = window.dedsec.state();
  const lobby = [...state.city.graph.places.values()].find((p) => p.name === "Nodalis lobby");
  window.dedsec.select("place", lobby.id);
  return lobby.id;
});
await page.waitForTimeout(200);
await page.click("[data-fly-to]");
await page.waitForTimeout(300);
const flyToast = (await page.textContent("#toast"))?.trim() ?? "";
check("drone reaches a room you cannot walk into", flyToast.startsWith("Drone over"), flyToast);

/* --- 3. reach and breach ------------------------------------------------ */
const reachable = await page.locator("#network .node-row").count();
check("drone extends network reach", reachable > 0, `${reachable} nodes in reach`);

let breached = 0;
for (let round = 0; round < 20 && breached === 0; round++) {
  const phones = page.locator("#network .node-row", { hasText: "phone" });
  if ((await phones.count()) === 0) break;
  await phones.first().click();
  await page.waitForTimeout(120);
  const button = page.locator("[data-breach-node]");
  if ((await button.count()) === 0) break;
  await button.first().click();
  await page.waitForTimeout(200);
  breached = await page.evaluate(() => window.dedsec.state().player.breachedNodeIds.size);
}
check("a handset can be breached", breached > 0, `${breached} node(s) open`);

/* --- 4. the profile actually deepens ------------------------------------ */
const owner = await page.evaluate(() => {
  const state = window.dedsec.state();
  const person = [...state.npcs.values()].find((n) => n.profileLayer >= 1);
  if (person) window.dedsec.select("npc", person.id);
  return person ? { name: person.name, layer: person.profileLayer } : null;
});
check("breaching a handset lifts a dossier to layer 1", owner !== null, owner ? `${owner.name} → layer ${owner.layer}` : "nobody");

await page.waitForTimeout(250);
const verbCount = await page.locator(".verb").count();
const available = await page.locator(".verb:not([disabled])").count();
check("plays are offered against a profiled person", verbCount > 0, `${available}/${verbCount} available`);

const dossier = (await page.textContent("#inspector")) ?? "";
check("the dossier shows earned layers and hides the rest", /layer [1-3]/.test(dossier) && /Cross-source/.test(dossier));

/* --- 5. the world keeps running ----------------------------------------- */
const feedBefore = await page.locator("#feed li").count();
await page.click('[data-speed="16"]');
await page.waitForTimeout(2500);
await page.click('[data-speed="1"]');
const feedAfter = await page.locator("#feed li").count();
check("the city carries on without you", feedAfter > feedBefore, `${feedBefore} → ${feedAfter} feed entries`);
console.log(`      clock ${await page.textContent("#clock-time")} · trace ${(await page.textContent("#trace-word"))?.trim()}`);

await page.screenshot({ path: "docs/screenshot-terminal.png" });
console.log("      screenshot -> docs/screenshot-terminal.png");

if (problems.length > 0) {
  console.log("\nproblems:\n  " + problems.join("\n  "));
  process.exitCode = 1;
} else {
  console.log("\nall checks passed, no console errors, no failed requests");
}

await browser.close();
