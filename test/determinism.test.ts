/**
 * Determinism is not a nicety here — the forensic score compares your run
 * against what the city would have done anyway, and a mission whose objectives
 * are predicates over world state is only reproducible if the world is.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { at } from "../src/core/time.js";
import { newGame } from "../src/game.js";
import { breachNode } from "../src/hack/breach.js";
import type { GameState } from "../src/sim/state.js";
import { advance } from "../src/sim/step.js";

/** A stable summary of everything that could possibly have drifted. */
function fingerprint(state: GameState): string {
  const people = [...state.npcs.values()]
    .map((n) =>
      [
        n.id,
        n.name,
        n.placeId,
        n.condition,
        n.activity,
        n.suspicion.toFixed(6),
        n.stress.toFixed(6),
        n.profileLayer,
        n.impulses.length,
        n.secrets.map((s) => `${s.kind}:${s.weight.toFixed(4)}`).join("|"),
        n.relationships.map((r) => `${r.kind}>${r.otherId}`).join("|"),
      ].join(","),
    )
    .sort()
    .join("\n");

  const orders = [...state.orders.values()]
    .map((o) => `${o.id}:${o.kind}:${o.status}:${o.destinationPlaceId}:${o.dueAt}`)
    .sort()
    .join("\n");

  const events = state.log
    .all()
    .map((e) => `${e.at}:${e.kind}:${e.text}`)
    .join("\n");

  return [
    `t=${state.time}`,
    `trace=${state.trace.level.toFixed(6)}/${state.trace.evidence.toFixed(6)}/${state.trace.reports}`,
    people,
    orders,
    events,
  ].join("\n---\n");
}

test("two untouched runs of the same seed are byte-identical", () => {
  const a = newGame({ seed: "identical", startAt: at(0, 8, 0) });
  const b = newGame({ seed: "identical", startAt: at(0, 8, 0) });
  advance(a, 600);
  advance(b, 600);
  assert.equal(fingerprint(a), fingerprint(b));
});

test("different seeds produce genuinely different cities", () => {
  const a = newGame({ seed: "alpha" });
  const b = newGame({ seed: "beta" });
  const namesA = [...a.npcs.values()].map((n) => n.name).sort();
  const namesB = [...b.npcs.values()].map((n) => n.name).sort();
  assert.notDeepEqual(namesA, namesB);
});

test("identical player input on the same seed replays identically", () => {
  const play = (seed: string): string => {
    const state = newGame({ seed, startAt: at(0, 9, 0) });
    state.player.hackRange = 100_000;
    advance(state, 45);
    const targets = [...state.city.nodes.values()]
      .filter((n) => n.kind === "phone")
      .slice(0, 5)
      .map((n) => n.id);
    for (const id of targets) breachNode(state, id);
    advance(state, 90);
    return fingerprint(state);
  };
  assert.equal(play("replay"), play("replay"));
});

test("the runtime stream is independent of world generation", () => {
  // Generating the same city twice must not consume runtime randomness, or
  // every save/load round trip would silently diverge.
  const a = newGame({ seed: "streams" });
  newGame({ seed: "streams" });
  const b = newGame({ seed: "streams" });
  advance(a, 200);
  advance(b, 200);
  assert.equal(fingerprint(a), fingerprint(b));
});
