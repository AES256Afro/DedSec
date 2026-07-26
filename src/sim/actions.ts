/**
 * Player commands.
 *
 * Everything the player can do goes through here, so the UI, the tests and any
 * future scripted agent all drive the world through exactly one surface. If it
 * cannot be expressed as a call in this file, the player cannot do it.
 */

import { breachNode, releaseNode } from "../hack/breach.js";
import { SCAN_RANGE, computeReach, type Reachable } from "../hack/access.js";
import { invoke, verb, verbsForNode, verbsForNpc, type OfferedVerb, type VerbOutcome } from "../hack/verbs.js";
import { recomputeLayer } from "../profile/profiler.js";
import type { Npc, NpcId } from "../npc/types.js";
import type { NodeId, PlaceId } from "../world/types.js";
import { advance, playerCanPass, step } from "./step.js";
import type { GameState } from "./state.js";

export interface ActionResult {
  ok: boolean;
  message: string;
}

/* --------------------------------------------------------------- movement */

export function walkTo(state: GameState, placeId: PlaceId): ActionResult {
  if (!state.city.graph.places.has(placeId)) return { ok: false, message: "Nowhere to go." };
  const path = state.city.graph.findPath(state.player.placeId, placeId, (_edge, door) =>
    playerCanPass(state, door),
  );
  if (!path) return { ok: false, message: "No route you can actually walk — something is locked." };
  state.player.destinationId = placeId;
  state.player.path = path.steps.map((s) => s.to);
  return {
    ok: true,
    message: `Walking to ${state.city.graph.place(placeId).name} — about ${Math.ceil(path.minutes)} minutes.`,
  };
}

/** Walk there and let the world run until you arrive (or give up). */
export function walkAndWait(state: GameState, placeId: PlaceId, cap = 240): ActionResult {
  const result = walkTo(state, placeId);
  if (!result.ok) return result;
  for (let i = 0; i < cap && state.player.placeId !== placeId; i++) step(state, 1);
  return state.player.placeId === placeId
    ? { ok: true, message: `Arrived at ${state.city.graph.place(placeId).name}.` }
    : { ok: false, message: "Could not get there." };
}

export function deployDrone(state: GameState): ActionResult {
  if (state.player.drone.deployed) return { ok: false, message: "Drone is already up." };
  if (state.player.drone.battery < 0.1) return { ok: false, message: "Drone battery too low." };
  state.player.drone.deployed = true;
  state.player.drone.placeId = state.player.placeId;
  return { ok: true, message: "Drone up." };
}

export function recallDrone(state: GameState): ActionResult {
  state.player.drone.deployed = false;
  state.player.drone.placeId = state.player.placeId;
  return { ok: true, message: "Drone recalled." };
}

/**
 * Fly the drone. It ignores doors and walls but cannot enter a sealed indoor
 * space from outside — it needs an opening, which in practice means a place
 * that is outdoors or already visible from where it is.
 */
export function flyDroneTo(state: GameState, placeId: PlaceId): ActionResult {
  if (!state.player.drone.deployed) return { ok: false, message: "Drone is not deployed." };
  const graph = state.city.graph;
  const to = graph.places.get(placeId);
  const from = graph.places.get(state.player.drone.placeId);
  if (!to || !from) return { ok: false, message: "Nowhere to fly to." };
  if (to.indoor && from.indoor === false && !from.sightlines.includes(to.id)) {
    return { ok: false, message: `${to.name} is sealed — the drone needs an opening it can see through.` };
  }
  state.player.drone.placeId = placeId;
  state.player.drone.battery = Math.max(0, state.player.drone.battery - 0.03);
  return { ok: true, message: `Drone over ${to.name}.` };
}

/* --------------------------------------------------------------- network */

export function reach(state: GameState): Map<NodeId, Reachable> {
  return computeReach(state);
}

export function breach(state: GameState, nodeId: NodeId): ActionResult {
  const outcome = breachNode(state, nodeId);
  return { ok: outcome.ok, message: outcome.message };
}

export function release(state: GameState, nodeId: NodeId): ActionResult {
  const outcome = releaseNode(state, nodeId);
  return { ok: outcome.ok, message: outcome.message };
}

/* ------------------------------------------------------------------ verbs */

export function nodeVerbs(state: GameState, nodeId: NodeId): OfferedVerb[] {
  const node = state.city.nodes.get(nodeId);
  return node ? verbsForNode(state, node) : [];
}

export function npcVerbs(
  state: GameState,
  npcId: NpcId,
  extraParams: Record<string, unknown> = {},
): OfferedVerb[] {
  const target = state.npcs.get(npcId);
  return target ? verbsForNpc(state, target, extraParams) : [];
}

export function runNodeVerb(
  state: GameState,
  nodeId: NodeId,
  verbId: string,
  params: Record<string, unknown> = {},
): VerbOutcome {
  const node = state.city.nodes.get(nodeId);
  const v = verb(verbId);
  if (!node || !v) return { ok: false, message: "Unavailable." };
  return invoke(state, v, { node, params });
}

export function runNpcVerb(
  state: GameState,
  npcId: NpcId,
  verbId: string,
  params: Record<string, unknown> = {},
): VerbOutcome {
  const target = state.npcs.get(npcId);
  const v = verb(verbId);
  if (!target || !v) return { ok: false, message: "Unavailable." };
  return invoke(state, v, { target, params });
}

/* --------------------------------------------------------------- profiling */

/** Refresh every dossier — cheap, and keeps the UI honest after any breach. */
export function refreshProfiles(state: GameState): void {
  for (const person of state.npcs.values()) recomputeLayer(state, person);
}

/** People the player (or their drone, or a piloted camera) can currently see. */
export function visibleNpcs(state: GameState): Npc[] {
  const graph = state.city.graph;
  const origins = [state.player.placeId];
  if (state.player.drone.deployed) origins.push(state.player.drone.placeId);
  const viewNode = state.player.viewingNodeId ? state.city.nodes.get(state.player.viewingNodeId) : undefined;
  if (viewNode) origins.push(viewNode.placeId);

  return [...state.npcs.values()].filter((person) =>
    origins.some((origin) => graph.canSee(origin, person.placeId, SCAN_RANGE)),
  );
}

/* -------------------------------------------------------------------- time */

export function wait(state: GameState, minutes: number): ActionResult {
  advance(state, Math.max(1, Math.round(minutes)));
  return { ok: true, message: `Waited ${Math.round(minutes)} minutes.` };
}

/** Run the world until a predicate holds, or the cap is hit. */
export function waitUntil(
  state: GameState,
  predicate: (s: GameState) => boolean,
  capMinutes = 240,
): ActionResult {
  for (let i = 0; i < capMinutes; i++) {
    if (predicate(state)) return { ok: true, message: `Condition met after ${i} minutes.` };
    step(state, 1);
  }
  return predicate(state)
    ? { ok: true, message: "Condition met." }
    : { ok: false, message: `Gave up after ${capMinutes} minutes.` };
}
