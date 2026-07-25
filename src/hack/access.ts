/**
 * Network reach — the thing that makes position matter in a game with no guns.
 *
 * You can touch a node if any of these hold:
 *
 *   · it is within your handset's radio range;
 *   · it is within your drone's range and the drone is deployed;
 *   · it is within range of a node you have already breached that can route
 *     (junction boxes, routers, and — crucially — a phone in someone's pocket
 *     that is walking deeper into the building than you can);
 *   · its subnet has been exposed by breaching that subnet's router.
 *
 * Chain-hacking through a courier's handset into a subnet you have no physical
 * access to is the intended play, not an exploit.
 */

import type { GameState } from "../sim/state.js";
import type { NetworkNode, NodeId } from "../world/types.js";

/**
 * How far a passive profile reaches, in metres. This is "what you can see and
 * point a lens at", not radio range — breaching uses `PlayerState.hackRange`.
 */
export const SCAN_RANGE = 200;

export interface ReachSource {
  kind: "handset" | "drone" | "relay" | "subnet";
  /** Node that provided the reach, when it was a chain hop. */
  viaNodeId?: NodeId;
  label: string;
}

export interface Reachable {
  node: NetworkNode;
  source: ReachSource;
  /** Metres from whatever gave you reach; shown in the network view. */
  distance: number;
}

function metresBetween(state: GameState, a: string, b: string): number {
  const graph = state.city.graph;
  const pa = graph.places.get(a);
  const pb = graph.places.get(b);
  if (!pa || !pb) return Infinity;
  // Floors attenuate hard — concrete is concrete.
  const floorPenalty = Math.abs(pa.floor - pb.floor) * 90;
  return Math.hypot(pa.x - pb.x, pa.y - pb.y) + floorPenalty;
}

/** Everything the player could attempt to breach or operate right now. */
export function computeReach(state: GameState): Map<NodeId, Reachable> {
  const out = new Map<NodeId, Reachable>();
  const { player, city } = state;

  const consider = (node: NetworkNode, distance: number, source: ReachSource) => {
    if (!node.online) return;
    const existing = out.get(node.id);
    if (existing && existing.distance <= distance) return;
    out.set(node.id, { node, source, distance });
  };

  for (const node of city.nodes.values()) {
    // Direct handset range.
    const handsetDistance = metresBetween(state, player.placeId, node.placeId);
    if (handsetDistance <= player.hackRange) {
      consider(node, handsetDistance, { kind: "handset", label: "handset" });
    }

    // Drone.
    if (player.drone.deployed && player.drone.battery > 0) {
      const droneDistance = metresBetween(state, player.drone.placeId, node.placeId);
      if (droneDistance <= player.drone.range) {
        consider(node, droneDistance, { kind: "drone", label: "drone" });
      }
    }
  }

  // Chain hops. Iterate to a fixed point so a relay reached through a relay
  // still extends the chain — that is how you get four floors up from an alley.
  for (let pass = 0; pass < 4; pass++) {
    let grew = false;
    const hops = [...out.values()].filter(
      (r) => r.node.breached && r.node.capabilities.includes("route"),
    );
    for (const hop of hops) {
      for (const node of city.nodes.values()) {
        if (out.has(node.id)) continue;
        const distance = metresBetween(state, hop.node.placeId, node.placeId);
        if (distance <= hop.node.range) {
          consider(node, distance, {
            kind: "relay",
            viaNodeId: hop.node.id,
            label: `via ${hop.node.label}`,
          });
          grew = true;
        }
      }
    }
    if (!grew) break;
  }

  // An exposed subnet is reachable in its entirety.
  for (const subnet of city.subnets.values()) {
    if (!subnet.exposed) continue;
    for (const node of city.nodes.values()) {
      if (node.subnetId !== subnet.id || out.has(node.id)) continue;
      consider(node, 0, { kind: "subnet", label: `inside ${subnet.name}` });
    }
  }

  return out;
}

export interface BreachEstimate {
  /** World-minutes the breach occupies. */
  minutes: number;
  /** Trace added on success. */
  trace: number;
  /** 0..1 chance the breach is clean; failure spikes trace and may alert. */
  successChance: number;
  /** Why it is hard, for the UI. */
  notes: string[];
}

export function estimateBreach(state: GameState, node: NetworkNode, reach: Reachable): BreachEstimate {
  const subnet = state.city.subnets.get(node.subnetId);
  const notes: string[] = [];
  let hardening = node.hardening;

  if (subnet?.exposed) {
    hardening *= 0.45;
    notes.push(`${subnet.name} already exposed`);
  }
  if (reach.source.kind === "relay") {
    hardening *= 1.1;
    notes.push("relayed — noisier");
  }
  if (state.player.skills.has("deep_crawler")) {
    hardening *= 0.8;
    notes.push("Deep Crawler installed");
  }
  if (node.kind === "router") notes.push("gateway — exposes the whole subnet");

  const minutes = Math.max(0.5, 0.6 + hardening * 6);
  const trace = 0.02 + hardening * 0.14 + (state.trace.investigating ? 0.05 : 0);
  const successChance = Math.max(0.25, Math.min(0.98, 1 - hardening * 0.55));

  return { minutes, trace, successChance, notes };
}

export function isBreached(state: GameState, nodeId: NodeId): boolean {
  return state.player.breachedNodeIds.has(nodeId);
}

/**
 * Which places a camera at `nodeId` can see into. Cameras are how you profile
 * people you cannot physically approach, and how the *building* profiles you.
 */
export function cameraCoverage(state: GameState, node: NetworkNode): string[] {
  const graph = state.city.graph;
  const here = graph.places.get(node.placeId);
  if (!here) return [];
  const covered = new Set<string>([here.id]);
  for (const id of here.sightlines) covered.add(id);
  if (!here.indoor) {
    for (const p of graph.placesWithin(here.x, here.y, here.floor, 120)) {
      if (!p.indoor) covered.add(p.id);
    }
  }
  return [...covered];
}

/** Whether the player is currently inside the cone of any live, unbreached camera. */
export function underSurveillance(state: GameState): NetworkNode[] {
  const watching: NetworkNode[] = [];
  for (const node of state.city.nodes.values()) {
    if (node.kind !== "camera" || !node.online) continue;
    if (node.breached) continue; // a breached camera is looping for you
    if (cameraCoverage(state, node).includes(state.player.placeId)) watching.push(node);
  }
  return watching;
}

