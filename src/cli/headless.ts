/**
 * Headless runner.
 *
 * Boots a city, lets it run without a player, and prints what the simulation
 * did on its own. If the city is not interesting when nobody is touching it,
 * nothing the player does to it will be interesting either — so this is the
 * first thing to look at when the sim feels flat.
 *
 *   npm run sim -- --seed foundry --minutes 720
 */

import { formatDateTime } from "../core/time.js";
import { newGame } from "../game.js";
import { ghostReport } from "../hack/trace.js";
import { describeNpc } from "../npc/behavior.js";
import { advance } from "../sim/step.js";

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

const seed = arg("seed", "dedsec");
const minutes = Number(arg("minutes", "480"));
const verbose = process.argv.includes("--verbose");

const state = newGame({ seed });

console.log(`\n  Dedsec headless — seed "${seed}"`);
console.log(`  ${state.city.graph.places.size} places · ${state.city.nodes.size} network nodes · ${state.npcs.size} people`);
console.log(`  start ${formatDateTime(state.time)}, running ${minutes} world-minutes\n`);

const before = state.log.all().length;
advance(state, minutes);
const produced = state.log.all().slice(before);

const byKind = new Map<string, number>();
for (const event of produced) byKind.set(event.kind, (byKind.get(event.kind) ?? 0) + 1);

console.log("  ambient activity:");
for (const [kind, count] of [...byKind.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  console.log(`    ${String(count).padStart(4)}  ${kind}`);
}

if (verbose) {
  console.log("\n  last 20 events:");
  for (const event of produced.slice(-20)) {
    console.log(`    ${formatDateTime(event.at)} [${event.channel}] ${event.text}`);
  }
}

console.log("\n  a few lives, right now:");
for (const person of [...state.npcs.values()].slice(0, 8)) {
  const where = state.city.graph.place(person.placeId).name;
  console.log(
    `    ${person.name.padEnd(22)} ${person.occupation.padEnd(20)} ${where.padEnd(26)} ${describeNpc(person, state.city.graph, state.time)}`,
  );
}

const secretCount = [...state.npcs.values()].reduce((sum, n) => sum + n.secrets.length, 0);
const relationshipCount = [...state.npcs.values()].reduce((sum, n) => sum + n.relationships.length, 0);
console.log(
  `\n  social fabric: ${secretCount} secrets across ${state.npcs.size} people, ${relationshipCount} relationship edges`,
);

const report = ghostReport(state);
console.log(`\n  forensic baseline with no player activity: ${report.score}/100 (${report.grade})`);
console.log(`  ${report.findings.join("\n  ")}\n`);
