import assert from "node:assert/strict";
import { test } from "node:test";

import { MINUTES_PER_DAY, at } from "../src/core/time.js";
import { newGame } from "../src/game.js";
import { blockAt, onPost } from "../src/npc/schedule.js";
import { advance } from "../src/sim/step.js";

test("the population fills every rostered role", () => {
  const state = newGame({ seed: "roster" });
  const nodalis = state.rosters.get("org_nodalis") ?? [];
  const roles = nodalis.map((id) => state.npcs.get(id)!.archetypeId);
  for (const required of ["receptionist", "security_chief", "lab_tech", "engineer"]) {
    assert.ok(roles.includes(required), `Nodalis should employ a ${required}`);
  }
});

test("every routine covers all 1440 minutes of the day", () => {
  const state = newGame({ seed: "routines" });
  for (const person of state.npcs.values()) {
    const gaps: number[] = [];
    for (let m = 0; m < MINUTES_PER_DAY; m += 5) {
      if (!blockAt(person, m)) gaps.push(m);
    }
    assert.deepEqual(gaps, [], `${person.name} (${person.occupation}) has unscheduled time at ${gaps[0]}`);
  }
});

test("people are where their routine says they should be once the day settles", () => {
  const state = newGame({ seed: "settle", startAt: at(0, 7, 0) });
  advance(state, 240); // through the morning commute

  const workers = [...state.npcs.values()].filter(
    (n) => n.workPlaceId && n.condition === "normal" && !n.activeImpulse,
  );
  const onStation = workers.filter((n) => {
    const block = blockAt(n, state.time);
    return !block || n.placeId === block.placeId || n.destinationId === block.placeId;
  });
  const ratio = onStation.length / Math.max(1, workers.length);
  assert.ok(ratio > 0.85, `only ${(ratio * 100).toFixed(0)}% of workers were on or heading to station`);
});

test("posts are staffed during their shift", () => {
  const state = newGame({ seed: "posts", startAt: at(0, 8, 0) });
  advance(state, 180);
  const posted = [...state.npcs.values()].filter((n) => onPost(n, state.time));
  assert.ok(posted.length > 0, "somebody should be on a post at 11:00");
});

test("everyone carries a handset, and it travels with them", () => {
  const state = newGame({ seed: "devices" });
  for (const person of state.npcs.values()) {
    assert.ok(person.phoneNodeId, `${person.name} has no phone`);
    assert.ok(person.carrying.includes(person.phoneNodeId!), `${person.name} left their phone behind at spawn`);
  }

  const mover = [...state.npcs.values()].find((n) => n.workPlaceId && n.workPlaceId !== n.homePlaceId)!;
  const phone = state.city.nodes.get(mover.phoneNodeId!)!;
  advance(state, 400);
  assert.equal(phone.placeId, mover.placeId, "the handset should be wherever its owner is");
});

test("secrets and relationships form a connected social fabric", () => {
  const state = newGame({ seed: "fabric" });
  const secrets = [...state.npcs.values()].flatMap((n) => n.secrets);
  assert.ok(secrets.length > state.npcs.size * 0.8, "most people should have something to hide");

  // Every secret that implicates someone implicates a person who exists.
  for (const secret of secrets) {
    for (const id of secret.involves) {
      assert.ok(state.npcs.has(id), `secret ${secret.id} points at a non-existent person`);
    }
  }

  // Every secret carries at least one concrete way to act on it.
  for (const secret of secrets) {
    assert.ok(secret.hooks.length > 0, `secret ${secret.kind} unlocks nothing`);
  }
});

test("relationships are reciprocated with the right inverse", () => {
  const state = newGame({ seed: "reciprocal" });
  for (const person of state.npcs.values()) {
    for (const rel of person.relationships) {
      const other = state.npcs.get(rel.otherId);
      assert.ok(other, "relationship points at a real person");
      if (rel.kind === "manager") {
        assert.ok(
          other!.relationships.some((r) => r.otherId === person.id && r.kind === "report"),
          `${person.name} manages ${other!.name} but is not their manager in reverse`,
        );
      }
    }
  }
});

test("secrets never source evidence from a device that does not exist", () => {
  const state = newGame({ seed: "sources" });
  for (const person of state.npcs.values()) {
    for (const secret of person.secrets) {
      for (const nodeId of secret.sourceNodeIds) {
        assert.ok(state.city.nodes.has(nodeId), `${secret.id} cites a missing node`);
      }
    }
  }
});

test("nobody starts the game already suspicious", () => {
  const state = newGame({ seed: "calm" });
  for (const person of state.npcs.values()) {
    assert.equal(person.suspicion, 0);
  }
});

test("a day passes without the city reporting itself", () => {
  const state = newGame({ seed: "quietday" });
  advance(state, MINUTES_PER_DAY);
  assert.equal(state.trace.reports, 0, "an untouched city should never file an incident report");
  assert.ok(state.trace.level < 0.05, "and its ctOS trace should stay flat");
});
