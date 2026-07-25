/**
 * The flagship contract, played end to end.
 *
 * This is the design document as an executable assertion. If the profiling loop
 * feeds the leverage layer, and the leverage layer feeds the puppetry layer,
 * and the puppetry layer can move a chip out of a sealed case without anybody
 * lifting it, then this test passes. If any link in that chain breaks, it does
 * not — which makes it the single most valuable test in the suite.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { at } from "../src/core/time.js";
import { newGame, TARGET_BUILDING_ID, TARGET_LAB_KEY } from "../src/game.js";
import { breachNode } from "../src/hack/breach.js";
import { ghostReport } from "../src/hack/trace.js";
import { invokeById } from "../src/hack/verbs.js";
import { activateMission, missionRuntimes, tickMissions } from "../src/mission/runtime.js";
import { recomputeLayer } from "../src/profile/profiler.js";
import { evidenceNodesFor } from "../src/profile/profiler.js";
import { walkAndWait } from "../src/sim/actions.js";
import type { GameState } from "../src/sim/state.js";
import { advance } from "../src/sim/step.js";
import type { Npc } from "../src/npc/types.js";

function breachUntilOpen(state: GameState, nodeId: string, attempts = 20): void {
  for (let i = 0; i < attempts; i++) if (breachNode(state, nodeId).ok) return;
  throw new Error(`could not breach ${nodeId}`);
}

/** Deepen a dossier the honest way: breach the handset, then a second source. */
function profileToLayer2(state: GameState, person: Npc): void {
  if (person.phoneNodeId) breachUntilOpen(state, person.phoneNodeId);
  for (const id of evidenceNodesFor(person)) {
    if (id === person.phoneNodeId) continue;
    breachUntilOpen(state, id);
    recomputeLayer(state, person);
    if (person.profileLayer >= 2) return;
  }
}

function staff(state: GameState, archetypeId: string): Npc {
  const found = [...state.npcs.values()].find(
    (n) => n.orgId === "org_nodalis" && n.archetypeId === archetypeId,
  );
  if (!found) throw new Error(`Nodalis has no ${archetypeId}`);
  return found;
}

test("Specimen A7 can be taken without touching it", () => {
  const state = newGame({ seed: "heist", startAt: at(0, 9, 30) });
  // Reach is not what this test is about; the reach rules have their own tests.
  state.player.hackRange = 100_000;

  // The contract board gates this one behind the tutorial; that gating has its
  // own test, so satisfy it directly here and keep this test about the heist.
  missionRuntimes(state).find((r) => r.mission.id === "pattern_of_life")!.status = "complete";
  tickMissions(state);

  assert.ok(activateMission(state, "prototype_chip"));
  const runtime = missionRuntimes(state).find((r) => r.mission.id === "prototype_chip")!;
  assert.equal(runtime.status, "active");

  /* --- recon: read the three people who stand between you and the lab ----- */
  const chief = staff(state, "security_chief");
  const tech = staff(state, "lab_tech");
  profileToLayer2(state, chief);
  profileToLayer2(state, tech);
  assert.ok(chief.profileLayer >= 2, "the security chief should be readable");
  assert.ok(tech.profileLayer >= 2, "the lab tech should be readable");

  /* --- access: take the lab tech's credential off their own device -------- */
  const clone = invokeById(state, "clone_badge", {
    node: state.city.nodes.get(tech.phoneNodeId!)!,
    params: {},
  });
  assert.ok(clone.ok, clone.message);
  assert.ok(
    state.player.badges.some((b) => b.orgId === "org_nodalis" && b.clearance === "restricted"),
    "cloning a lab tech's badge should yield restricted clearance",
  );

  /* --- clear the room: get every Nodalis body out of the prototype lab ---- */
  const labPlaceId = state.city.roomPlaceIds.get(TARGET_LAB_KEY)!;
  const inLab = () => [...state.npcs.values()].filter((n) => n.placeId === labPlaceId && n.orgId === "org_nodalis");

  // Somewhere on another floor to send them. A lure with no destination only
  // makes someone stop and stare, which does not free up the room.
  const lure = state.city.roomPlaceIds.get("n0_lobby")!;

  // First the quiet way: lure them out one at a time with pretexts built from
  // their own dossiers. Some will bite, some will not — that is the point.
  for (let attempt = 0; attempt < 12 && inLab().length > 0; attempt++) {
    for (const person of inLab()) {
      if (person.profileLayer < 2) profileToLayer2(state, person);
      if (person.suspicion > 0.35) continue; // stop pushing someone who is onto you
      const hook = person.secrets
        .filter((s) => s.revealed)
        .flatMap((s) => s.hooks)
        .find((h) => h.verb.startsWith("forge_") || h.verb === "dangle_payout");
      if (hook) {
        invokeById(state, hook.verb, { target: person, params: { placeId: lure, ...(hook.params ?? {}) } });
      } else {
        invokeById(state, "fake_app_alert", {
          target: person,
          params: { interest: person.interests[0] ?? "their hobby", placeId: lure },
        });
      }
    }
    advance(state, 12);
  }

  // Whoever is left gets the loud way. Driving the climate is a physical fact
  // rather than a claim, so it cannot be disbelieved — it just costs trace.
  if (inLab().length > 0) {
    const hvac = [...state.city.nodes.values()].find(
      (n) => n.kind === "hvac" && n.placeId === labPlaceId,
    );
    assert.ok(hvac, "the lab should have climate control to abuse");
    breachUntilOpen(state, hvac!.id);
    for (let attempt = 0; attempt < 10 && inLab().length > 0; attempt++) {
      invokeById(state, "hvac_surge", { node: hvac!, params: {} });
      advance(state, 6);
    }
  }
  assert.deepEqual(inLab().map((n) => n.name), [], "the lab should be empty of staff");

  /* --- puppetry: make the building carry the chip out of its own case ----- */
  const labCase = [...state.city.nodes.values()].find(
    (n) => n.kind === "inventory_case" && n.placeId === labPlaceId,
  )!;
  assert.deepEqual(labCase.state["contents"], ["Specimen A7 prototype chip"]);
  breachUntilOpen(state, labCase.id);

  const requisition = invokeById(state, "requisition_asset", { node: labCase, params: {} });
  assert.ok(requisition.ok, requisition.message);
  assert.deepEqual(labCase.state["contents"], [], "the case should have released the chip");

  advance(state, 10); // the transfer runs on the building's own clock
  const dropped = [...state.orders.values()].find(
    (o) => o.kind === "requisition" && o.label.includes("Specimen A7"),
  );
  assert.ok(dropped, "the transfer should have deposited the chip somewhere");

  /* --- collect and leave -------------------------------------------------- */
  const arrival = walkAndWait(state, dropped!.destinationPlaceId, 600);
  assert.ok(arrival.ok, arrival.message);
  assert.ok(
    state.player.items.some((i) => i.label.includes("Specimen A7")),
    "standing where the building put it should be enough to collect it",
  );

  const exit = state.city.streetPlaceIds.get("s_foundry_plaza")!;
  const left = walkAndWait(state, exit, 600);
  assert.ok(left.ok, left.message);
  assert.notEqual(
    state.city.graph.place(state.player.placeId).buildingId,
    TARGET_BUILDING_ID,
    "and you should be able to walk back out",
  );

  tickMissions(state);
  assert.equal(runtime.status, "complete", `unfinished: ${runtime.mission.objectives
    .filter((o) => !runtime.completed.has(o.id))
    .map((o) => o.label)
    .join(", ")}`);
  assert.ok(runtime.awarded.includes("procedural"), "the chip left by an approved procedure");
});

test("the case cannot be emptied without opening the inventory system", () => {
  const state = newGame({ seed: "nolift", startAt: at(0, 10, 0) });
  state.player.hackRange = 100_000;
  const labPlaceId = state.city.roomPlaceIds.get(TARGET_LAB_KEY)!;
  const labCase = [...state.city.nodes.values()].find(
    (n) => n.kind === "inventory_case" && n.placeId === labPlaceId,
  )!;

  const attempt = invokeById(state, "requisition_asset", { node: labCase, params: {} });
  assert.ok(!attempt.ok, "you should not be able to requisition through an unbreached case");
  assert.deepEqual(labCase.state["contents"], ["Specimen A7 prototype chip"]);
});

test("brute force works and costs you the grade", () => {
  const quiet = newGame({ seed: "grades", startAt: at(0, 10, 0) });
  const baseline = ghostReport(quiet).score;
  assert.ok(baseline >= 95, "an untouched world reads clean");

  const loud = newGame({ seed: "grades", startAt: at(0, 10, 0) });
  loud.player.hackRange = 100_000;
  const pa = [...loud.city.nodes.values()].find(
    (n) => n.kind === "pa_system" && loud.city.graph.place(n.placeId).buildingId === TARGET_BUILDING_ID,
  )!;
  breachUntilOpen(loud, pa.id);
  const alarm = invokeById(loud, "fire_alarm", { node: pa, params: {} });
  assert.ok(alarm.ok, alarm.message);
  advance(loud, 5);

  const after = ghostReport(loud);
  assert.ok(after.score < baseline - 10, "pulling an alarm has to cost something");
  assert.ok(
    after.findings.some((f) => f.includes("alarm")),
    "and it has to show up in what an investigator could reconstruct",
  );
});

test("a mission stays locked until its prerequisite is done", () => {
  const state = newGame({ seed: "gating" });
  const back = missionRuntimes(state).find((r) => r.mission.id === "back_room")!;
  assert.equal(back.status, "locked");
  assert.equal(activateMission(state, "back_room"), false);

  const tutorial = missionRuntimes(state).find((r) => r.mission.id === "pattern_of_life")!;
  tutorial.status = "complete";
  tickMissions(state);
  assert.equal(back.status, "available");
  assert.ok(activateMission(state, "back_room"));
});

test("objectives latch — progress is never lost to the world moving on", () => {
  const state = newGame({ seed: "latch", startAt: at(0, 9, 0) });
  activateMission(state, "pattern_of_life");
  const runtime = missionRuntimes(state).find((r) => r.mission.id === "pattern_of_life")!;

  for (const person of [...state.npcs.values()].slice(0, 8)) person.revealedFields.add("identity");
  tickMissions(state);
  assert.ok(runtime.completed.has("scan_six"));

  // Undo the world state that satisfied it; the objective must stay done.
  for (const person of state.npcs.values()) person.revealedFields.clear();
  advance(state, 30);
  assert.ok(runtime.completed.has("scan_six"), "a completed objective never un-completes");
});
