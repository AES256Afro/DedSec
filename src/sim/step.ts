/**
 * The tick.
 *
 * Order matters and is deliberate:
 *
 *   1. drain the schedule  — timed consequences land before anyone reacts;
 *   2. move people         — routines and impulses resolve;
 *   3. move the player     — including the drone;
 *   4. ambient systems     — orders placed, parcels dispatched;
 *   5. social & security   — suspicion spreads, investigations bite;
 *   6. trace decay;
 *   7. missions            — objectives re-evaluated against the new state.
 *
 * A tick is one world-minute. Sub-minute fractions exist only inside verb
 * costs, which advance `state.time` directly.
 */

import { formatTime } from "../core/time.js";
import { tickTrace } from "../hack/trace.js";
import { deliver } from "../hack/verbs.js";
import { tickNpc, type BehaviourContext } from "../npc/behavior.js";
import type { Npc } from "../npc/types.js";
import {
  applyInvestigationPressure,
  handleMedicalEmergency,
  maybeDispatchParcels,
  maybePlaceFoodOrders,
  noticeAbandonedPosts,
  propagateSuspicion,
} from "./dispatch.js";
import type { GameState, ScheduledTask } from "./state.js";
import { schedule } from "./state.js";

/* ----------------------------------------------------------- scheduled fx */

function runTask(state: GameState, task: ScheduledTask): void {
  switch (task.kind) {
    case "camera.unloop": {
      const node = state.city.nodes.get(String(task.data["nodeId"]));
      if (node) node.state["looped"] = false;
      break;
    }
    case "camera.restore": {
      const node = state.city.nodes.get(String(task.data["nodeId"]));
      if (node) node.state["degraded"] = false;
      break;
    }
    case "fire.reset": {
      const buildingId = String(task.data["buildingId"]);
      for (const door of state.city.graph.doors.values()) {
        const touches = [...state.city.graph.edges.values()]
          .filter((e) => e.doorId === door.id)
          .flatMap((e) => [e.a, e.b]);
        if (touches.some((p) => state.city.graph.places.get(p)?.buildingId === buildingId)) {
          door.failOpen = false;
        }
      }
      state.log.emit(state.time, {
        channel: "security",
        kind: "security.alarm_reset",
        text: "Alarm reset. Doors secured, staff filing back in.",
        subjects: [buildingId],
      });
      break;
    }
    case "order.food_arrives": {
      deliverFoodOrder(state, String(task.data["orderId"]));
      break;
    }
    case "order.parcel_arrives": {
      const order = state.orders.get(String(task.data["orderId"]));
      if (order && order.status === "in_transit") {
        order.status = "delivered";
        const where = state.city.graph.places.get(order.destinationPlaceId)?.name ?? "the door";
        const signer = [...state.npcs.values()].find(
          (n) => n.placeId === order.destinationPlaceId && n.condition === "normal",
        );
        state.log.emit(state.time, {
          channel: "world",
          kind: "order.delivered",
          text: `${order.label} signed for at ${where}${signer ? ` by ${signer.name}` : " — nobody there to sign"}.`,
          subjects: [order.id],
        });
      }
      break;
    }
    case "emergency.ambulance_arrives": {
      const patient = state.npcs.get(String(task.data["npcId"]));
      if (patient && patient.condition === "incapacitated") {
        patient.condition = "hospitalised";
        patient.busyUntil = state.time + state.rng.int(240, 420);
        patient.destinationId = undefined;
        patient.activeImpulse = undefined;
        state.log.emit(state.time, {
          channel: "emergency",
          kind: "emergency.ambulance_arrived",
          text: `${patient.name} is taken out by the paramedics.`,
          tone: "warn",
          subjects: [patient.id],
        });
      }
      break;
    }
    case "requisition.complete": {
      completeRequisition(state, task);
      break;
    }
    case "bot.arrived": {
      const node = state.city.nodes.get(String(task.data["nodeId"]));
      const placeId = String(task.data["placeId"]);
      if (node) {
        node.placeId = placeId;
        node.state["spill"] = true;
        state.log.emit(state.time, {
          channel: "world",
          kind: "world.spill",
          text: `${node.label} has left standing water across ${state.city.graph.places.get(placeId)?.name ?? placeId}.`,
          subjects: [node.id, placeId],
          traceable: true,
        });
      }
      break;
    }
    default:
      break;
  }
}

function deliverFoodOrder(state: GameState, orderId: string): void {
  const order = state.orders.get(orderId);
  if (!order || order.status === "delivered" || order.status === "cancelled") return;
  order.status = "delivered";
  const recipient = order.forNpcId ? state.npcs.get(order.forNpcId) : undefined;
  if (!recipient) return;

  const allergens = (order.payload["allergens"] as string[] | undefined) ?? [];
  const known = recipient.secrets.find((s) => s.kind === "allergy");
  const triggering = allergens.some((a) => known && known.summary.toLowerCase().includes(a.toLowerCase()));

  state.log.emit(state.time, {
    channel: "world",
    kind: "order.delivered",
    text: `${order.label} arrives at ${state.city.graph.places.get(order.destinationPlaceId)?.name ?? "the desk"}.`,
    subjects: [order.id, recipient.id],
  });

  if (!triggering) return;

  // The whole point: the world executes the ticket faithfully and the
  // consequence lands on the person, not on you.
  deliver(state, recipient, {
    label: "is in anaphylaxis",
    action: { type: "medical_episode", severity: 0.8 },
    priority: 1,
    plausibility: 1,
    hingesOn: "diligence",
    ttlMinutes: 3,
    suspicionOnRefusal: 0,
    originHackId: "tamper_food_order",
  });
}

function completeRequisition(state: GameState, task: ScheduledTask): void {
  const item = String(task.data["item"]);
  const toPlaceId = String(task.data["toPlaceId"]);
  const fromNodeId = String(task.data["fromNodeId"]);
  const source = state.city.nodes.get(fromNodeId);

  // The item now physically exists at the drop point as a collectable node.
  const placeName = state.city.graph.places.get(toPlaceId)?.name ?? toPlaceId;
  state.log.emit(state.time, {
    channel: "world",
    kind: "inventory.transferred",
    text: `Transfer complete — ${item} is now in ${placeName}, logged as routine handling.`,
    tone: "good",
    subjects: [toPlaceId, fromNodeId],
  });
  if (source) source.state["lastTransfer"] = { item, toPlaceId, at: state.time };

  // Track it as a loose asset the player can pick up by standing there.
  state.orders.set(`loose_${item}_${toPlaceId}`, {
    id: `loose_${item}_${toPlaceId}`,
    kind: "requisition",
    label: item,
    destinationPlaceId: toPlaceId,
    createdAt: state.time,
    dueAt: state.time,
    status: "completed",
    payload: { collectable: true, item },
    tampered: [],
    forged: true,
  });
}

/* --------------------------------------------------------------- movement */

function stepPlayer(state: GameState, minutes: number): void {
  const player = state.player;
  const graph = state.city.graph;

  if (player.destinationId && player.destinationId !== player.placeId) {
    if (!player.transit) {
      const path = graph.findPath(player.placeId, player.destinationId, (edge, door) =>
        playerCanPass(state, door),
      );
      const first = path?.steps[0];
      if (!first) {
        player.destinationId = undefined;
      } else {
        player.transit = { edgeId: first.edgeId, fromPlaceId: first.from, toPlaceId: first.to, t: 0 };
        player.path = path!.steps.map((s) => s.to);
      }
    }
    if (player.transit) {
      const edge = graph.edges.get(player.transit.edgeId);
      if (edge) {
        player.transit.t += minutes / Math.max(0.05, edge.minutes);
        if (player.transit.t >= 1) {
          player.placeId = player.transit.toPlaceId;
          player.transit = undefined;
          player.path = player.path.filter((p) => p !== player.placeId);
        }
      } else {
        player.transit = undefined;
      }
    }
  } else {
    player.destinationId = undefined;
    player.path = [];
  }

  // Drone: flies over the graph ignoring doors, drains battery while deployed.
  if (player.drone.deployed) {
    player.drone.battery = Math.max(0, player.drone.battery - 0.012 * minutes);
    if (player.drone.destinationId && player.drone.destinationId !== player.drone.placeId) {
      const from = graph.places.get(player.drone.placeId);
      const to = graph.places.get(player.drone.destinationId);
      if (from && to) {
        // Drones cannot get through a sealed building envelope; they route to
        // the nearest place that is either outdoors or already open to the sky.
        const legal = !to.indoor || to.floor === from.floor;
        if (legal) {
          player.drone.placeId = player.drone.destinationId;
        }
        player.drone.destinationId = undefined;
      }
    }
    if (player.drone.battery <= 0) {
      player.drone.deployed = false;
      player.drone.placeId = player.placeId;
      state.log.emit(state.time, {
        channel: "hack",
        kind: "drone.recalled",
        text: "Drone battery flat — auto-returned.",
        tone: "warn",
        subjects: [],
      });
    }
  } else {
    player.drone.battery = Math.min(1, player.drone.battery + 0.02 * minutes);
    player.drone.placeId = player.placeId;
  }

  // Expired badges fall off the ring.
  const before = player.badges.length;
  player.badges = player.badges.filter((b) => b.expiresAt > state.time);
  if (player.badges.length < before) {
    state.log.emit(state.time, {
      channel: "hack",
      kind: "badge.expired",
      text: "A cloned badge stopped working.",
      tone: "warn",
      subjects: [],
    });
  }
  if (player.disguise && player.disguise.expiresAt <= state.time) {
    player.disguise = undefined;
  }
}

/** Door rules for the player: cloned badges, fail-open, and jams. */
export function playerCanPass(state: GameState, door: { locked: boolean; failOpen: boolean; jammedUntil?: number; clearance: string; lock: string; nodeId?: string } | undefined): boolean {
  if (!door) return true;
  if (door.jammedUntil !== undefined && door.jammedUntil > state.time) return false;
  if (door.failOpen) return true;
  if (!door.locked) return true;
  if (door.lock === "mechanical") return false;
  // Any live badge at the right clearance opens it.
  return state.player.badges.some(
    (b) =>
      b.expiresAt > state.time &&
      (door.clearance === "restricted" ? b.clearance === "restricted" : true),
  );
}

/**
 * Anything a requisition dropped somewhere reachable is picked up simply by
 * standing there. No lockpicking minigame — the building already decided this
 * item was allowed to be in this room.
 */
function collectLooseItems(state: GameState): void {
  for (const order of state.orders.values()) {
    if (order.kind !== "requisition" || order.payload["collectable"] !== true) continue;
    if (order.destinationPlaceId !== state.player.placeId) continue;
    order.payload["collectable"] = false;
    state.player.items.push({ id: order.id, label: order.label });
    state.log.emit(state.time, {
      channel: "mission",
      kind: "item.collected",
      text: `Collected ${order.label}.`,
      tone: "good",
      subjects: [order.id],
    });
  }
}

/* -------------------------------------------------------------- main step */

export type MissionTicker = (state: GameState) => void;

let missionTicker: MissionTicker | undefined;

/** Registered by the mission runtime to avoid a circular import. */
export function setMissionTicker(fn: MissionTicker): void {
  missionTicker = fn;
}

export function step(state: GameState, minutes = 1): void {
  state.time += minutes;

  // 1. Timed consequences.
  while (state.schedule.length > 0 && state.schedule[0]!.at <= state.time) {
    const task = state.schedule.shift()!;
    runTask(state, task);
  }

  // 2. People.
  const ctx: BehaviourContext = {
    time: state.time,
    graph: state.city.graph,
    log: state.log,
    rng: state.rng,
    npcs: state.npcs,
    nodes: state.city.nodes,
  };
  const collapsing: Npc[] = [];
  for (const person of state.npcs.values()) {
    const before = person.condition;
    tickNpc(person, ctx, minutes);
    if (person.condition === "incapacitated" && before !== "incapacitated") collapsing.push(person);
  }
  for (const patient of collapsing) handleMedicalEmergency(state, patient);

  // 3. Player.
  stepPlayer(state, minutes);
  collectLooseItems(state);

  // 4. Ambient city traffic.
  maybePlaceFoodOrders(state);
  maybeDispatchParcels(state);

  // 5. Social and security pressure.
  propagateSuspicion(state, minutes);
  noticeAbandonedPosts(state, minutes);
  applyInvestigationPressure(state, minutes);

  // 6. Trace.
  tickTrace(state, minutes);

  // 7. Missions.
  missionTicker?.(state);
}

/** Advance a whole number of world-minutes, one tick at a time. */
export function advance(state: GameState, minutes: number): void {
  for (let i = 0; i < minutes; i++) step(state, 1);
}

export function timeLabel(state: GameState): string {
  return formatTime(state.time);
}

export { schedule };
