/**
 * The whole mutable world in one object.
 *
 * Deliberately a plain data container with no methods: every subsystem is a
 * free function taking `GameState`, which keeps the tick order explicit and
 * makes any state reachable from a test without standing up a renderer.
 */

import type { EventLog } from "../core/events.js";
import type { Rng } from "../core/rng.js";
import type { Instant } from "../core/time.js";
import type { Npc, NpcId } from "../npc/types.js";
import type { City } from "../world/generator.js";
import type { NodeId, PlaceId, SecurityZone } from "../world/types.js";

/** A physical or digital thing the player has taken possession of. */
export interface CarriedItem {
  id: string;
  label: string;
  /** Where it came from, for the forensics writeup. */
  sourceNodeId?: NodeId;
}

export interface ClonedBadge {
  npcId: NpcId;
  npcName: string;
  orgId: string;
  clearance: SecurityZone;
  /** Badge revocation once the owner notices, or the shift system rotates. */
  expiresAt: Instant;
}

export interface Disguise {
  label: string;
  /** Highest zone this pretext will carry you into without a second look. */
  zone: SecurityZone;
  expiresAt: Instant;
}

export interface PlayerState {
  placeId: PlaceId;
  transit?: { edgeId: string; fromPlaceId: PlaceId; toPlaceId: PlaceId; t: number };
  destinationId?: PlaceId;
  path: PlaceId[];
  /** Direct radio reach from the player's own handset, in metres. */
  hackRange: number;
  drone: {
    deployed: boolean;
    placeId: PlaceId;
    /** 0..1; deploying and flying drains it, recalling recharges. */
    battery: number;
    range: number;
    destinationId?: PlaceId;
  };
  /** Unlocked toolkit skills — gate the more invasive verbs. */
  skills: Set<string>;
  breachedNodeIds: Set<NodeId>;
  badges: ClonedBadge[];
  disguise?: Disguise;
  items: CarriedItem[];
  /** Which node the player is currently piloting a view through, if any. */
  viewingNodeId?: NodeId;
}

export interface TraceState {
  /** 0..1 live ctOS trace. Hits 1 and the city starts actively hunting you. */
  level: number;
  /** Rises with each traceable action and never falls; drives the ghost score. */
  evidence: number;
  /** True while a security team is actively working an incident. */
  investigating: boolean;
  investigationEndsAt: Instant;
  /** Number of times someone reported an anomaly to a real authority. */
  reports: number;
  lastActionAt: Instant;
}

export type OrderKind = "food" | "parcel" | "work" | "requisition";
export type OrderStatus = "pending" | "in_transit" | "delivered" | "completed" | "cancelled";

/**
 * Orders are the game's main puppetry surface. A food order, a parcel, a
 * maintenance work order and a lab requisition are the same object because the
 * player manipulates them the same way: intercept in flight, change a field,
 * let the world execute it faithfully.
 */
export interface Order {
  id: string;
  kind: OrderKind;
  label: string;
  /** Who or what this is for. */
  forNpcId?: NpcId;
  orgId?: string;
  /** Where it is going. Rewriting this is a hack. */
  destinationPlaceId: PlaceId;
  /** Who is executing it. */
  assigneeNpcId?: NpcId;
  createdAt: Instant;
  dueAt: Instant;
  status: OrderStatus;
  /** Free-form payload — allergens, item names, requisition targets. */
  payload: Record<string, unknown>;
  /** Field names the player has rewritten, kept for the forensic report. */
  tampered: string[];
  /** True when the whole order was fabricated rather than modified. */
  forged: boolean;
}

export interface ScheduledTask {
  id: string;
  at: Instant;
  kind: string;
  data: Record<string, unknown>;
}

export interface GameState {
  seed: string;
  time: Instant;
  city: City;
  npcs: Map<NpcId, Npc>;
  rosters: Map<string, NpcId[]>;
  log: EventLog;
  rng: Rng;
  player: PlayerState;
  trace: TraceState;
  orders: Map<string, Order>;
  /** Time-ordered pending effects; drained each tick. */
  schedule: ScheduledTask[];
  /** Mission runtimes, kept opaque here to avoid a circular import. */
  missions: unknown[];
  /** Monotonic id source for anything created at runtime. */
  counter: number;
}

export function nextId(state: GameState, prefix: string): string {
  return `${prefix}_${++state.counter}`;
}

export function schedule(
  state: GameState,
  at: Instant,
  kind: string,
  data: Record<string, unknown> = {},
): ScheduledTask {
  const task: ScheduledTask = { id: nextId(state, "task"), at, kind, data };
  // Keep the queue sorted so draining is a prefix scan.
  const index = state.schedule.findIndex((t) => t.at > at);
  if (index === -1) state.schedule.push(task);
  else state.schedule.splice(index, 0, task);
  return task;
}

export function cancelScheduled(state: GameState, predicate: (t: ScheduledTask) => boolean): number {
  const before = state.schedule.length;
  state.schedule = state.schedule.filter((t) => !predicate(t));
  return before - state.schedule.length;
}

export function npc(state: GameState, id: NpcId): Npc {
  const found = state.npcs.get(id);
  if (!found) throw new Error(`Unknown npc: ${id}`);
  return found;
}

export function maybeNpc(state: GameState, id: NpcId | undefined): Npc | undefined {
  return id ? state.npcs.get(id) : undefined;
}

export function node(state: GameState, id: NodeId) {
  const found = state.city.nodes.get(id);
  if (!found) throw new Error(`Unknown node: ${id}`);
  return found;
}
