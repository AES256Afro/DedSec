/**
 * Breaching a node — the one action everything else is downstream of.
 *
 * A breach is not free and not certain. Failing is the interesting case: you
 * lose the time, you spike the trace, and the subnet's anomaly counter climbs
 * toward an audit that will re-key every badge you cloned.
 */

import { recomputeLayer } from "../profile/profiler.js";
import type { GameState } from "../sim/state.js";
import type { NetworkNode, NodeId } from "../world/types.js";
import { computeReach, estimateBreach } from "./access.js";
import { addEvidence, addTrace, raiseSubnetAnomaly } from "./trace.js";

export interface BreachOutcome {
  ok: boolean;
  message: string;
  node?: NetworkNode;
}

export function breachNode(state: GameState, nodeId: NodeId): BreachOutcome {
  const node = state.city.nodes.get(nodeId);
  if (!node) return { ok: false, message: "Unknown node." };
  if (!node.online) return { ok: false, message: `${node.label} is offline.` };
  if (node.breached) return { ok: true, message: `${node.label} already open.`, node };

  const reach = computeReach(state);
  const entry = reach.get(nodeId);
  if (!entry) return { ok: false, message: `${node.label} is out of range.` };

  const estimate = estimateBreach(state, node, entry);
  state.time += estimate.minutes;

  const success = state.rng.next() < estimate.successChance;
  if (!success) {
    addTrace(state, estimate.trace * 2.2, `failed breach on ${node.label}`, [node.id]);
    addEvidence(state, 0.4);
    raiseSubnetAnomaly(state, node, 0.45);
    state.log.emit(state.time, {
      channel: "hack",
      kind: "hack.breach_failed",
      text: `Breach failed on ${node.label} — the attempt is in their logs.`,
      tone: "bad",
      subjects: [node.id],
      traceable: true,
    });
    return { ok: false, message: `Breach failed on ${node.label}.`, node };
  }

  node.breached = true;
  state.player.breachedNodeIds.add(node.id);
  addTrace(state, estimate.trace, `breached ${node.label}`, [node.id]);
  addEvidence(state, 0.15);
  raiseSubnetAnomaly(state, node, 0.12);

  // A gateway exposes everything behind it. This is the single biggest step-up
  // in reach available, which is why routers are always in the worst room.
  if (node.capabilities.includes("route") && node.kind === "router") {
    const subnet = state.city.subnets.get(node.subnetId);
    if (subnet && !subnet.exposed) {
      subnet.exposed = true;
      state.log.emit(state.time, {
        channel: "hack",
        kind: "hack.subnet_exposed",
        text: `${subnet.name} exposed — every device on it is reachable now.`,
        tone: "good",
        subjects: [subnet.id],
        traceable: true,
      });
    }
  }

  // Breaching a personal device may deepen the owner's dossier, and may deepen
  // *other* people's too, because a phone corroborates the people it talks to.
  if (node.ownerId) {
    const owner = state.npcs.get(node.ownerId);
    if (owner) {
      recomputeLayer(state, owner);
      for (const rel of owner.relationships) {
        const other = state.npcs.get(rel.otherId);
        if (other) recomputeLayer(state, other);
      }
    }
  }
  // Org-owned record stores are second sources for the whole staff roster.
  if (node.capabilities.includes("records") && node.ownerId?.startsWith("org_")) {
    for (const person of state.npcs.values()) {
      if (person.orgId === node.ownerId) recomputeLayer(state, person);
    }
    // The clinic corroborates anyone, not just its own staff.
    if (node.ownerId === "org_meridian") {
      for (const person of state.npcs.values()) recomputeLayer(state, person);
    }
  }

  state.log.emit(state.time, {
    channel: "hack",
    kind: "hack.breached",
    text: `Breached ${node.label}.`,
    tone: "good",
    subjects: [node.id],
    traceable: true,
  });

  return { ok: true, message: `Breached ${node.label}.`, node };
}

/** Give the node back. Reduces what a later audit can attribute to you. */
export function releaseNode(state: GameState, nodeId: NodeId): BreachOutcome {
  const node = state.city.nodes.get(nodeId);
  if (!node) return { ok: false, message: "Unknown node." };
  node.breached = false;
  state.player.breachedNodeIds.delete(nodeId);
  if (state.player.viewingNodeId === nodeId) state.player.viewingNodeId = undefined;
  state.trace.evidence = Math.max(0, state.trace.evidence - 0.05);
  return { ok: true, message: `Released ${node.label}.`, node };
}
