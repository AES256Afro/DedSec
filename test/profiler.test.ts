import assert from "node:assert/strict";
import { test } from "node:test";

import { newGame } from "../src/game.js";
import { breachNode } from "../src/hack/breach.js";
import { computeReach } from "../src/hack/access.js";
import { buildDossier, evidenceNodesFor, recomputeLayer } from "../src/profile/profiler.js";
import { verbsForNpc } from "../src/hack/verbs.js";
import type { GameState } from "../src/sim/state.js";
import type { Npc } from "../src/npc/types.js";

/** Breach without needing to be in range — isolates profiler logic from reach. */
function forceBreach(state: GameState, nodeId: string): void {
  const node = state.city.nodes.get(nodeId);
  if (!node) throw new Error(`no node ${nodeId}`);
  node.breached = true;
  state.player.breachedNodeIds.add(nodeId);
}

/**
 * Breaching can fail by design, so anything testing what happens *after* a
 * successful breach retries rather than gambling on one roll.
 */
function breachUntilOpen(state: GameState, nodeId: string, attempts = 12): void {
  for (let i = 0; i < attempts; i++) {
    if (breachNode(state, nodeId).ok) return;
  }
  throw new Error(`could not breach ${nodeId} in ${attempts} attempts`);
}

function anyoneWithSecrets(state: GameState): Npc {
  const found = [...state.npcs.values()].find(
    (n) => n.secrets.some((s) => s.layer === 2) && n.phoneNodeId,
  );
  if (!found) throw new Error("expected somebody with a layer-2 secret");
  return found;
}

test("profiling starts at nothing and cannot be skipped", () => {
  const state = newGame({ seed: "layers" });
  const person = anyoneWithSecrets(state);
  assert.equal(person.profileLayer, 0);
  assert.equal(recomputeLayer(state, person), 0);
  assert.ok(person.secrets.every((s) => !s.revealed), "no secret is legible before any breach");
});

test("the handset alone gets you to layer 1 and no further", () => {
  const state = newGame({ seed: "layers" });
  const person = anyoneWithSecrets(state);
  forceBreach(state, person.phoneNodeId!);
  assert.equal(recomputeLayer(state, person), 1);
  assert.ok(person.profileLayer < 2, "one source is never enough for the private layer");
});

test("layer 2 requires a genuinely independent second source", () => {
  const state = newGame({ seed: "layers" });
  const person = anyoneWithSecrets(state);
  forceBreach(state, person.phoneNodeId!);

  const secondary = evidenceNodesFor(person).filter((id) => id !== person.phoneNodeId);
  assert.ok(secondary.length > 0, "there should be somewhere else the evidence lives");
  forceBreach(state, secondary[0]!);

  assert.equal(recomputeLayer(state, person), 2);
  const revealed = person.secrets.filter((s) => s.revealed);
  assert.ok(revealed.length > 0, "layer 2 should surface something");
});

test("a revealed secret only shows up when its own evidence was breached", () => {
  const state = newGame({ seed: "evidence" });
  const person = anyoneWithSecrets(state);
  forceBreach(state, person.phoneNodeId!);
  recomputeLayer(state, person);

  for (const secret of person.secrets) {
    if (!secret.revealed) continue;
    assert.ok(
      secret.sourceNodeIds.some((id) => state.player.breachedNodeIds.has(id)),
      `${secret.kind} claims to be revealed without any breached source`,
    );
  }
});

test("secrets turn into verbs — the whole loop in one assertion", () => {
  const state = newGame({ seed: "leverage" });
  const person = anyoneWithSecrets(state);

  const before = verbsForNpc(state, person).map((o) => o.verb.id);

  forceBreach(state, person.phoneNodeId!);
  const secondary = evidenceNodesFor(person).filter((id) => id !== person.phoneNodeId);
  forceBreach(state, secondary[0]!);
  recomputeLayer(state, person);

  const after = verbsForNpc(state, person);
  const unlocked = after.filter((o) => o.leverageLabel);
  assert.ok(unlocked.length > 0, "surfacing a secret must unlock at least one new play");
  assert.ok(
    unlocked.some((o) => o.verb.leverageOnly && !before.includes(o.verb.id)),
    "at least one play must be one you could not have made before",
  );

  // Not every hook unlocks a *verb*. An affair points at `forge_message`, which
  // is offered against anybody — what the secret supplies is the parameter:
  // *who* to forge as, and that they will be believed. A hook whose value is
  // its arguments rather than its verb id is working as designed, and an
  // earlier version of this test asserted otherwise and passed only because of
  // which person the population generator happened to produce first.
  for (const offered of unlocked) {
    assert.ok(offered.leverageLabel, "a hook-derived play must say which fact unlocked it");
  }
});

test("leverage verbs are never offered without the secret behind them", () => {
  const state = newGame({ seed: "gated" });
  const person = anyoneWithSecrets(state);
  const offered = verbsForNpc(state, person);
  assert.ok(
    offered.every((o) => !o.verb.leverageOnly),
    "an unprofiled person should expose no leverage-gated verbs at all",
  );
});

test("the dossier only prints fields the player has earned", () => {
  const state = newGame({ seed: "dossier" });
  const person = anyoneWithSecrets(state);

  const cold = buildDossier(state, person);
  assert.equal(cold.layer, 0);
  for (const section of cold.sections) {
    if (section.layer > 0) assert.equal(section.fields.length, 0, `${section.title} leaked at layer 0`);
  }
  assert.ok(cold.nextStep.includes("phone"), "and it should tell you what to do next");

  forceBreach(state, person.phoneNodeId!);
  recomputeLayer(state, person);
  const warm = buildDossier(state, person);
  assert.equal(warm.layer, 1);
  const deviceSection = warm.sections.find((s) => s.layer === 1)!;
  assert.ok(deviceSection.fields.length > 0, "layer 1 should populate the device section");
  assert.equal(warm.sections.find((s) => s.layer === 2)!.fields.length, 0);
});

test("breaching an org's record store deepens every dossier it corroborates", () => {
  const state = newGame({ seed: "records" });
  const staff = (state.rosters.get("org_nodalis") ?? []).map((id) => state.npcs.get(id)!);
  for (const person of staff) if (person.phoneNodeId) forceBreach(state, person.phoneNodeId);

  // Pick the record store that the most staff secrets actually cite.
  const cited = new Map<string, string[]>();
  for (const person of staff) {
    for (const secret of person.secrets) {
      for (const id of secret.sourceNodeIds) {
        if (id === person.phoneNodeId) continue;
        const node = state.city.nodes.get(id);
        if (node?.ownerId !== "org_nodalis") continue;
        cited.set(id, [...(cited.get(id) ?? []), person.id]);
      }
    }
  }
  const best = [...cited.entries()].sort((a, b) => b[1].length - a[1].length)[0];
  assert.ok(best, "some Nodalis record store should hold evidence on its own staff");

  const [recordNodeId, subjects] = best!;
  assert.ok(
    subjects.every((id) => state.npcs.get(id)!.profileLayer < 2),
    "those dossiers are still shallow before the breach",
  );

  state.player.hackRange = 100_000; // stand in for having physically got there
  breachUntilOpen(state, recordNodeId);

  for (const id of subjects) {
    assert.ok(
      state.npcs.get(id)!.profileLayer >= 2,
      "one breach should lift every dossier that store corroborates, not just the one you asked about",
    );
  }
});

test("reach extends through a breached relay, not through thin air", () => {
  const state = newGame({ seed: "reach" });
  const before = computeReach(state);

  const relay = [...before.values()].find((r) => r.node.kind === "relay");
  assert.ok(relay, "there should be a junction box on the plaza");
  const far = [...state.city.nodes.values()].find((n) => !before.has(n.id) && n.subnetId === "sn_public");
  assert.ok(far, "and something out of range to reach for");

  forceBreach(state, relay!.node.id);
  const after = computeReach(state);
  assert.ok(after.size > before.size, "breaching a relay must extend reach");
});

test("exposing a subnet's gateway opens every device on it", () => {
  const state = newGame({ seed: "subnet" });
  const router = [...state.city.nodes.values()].find(
    (n) => n.kind === "router" && n.subnetId === "sn_b_nodalis",
  )!;
  state.player.hackRange = 100_000;
  breachUntilOpen(state, router.id);

  const subnet = state.city.subnets.get("sn_b_nodalis")!;
  assert.ok(subnet.exposed);
  const reach = computeReach(state);
  const members = [...state.city.nodes.values()].filter((n) => n.subnetId === subnet.id);
  assert.ok(members.every((n) => reach.has(n.id)), "an exposed subnet is reachable end to end");
});
