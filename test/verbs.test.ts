import assert from "node:assert/strict";
import { test } from "node:test";

import { at } from "../src/core/time.js";
import { newGame } from "../src/game.js";
import { breachNode } from "../src/hack/breach.js";
import { addTrace, ghostReport, tickTrace } from "../src/hack/trace.js";
import { VERBS, contextualPlausibility, invokeById, occupantsOf, verbsForNode, verbsForNpc } from "../src/hack/verbs.js";
import { adjudicate, scoreImpulse } from "../src/npc/behavior.js";
import { recomputeLayer } from "../src/profile/profiler.js";
import type { Impulse, Npc } from "../src/npc/types.js";
import { Rng } from "../src/core/rng.js";
import type { GameState } from "../src/sim/state.js";
import { advance } from "../src/sim/step.js";

function breachUntilOpen(state: GameState, nodeId: string, attempts = 20): void {
  for (let i = 0; i < attempts; i++) if (breachNode(state, nodeId).ok) return;
  throw new Error(`could not breach ${nodeId}`);
}

function impulse(overrides: Partial<Impulse> = {}): Impulse {
  return {
    id: "imp_test",
    source: "player",
    label: "test",
    priority: 0.5,
    action: { type: "fixate", minutes: 5 },
    plausibility: 0.7,
    hingesOn: "curiosity",
    createdAt: 0,
    expiresAt: 1000,
    suspicionOnRefusal: 0.1,
    ...overrides,
  };
}

test("every verb declares a coherent contract", () => {
  const ids = new Set<string>();
  for (const v of VERBS) {
    assert.ok(!ids.has(v.id), `duplicate verb id: ${v.id}`);
    ids.add(v.id);
    assert.ok(v.label.length > 0 && v.blurb.length > 0, `${v.id} needs player-facing text`);
    assert.ok(v.trace >= 0 && v.evidence >= 0 && v.minutes >= 0, `${v.id} has a negative cost`);
    if (v.requiresCapability || v.requiresNodeKinds) {
      assert.equal(v.targets, "node", `${v.id} constrains a node but does not target one`);
    }
  }
  assert.ok(VERBS.length >= 25, "the toolkit should be broad enough to give real choices");
});

test("loud verbs cost more than quiet ones", () => {
  const alarm = VERBS.find((v) => v.id === "fire_alarm")!;
  const scan = VERBS.find((v) => v.id === "scan_area")!;
  assert.ok(alarm.trace > scan.trace * 5);
  assert.ok(alarm.evidence > scan.evidence);
});

test("a verb cannot be fired against an unbreached node, even bypassing the menu", () => {
  const state = newGame({ seed: "gates" });
  state.player.hackRange = 100_000;
  const speaker = [...state.city.nodes.values()].find((n) => n.kind === "speaker")!;
  const attempt = invokeById(state, "blast_speaker", { node: speaker, params: {} });
  assert.ok(!attempt.ok);
  assert.match(attempt.message, /not breached/i);
});

test("a verb cannot be fired at a node it does not apply to", () => {
  const state = newGame({ seed: "wrongkind" });
  state.player.hackRange = 100_000;
  const light = [...state.city.nodes.values()].find((n) => n.kind === "light")!;
  breachUntilOpen(state, light.id);
  const attempt = invokeById(state, "trigger_sprinkler", { node: light, params: {} });
  assert.ok(!attempt.ok);
});

test("out-of-range nodes are offered with a reason rather than hidden", () => {
  const state = newGame({ seed: "range" });
  state.player.hackRange = 1;
  const far = [...state.city.nodes.values()].find((n) => n.kind === "camera")!;
  const offers = verbsForNode(state, far);
  assert.ok(offers.length > 0, "the player should still see what the device could do");
  assert.ok(offers.every((o) => !o.availability.ok));
  assert.match(offers[0]!.availability.reason ?? "", /range|breach/i);
});

test("plausibility responds to context, not just to a base number", () => {
  const state = newGame({ seed: "context", startAt: at(0, 12, 0) });
  const person = [...state.npcs.values()][0]!;
  const theirThing = person.interests[0]!;

  const onTarget = contextualPlausibility(state, person, 0.6, { interest: theirThing });
  const offTarget = contextualPlausibility(state, person, 0.6, { interest: "competitive ferret grooming" });
  assert.ok(onTarget > offTarget, "a pretext built on a real interest must land harder");

  const daytime = contextualPlausibility(state, person, 0.6, { sensibleHours: [8, 18] });
  const night = newGame({ seed: "context", startAt: at(0, 3, 30) });
  const nightPerson = [...night.npcs.values()][0]!;
  const smallHours = contextualPlausibility(night, nightPerson, 0.6, { sensibleHours: [8, 18] });
  assert.ok(daytime > smallHours, "the same claim should be less believable at 03:30");
});

test("a trusted contact makes a forgery land; a stranger does not", () => {
  const state = newGame({ seed: "trust" });
  const person = [...state.npcs.values()].find((n) => n.relationships.some((r) => r.trust > 0.8))!;
  const trusted = person.relationships.find((r) => r.trust > 0.8)!;
  const close = contextualPlausibility(state, person, 0.6, { asNpcId: trusted.otherId });
  const stranger = contextualPlausibility(state, person, 0.6, { asNpcId: "npc_nobody" });
  assert.ok(close > stranger);
});

test("sceptical people are harder to move than credulous ones", () => {
  const state = newGame({ seed: "belief", startAt: at(0, 12, 0) });
  const people = [...state.npcs.values()];
  const credulous = people.reduce((a, b) => (b.traits.curiosity > a.traits.curiosity ? b : a));
  const sceptic = people.reduce((a, b) => (b.traits.curiosity < a.traits.curiosity ? b : a));

  const soft = scoreImpulse(credulous, impulse(), state.time).belief;
  const hard = scoreImpulse(sceptic, impulse(), state.time).belief;
  assert.ok(soft > hard, "the trait the pretext targets has to matter");
});

test("existing suspicion makes the next play harder", () => {
  const state = newGame({ seed: "suspicion", startAt: at(0, 12, 0) });
  const person = [...state.npcs.values()][0]!;
  const clean = scoreImpulse(person, impulse(), state.time).belief;
  person.suspicion = 0.8;
  const rattled = scoreImpulse(person, impulse(), state.time).belief;
  assert.ok(rattled < clean, "burning someone should cost you for the rest of the day");
});

test("adjudication produces all three verdicts across a population", () => {
  const state = newGame({ seed: "verdicts", startAt: at(0, 12, 0) });
  const rng = new Rng("verdicts:rolls");
  const verdicts = new Set<string>();
  for (const person of state.npcs.values()) {
    for (let i = 0; i < 6; i++) {
      verdicts.add(adjudicate(person, impulse(), state.time, rng).verdict);
    }
  }
  assert.deepEqual([...verdicts].sort(), ["accept", "doubt", "reject"]);
});

test("a rejected play leaves the target suspicious and on record", () => {
  const state = newGame({ seed: "burn", startAt: at(0, 12, 0) });
  state.player.hackRange = 100_000;
  const person = [...state.npcs.values()].find((n) => n.phoneNodeId && n.condition === "normal")!;
  breachUntilOpen(state, person.phoneNodeId!);
  person.profileLayer = 1;

  // A bait pretext aimed at someone with no curiosity to hook and every
  // inclination to check: it should bounce, repeatedly.
  person.traits.diligence = 0.99;
  person.traits.curiosity = 0.02;
  for (let i = 0; i < 10; i++) {
    invokeById(state, "fake_app_alert", { target: person, params: { interest: "nothing they care about" } });
    advance(state, 10);
  }
  assert.ok(person.suspicion > 0, "somebody who saw through you should stay wary");
  assert.ok(
    state.log.all().some((e) => e.kind === "npc.impulse_rejected"),
    "and it should be on the record",
  );
});

test("the odds shown before committing are the odds actually rolled against", () => {
  // The forecast is only worth showing if it cannot drift from the live path.
  // Both go through scoreImpulse, and this pins that they agree exactly.
  const state = newGame({ seed: "forecast", startAt: at(0, 12, 0) });
  state.player.hackRange = 100_000;
  const person = [...state.npcs.values()].find((n) => n.phoneNodeId && n.condition === "normal")!;
  breachUntilOpen(state, person.phoneNodeId!);
  recomputeLayer(state, person);

  const offered = verbsForNpc(state, person).find((o) => o.verb.id === "fake_app_alert")!;
  assert.ok(offered.forecast, "a fallible play must forecast");
  const predicted = offered.forecast!.belief;

  const outcome = invokeById(state, "fake_app_alert", { target: person, params: offered.params });
  assert.ok(outcome.ok, outcome.message);
  assert.ok(
    Math.abs((outcome.belief ?? -1) - predicted) < 1e-9,
    `forecast ${predicted} did not match the delivered ${outcome.belief}`,
  );

  const queued = person.impulses[0]!;
  const live = scoreImpulse(person, queued, state.time).belief;
  assert.ok(Math.abs(live - predicted) < 1e-9, "and the queued impulse must score the same");
});

test("the forecast reacts to the same context the roll does", () => {
  const state = newGame({ seed: "forecast2", startAt: at(0, 12, 0) });
  state.player.hackRange = 100_000;
  const person = [...state.npcs.values()].find((n) => n.phoneNodeId && n.condition === "normal")!;
  breachUntilOpen(state, person.phoneNodeId!);
  recomputeLayer(state, person);

  const onTarget = verbsForNpc(state, person, { interest: person.interests[0] }).find(
    (o) => o.verb.id === "fake_app_alert",
  )!;
  const offTarget = verbsForNpc(state, person, { interest: "competitive ferret grooming" }).find(
    (o) => o.verb.id === "fake_app_alert",
  )!;
  assert.ok(onTarget.forecast!.belief > offTarget.forecast!.belief);

  person.suspicion = 0.8;
  const rattled = verbsForNpc(state, person, { interest: person.interests[0] }).find(
    (o) => o.verb.id === "fake_app_alert",
  )!;
  assert.ok(rattled.forecast!.belief < onTarget.forecast!.belief, "burning someone must show up in the odds");
  assert.ok(
    rattled.forecast!.notes.some((n) => n.includes("suspicious")),
    "and the readout must say why",
  );
});

test("only fallible plays forecast — physical effects do not pretend to be uncertain", () => {
  const state = newGame({ seed: "nofore" });
  for (const v of VERBS) {
    if (v.forecast) {
      assert.equal(v.targets, "npc", `${v.id} forecasts but does not target a person`);
    }
  }
  const hvac = VERBS.find((v) => v.id === "hvac_surge")!;
  assert.equal(hvac.forecast, undefined, "a stimulus has no odds to show");
  void state;
});

test("breaching a handset identifies its owner", () => {
  const state = newGame({ seed: "identify" });
  state.player.hackRange = 100_000;
  const person = [...state.npcs.values()].find((n) => n.phoneNodeId)!;
  assert.ok(!person.revealedFields.has("identity"), "unknown before you touch anything");
  breachUntilOpen(state, person.phoneNodeId!);
  assert.ok(
    person.revealedFields.has("identity"),
    "you cannot read someone's phone and still not know who they are",
  );
});

test("physical stimuli cannot be disbelieved; claims can", () => {
  // The central trade in the toolkit: environmental verbs always land and cost
  // trace, social verbs are quiet and fallible. If a maximally sceptical,
  // maximally diligent person can ignore water coming out of the ceiling, the
  // distinction has collapsed.
  const state = newGame({ seed: "stimulus", startAt: at(0, 11, 0) });
  state.player.hackRange = 100_000;
  advance(state, 30);

  const hvac = [...state.city.nodes.values()].find(
    (n) => n.kind === "hvac" && occupantsOf(state, n.placeId).length > 0,
  );
  if (!hvac) return; // no populated room with climate control on this seed

  const room = hvac.placeId;
  for (const person of occupantsOf(state, room)) {
    person.traits.diligence = 0.97;
    person.traits.techLiteracy = 0.97;
    person.traits.curiosity = 0.03;
    person.suspicion = 0.9; // already convinced someone is working them
  }
  const before = occupantsOf(state, room).map((p) => p.id);
  assert.ok(before.length > 0);

  breachUntilOpen(state, hvac.id);
  const result = invokeById(state, "hvac_surge", { node: hvac, params: {} });
  assert.ok(result.ok, result.message);
  advance(state, 4);

  const stillThere = occupantsOf(state, room).filter((p) => before.includes(p.id));
  assert.equal(stillThere.length, 0, "nobody gets to disbelieve the temperature");
  assert.ok(
    !state.log.all().some((e) => e.kind === "npc.impulse_rejected" && e.data?.["originHackId"] === "hvac_surge"),
    "and it should never be adjudicated at all",
  );
});

test("trace rises with action and decays with silence", () => {
  const state = newGame({ seed: "trace" });
  addTrace(state, 0.4, "test");
  const peak = state.trace.level;
  assert.ok(peak >= 0.4);
  state.time += 30;
  tickTrace(state, 30);
  assert.ok(state.trace.level < peak, "going quiet should cool you off");
  assert.ok(state.trace.level >= 0, "but never below zero");
});

test("evidence never decays, even when trace does", () => {
  const state = newGame({ seed: "evidence" });
  addTrace(state, 0.5, "test");
  const before = ghostReport(state).evidence;
  state.time += 200;
  tickTrace(state, 200);
  assert.equal(state.trace.level, 0);
  assert.equal(ghostReport(state).evidence, before, "the forensic record is permanent");
});

test("saturating trace opens an investigation that re-keys your badges", () => {
  const state = newGame({ seed: "investigation" });
  state.player.badges.push({
    npcId: "npc_1",
    npcName: "Test",
    orgId: "org_nodalis",
    clearance: "restricted",
    expiresAt: state.time + 1000,
  });
  addTrace(state, 1.2, "saturation");
  assert.ok(state.trace.investigating);
  assert.ok(state.player.badges[0]!.expiresAt <= state.time + 12, "clearances get rotated when someone looks");
});

test("a lockout physically holds the people in the room", () => {
  const state = newGame({ seed: "lockout", startAt: at(0, 11, 0) });
  state.player.hackRange = 100_000;
  advance(state, 60);

  const lock = [...state.city.nodes.values()].find((n) => {
    if (n.kind !== "smart_lock") return false;
    return occupantsOf(state, n.placeId).length > 0;
  });
  if (!lock) return; // nobody happened to be in a lockable room; nothing to assert
  breachUntilOpen(state, lock.id);
  const trapped = occupantsOf(state, lock.placeId).map((p: Npc) => p.id);
  const result = invokeById(state, "maintenance_lockout", { node: lock, params: { minutes: 10 } });
  assert.ok(result.ok, result.message);
  for (const id of trapped) {
    assert.equal(state.npcs.get(id)!.condition, "confined");
  }
});
