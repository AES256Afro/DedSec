/**
 * Every contract on the board must be completable.
 *
 * `heist.test.ts` proved Specimen A7 could be finished. The other three had
 * never been driven to completion by anything — and Back Room turned out to be
 * *impossible*: its target room sits behind a mechanical door, which has no
 * lock to hack and no node to breach, and the only override in the game
 * (`failOpen`, via the fire alarm) needs a PA, sprinkler or HVAC node that the
 * Paper Lantern does not have.
 *
 * A shipped contract nobody can finish is the worst bug this project can carry,
 * so completability is now an invariant with a test behind it rather than an
 * assumption.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { at } from "../src/core/time.js";
import { newGame } from "../src/game.js";
import { breachNode } from "../src/hack/breach.js";
import { invokeById } from "../src/hack/verbs.js";
import { MECHANICAL_RELOCK_MINUTES } from "../src/npc/behavior.js";
import type { Npc } from "../src/npc/types.js";
import { evidenceNodesFor, recomputeLayer } from "../src/profile/profiler.js";
import { activateMission, missionRuntimes, tickMissions } from "../src/mission/runtime.js";
import { walkAndWait, walkTo } from "../src/sim/actions.js";
import type { GameState } from "../src/sim/state.js";
import { advance, step } from "../src/sim/step.js";
import { MISSIONS } from "../src/mission/missions/index.js";

function breachUntilOpen(state: GameState, nodeId: string, attempts = 20): void {
  for (let i = 0; i < attempts; i++) if (breachNode(state, nodeId).ok) return;
  throw new Error(`could not breach ${nodeId}`);
}

function profileToLayer2(state: GameState, person: Npc): void {
  if (person.phoneNodeId) breachUntilOpen(state, person.phoneNodeId);
  for (const id of evidenceNodesFor(person)) {
    if (id === person.phoneNodeId) continue;
    breachUntilOpen(state, id);
    recomputeLayer(state, person);
    if (person.profileLayer >= 2) return;
  }
}

function unlockBoard(state: GameState): void {
  // The tutorial gates the rest of the board; its own gating has its own test.
  missionRuntimes(state).find((r) => r.mission.id === "pattern_of_life")!.status = "complete";
  tickMissions(state);
}

function staffOf(state: GameState, orgId: string): Npc[] {
  return [...state.npcs.values()].filter((n) => n.orgId === orgId);
}

/* ------------------------------------------------------------ reachability */

test("every room a contract names is reachable by some sequence of verbs", () => {
  // A door with a mechanical lock cannot be opened by the player directly and
  // carries no node, so the room behind it is only enterable if somebody with
  // clearance actually works there and leaves it open.
  const state = newGame({ seed: "reachable" });
  const graph = state.city.graph;

  for (const key of ["l0_office", "n4_lab", "n4_biocontain", "m0_records", "r0_dispatch"]) {
    const placeId = state.city.roomPlaceIds.get(key);
    assert.ok(placeId, `${key} should exist`);
    const doors = graph
      .edgesFrom(placeId!)
      .map((e) => (e.doorId ? graph.doors.get(e.doorId) : undefined))
      .filter(Boolean);

    for (const door of doors) {
      if (door!.lock !== "mechanical") {
        assert.ok(door!.nodeId, `${key}: ${door!.lock} door should be hackable`);
        continue;
      }
      // Mechanical: somebody must be rostered to work beyond it.
      const workers = [...state.npcs.values()].filter((n) => n.workPlaceId === placeId);
      assert.ok(
        workers.length > 0,
        `${key} sits behind a mechanical door with nobody working there — no player can ever get in`,
      );
    }
  }
});

test("a mechanical door someone walks through is briefly passable, then is not", () => {
  const state = newGame({ seed: "swing", startAt: at(0, 18, 0) });
  const office = state.city.roomPlaceIds.get("l0_office")!;
  const door = [...state.city.graph.doors.values()].find((d) => d.id === "dr_l0_office")!;
  assert.equal(door.lock, "mechanical");
  assert.ok(door.locked, "starts shut");

  // Run the evening until the manager uses their office.
  let sawOpen = false;
  for (let i = 0; i < 600 && !sawOpen; i++) {
    step(state, 1);
    if (!door.locked) sawOpen = true;
  }
  assert.ok(sawOpen, "somebody rostered to that office should open it during the evening");

  // And it swings shut again shortly afterwards.
  advance(state, MECHANICAL_RELOCK_MINUTES + 2);
  const stillInside = [...state.npcs.values()].some((n) => n.placeId === office && n.orgId === "org_lantern");
  if (!stillInside) assert.ok(door.locked, "the gap has to close, or it is not a gap");
});

/* --------------------------------------------------------- the contracts */

test("Back Room can be completed", () => {
  const state = newGame({ seed: "backroom", startAt: at(0, 18, 0) });
  state.player.hackRange = 100_000;
  unlockBoard(state);
  assert.ok(activateMission(state, "back_room"));
  const runtime = missionRuntimes(state).find((r) => r.mission.id === "back_room")!;

  const office = state.city.roomPlaceIds.get("l0_office")!;
  const bar = state.city.roomPlaceIds.get("l0_bar")!;
  const lantern = () => staffOf(state, "org_lantern");
  const watching = () => lantern().filter((n) => n.placeId === bar || n.placeId === office);

  // Be *in the room next door* before doing anything else. The gap a mechanical
  // door leaves is only a few minutes wide, which is nowhere near enough to
  // cross the city — so the play is to be standing in the bar, waiting.
  const floor = state.city.roomPlaceIds.get("l0_floor")!;
  const arrival = walkAndWait(state, floor, 600);
  assert.ok(arrival.ok, arrival.message);

  // The play, and it is genuinely a two-part one:
  //
  //   · the manager is the only person who ever opens that door, so the gap
  //     only exists after *she* walks through it — and she opens it on the way
  //     in and then sits in there for hours, so the useful gap is her exit;
  //   · the bar has to be empty of anyone who would see you take it.
  //
  // Both have to be true at once, which is exactly what the contract's
  // constraint text describes.
  const street = state.city.streetPlaceIds.get("s_marina_w")!;
  const door = state.city.graph.doors.get("dr_l0_office")!;
  const lastLure = new Map<string, number>();

  for (let tick = 0; tick < 2000 && runtime.status !== "complete"; tick++) {
    for (const person of watching()) {
      // Never push someone who is already wary — a burnt target stays burnt,
      // and hammering the same pretext is how you burn them.
      if (person.suspicion > 0.35 || person.activeImpulse) continue;
      // Press harder while the gap is actually open; pace yourself otherwise.
      const cooldown = door.locked ? 45 : 12;
      if (tick - (lastLure.get(person.id) ?? -Infinity) < cooldown) continue;
      lastLure.set(person.id, tick);

      if (person.profileLayer < 2) profileToLayer2(state, person);
      const hook = person.secrets
        .filter((s) => s.revealed)
        .flatMap((s) => s.hooks)
        .find((h) => h.verb.startsWith("forge_") || h.verb === "dangle_payout");
      if (hook) invokeById(state, hook.verb, { target: person, params: { placeId: street, ...(hook.params ?? {}) } });
      else invokeById(state, "fake_app_alert", { target: person, params: { interest: person.interests[0], placeId: street } });
    }

    if (watching().length === 0 && !door.locked) walkTo(state, office);
    step(state, 1);
    tickMissions(state);
  }

  const unfinished = runtime.mission.objectives
    .filter((o) => !runtime.completed.has(o.id))
    .map((o) => o.label);
  assert.deepEqual(unfinished, [], "Back Room left unfinishable objectives");
  assert.equal(runtime.status, "complete");
});

test("Ghost Shift can be completed", () => {
  const state = newGame({ seed: "ghostshift", startAt: at(0, 10, 0) });
  state.player.hackRange = 100_000;
  unlockBoard(state);
  assert.ok(activateMission(state, "ghost_shift"));
  const runtime = missionRuntimes(state).find((r) => r.mission.id === "ghost_shift")!;

  const chief = staffOf(state, "org_nodalis").find((n) => n.archetypeId === "security_chief")!;
  profileToLayer2(state, chief);
  assert.ok(chief.profileLayer >= 2, "the chief has to be readable");

  // He is the most sceptical person in the district, so lead with whatever his
  // own secrets unlocked and stop pushing the moment he starts doubting.
  //
  // *Which* lure matters, and picking the first one in the array is how a bot
  // loses to a chief with 0.96 diligence. The objective is to get him off the
  // site, so prefer the hooks that take somebody somewhere — an interview, an
  // auction to collect, a payout — over the ones that merely say something.
  const PULLS_HIM_OUT = [
    "forge_interview_invite",
    "forge_auction_win",
    "dangle_payout",
    "forge_family_emergency",
    "forge_clinic_reminder",
    "forge_summons",
  ];
  const bestHook = () => {
    const hooks = chief.secrets.filter((s) => s.revealed).flatMap((s) => s.hooks);
    for (const verb of PULLS_HIM_OUT) {
      const found = hooks.find((h) => h.verb === verb);
      if (found) return found;
    }
    return hooks.find((h) => h.verb.startsWith("forge_"));
  };

  for (let round = 0; round < 60 && runtime.status !== "complete"; round++) {
    if (chief.suspicion < 0.3 && !chief.activeImpulse && chief.condition === "normal") {
      const hook = bestHook();
      if (hook) invokeById(state, hook.verb, { target: chief, params: hook.params ?? {} });
      else invokeById(state, "fake_app_alert", { target: chief, params: { interest: chief.interests[0] } });
    }
    advance(state, 5);
    tickMissions(state);
  }

  const unfinished = runtime.mission.objectives
    .filter((o) => !runtime.completed.has(o.id))
    .map((o) => o.label);
  assert.deepEqual(unfinished, [], "Ghost Shift left unfinishable objectives");
  assert.ok(chief.suspicion < 0.3, "and he never saw through any of it");
});

test("Pattern of Life can be completed", () => {
  const state = newGame({ seed: "tutorial", startAt: at(0, 10, 0) });
  state.player.hackRange = 100_000;
  activateMission(state, "pattern_of_life");
  const runtime = missionRuntimes(state).find((r) => r.mission.id === "pattern_of_life")!;

  invokeById(state, "scan_area", { params: {} });
  for (const person of [...state.npcs.values()].slice(0, 8)) person.revealedFields.add("identity");

  for (const person of [...state.npcs.values()].filter((n) => n.phoneNodeId).slice(0, 6)) {
    profileToLayer2(state, person);
    tickMissions(state);
    if (runtime.status === "complete") break;
  }

  const unfinished = runtime.mission.objectives
    .filter((o) => !runtime.completed.has(o.id))
    .map((o) => o.label);
  assert.deepEqual(unfinished, [], "the tutorial left unfinishable objectives");
});

test("every contract states a brief, a constraint, and reachable objectives", () => {
  for (const mission of MISSIONS) {
    assert.ok(mission.brief.length > 40, `${mission.id} needs a real brief`);
    assert.ok(mission.constraint.length > 20, `${mission.id} needs a stated constraint`);
    assert.ok(mission.objectives.length > 0, `${mission.id} has no objectives`);
    assert.ok(mission.accolades.length > 0, `${mission.id} has nothing to grade`);
    for (const objective of mission.objectives) {
      assert.ok(objective.label.length > 0, `${mission.id}:${objective.id} needs a label`);
    }
  }
});
