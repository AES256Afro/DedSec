/**
 * The city's reflexes: emergency services, security response, and the ambient
 * order traffic that gives the player something to intercept.
 *
 * The important property here is that none of it is scripted around the player.
 * Ramen gets ordered because someone is hungry at their usual time; the
 * ambulance comes because someone collapsed. You are editing a system that was
 * already running.
 */

import { formatTime, minuteOfDay } from "../core/time.js";
import { reportAnomaly } from "../hack/trace.js";
import { deliver } from "../hack/verbs.js";
import type { Npc } from "../npc/types.js";
import { blockAt } from "../npc/schedule.js";
import { nextId, schedule, type GameState, type Order } from "./state.js";

const LUNCH_WINDOW: [number, number] = [11 * 60 + 30, 13 * 60 + 30];

/* --------------------------------------------------------------- ordering */

/** People with money and a habit order lunch to their desk. */
export function maybePlaceFoodOrders(state: GameState): void {
  const m = minuteOfDay(state.time);
  if (m < LUNCH_WINDOW[0] || m > LUNCH_WINDOW[1]) return;

  for (const person of state.npcs.values()) {
    if (person.condition !== "normal" || !person.workPlaceId || !person.orgId) continue;
    if (person.placeId !== person.workPlaceId) continue;
    // One lunch per person per day, however long the window is open.
    const today = Math.floor(state.time / 1440) * 1440;
    const existing = [...state.orders.values()].some(
      (o) => o.kind === "food" && o.forNpcId === person.id && o.createdAt >= today,
    );
    if (existing) continue;
    // One roll per person per lunch window, weighted by income.
    if (!state.rng.chance(0.004 + person.income / 4_000_000)) continue;

    const eta = state.time + state.rng.int(18, 34);
    const dish = state.rng.pick([
      "spicy tonkotsu ramen",
      "a katsu curry",
      "a bánh mì and iced coffee",
      "a poke bowl",
      "shakshuka and flatbread",
    ]);
    const order: Order = {
      id: nextId(state, "ord"),
      kind: "food",
      label: `${dish} for ${person.name}`,
      forNpcId: person.id,
      destinationPlaceId: person.workPlaceId,
      createdAt: state.time,
      dueAt: eta,
      status: "in_transit",
      payload: { dish, allergens: [] as string[] },
      tampered: [],
      forged: false,
      ...(person.orgId ? { orgId: person.orgId } : {}),
    };
    state.orders.set(order.id, order);
    schedule(state, eta, "order.food_arrives", { orderId: order.id });
    state.log.emit(state.time, {
      channel: "world",
      kind: "order.placed",
      text: `${person.name} orders ${dish} — arriving ${formatTime(eta)}.`,
      subjects: [person.id, order.id],
    });
  }
}

/** Couriers run parcels between organisations all day. */
export function maybeDispatchParcels(state: GameState): void {
  const couriers = [...state.npcs.values()].filter(
    (n) => n.archetypeId === "courier" && n.condition === "normal" && blockAt(n, state.time)?.activity !== "sleep",
  );
  if (couriers.length === 0) return;
  if (!state.rng.chance(0.05)) return;

  const courier = state.rng.pick(couriers);
  const busy = [...state.orders.values()].some(
    (o) => o.kind === "parcel" && o.assigneeNpcId === courier.id && o.status === "in_transit",
  );
  if (busy) return;

  const destinations = [...state.city.graph.places.values()].filter(
    (p) => p.kind === "lobby" || p.kind === "reception" || p.kind === "loading",
  );
  if (destinations.length === 0) return;
  const destination = state.rng.pick(destinations);

  const order: Order = {
    id: nextId(state, "ord"),
    kind: "parcel",
    label: state.rng.pick([
      "a signature-required parcel",
      "a cold-chain box",
      "a stack of legal envelopes",
      "a replacement server rail kit",
    ]),
    destinationPlaceId: destination.id,
    assigneeNpcId: courier.id,
    createdAt: state.time,
    dueAt: state.time + state.rng.int(20, 45),
    status: "in_transit",
    payload: { requiresSignature: true },
    tampered: [],
    forged: false,
  };
  state.orders.set(order.id, order);
  schedule(state, order.dueAt, "order.parcel_arrives", { orderId: order.id });
  deliver(state, courier, {
    label: `is delivering to ${destination.name}`,
    action: { type: "handle_delivery", placeId: destination.id, minutes: 6 },
    priority: 0.6,
    plausibility: 0.95,
    hingesOn: "diligence",
    ttlMinutes: 90,
    suspicionOnRefusal: 0,
    originHackId: "world",
    source: "work",
  });
}

/* -------------------------------------------------------------- emergency */

/** Someone collapsed: bystanders converge, and an ambulance is called. */
export function handleMedicalEmergency(state: GameState, patient: Npc): void {
  const already = state.log.happened("emergency.ambulance_called", patient.id, state.time - 60);
  if (already) return;

  const eta = state.rng.int(7, 14);
  schedule(state, state.time + eta, "emergency.ambulance_arrives", { npcId: patient.id });
  state.log.emit(state.time, {
    channel: "emergency",
    kind: "emergency.ambulance_called",
    text: `Ambulance called for ${patient.name} — ETA ${eta} minutes.`,
    tone: "warn",
    subjects: [patient.id],
  });

  // Everyone nearby stops what they were doing. This is the real payload of a
  // medical event: it is not that one person is down, it is that six people
  // who were watching something else are now watching this.
  const graph = state.city.graph;
  for (const person of state.npcs.values()) {
    if (person.id === patient.id || person.condition !== "normal") continue;
    if (!graph.canSee(person.placeId, patient.placeId, 120)) continue;
    const responder = person.archetypeId === "nurse" || person.archetypeId === "security_chief" || person.archetypeId === "guard";
    deliver(state, person, {
      label: responder ? `is running the incident around ${patient.name}` : `is caught up in the incident around ${patient.name}`,
      action: { type: "goto", placeId: patient.placeId, dwellMinutes: responder ? 25 : 12, thenResume: true },
      priority: 0.9,
      plausibility: 0.97,
      hingesOn: "diligence",
      ttlMinutes: 20,
      suspicionOnRefusal: 0,
      originHackId: "world",
      source: "emergency",
    });
  }
}

/* --------------------------------------------------------------- security */

/**
 * Suspicion propagates by conversation, not by telepathy. A sociable person who
 * saw something odd infects the people standing next to them, and a senior
 * person who becomes suspicious enough escalates it into a real investigation.
 */
export function propagateSuspicion(state: GameState, minutes: number): void {
  const chatty = [...state.npcs.values()].filter((n) => n.suspicion > 0.3 && n.condition === "normal");
  for (const source of chatty) {
    const spread = source.traits.sociability * 0.02 * minutes;
    for (const other of state.npcs.values()) {
      if (other.id === source.id) continue;
      if (other.placeId !== source.placeId) continue;
      // Doubt only flows downhill — you cannot make someone more suspicious
      // than the person telling them about it.
      if (other.suspicion >= source.suspicion) continue;
      const before = other.suspicion;
      other.suspicion = Math.min(source.suspicion, other.suspicion + spread);
      if (before < 0.3 && other.suspicion >= 0.3) {
        state.log.emit(state.time, {
          channel: "social",
          kind: "social.gossip",
          text: `${source.name} tells ${other.name} something felt off.`,
          subjects: [source.id, other.id],
        });
      }
    }

    // Escalation: authority plus conviction becomes a filed report.
    const authority = source.archetypeId === "security_chief" ? 1 : source.archetypeId === "guard" ? 0.7 : 0.35;
    if (source.suspicion > 0.75 && state.rng.chance(0.02 * minutes * authority)) {
      reportAnomaly(state, source.name, "inconsistencies with device activity and staff movements", source.suspicion * authority);
      source.suspicion = 0.5;
    }
  }
}

/** An active investigation makes the building physically harder to work in. */
export function applyInvestigationPressure(state: GameState, minutes: number): void {
  if (!state.trace.investigating) return;
  for (const person of state.npcs.values()) {
    if (person.archetypeId !== "guard" && person.archetypeId !== "security_chief") continue;
    person.suspicion = Math.min(1, person.suspicion + 0.004 * minutes);
  }
  // Compromised nodes get audited off the network one at a time.
  if (state.rng.chance(0.02 * minutes)) {
    const breached = [...state.player.breachedNodeIds];
    if (breached.length > 0) {
      const id = state.rng.pick(breached);
      const node = state.city.nodes.get(id);
      if (node) {
        node.breached = false;
        state.player.breachedNodeIds.delete(id);
        if (state.player.viewingNodeId === id) state.player.viewingNodeId = undefined;
        state.log.emit(state.time, {
          channel: "security",
          kind: "security.node_recovered",
          text: `${node.label} re-keyed by the security team. Access lost.`,
          tone: "bad",
          subjects: [node.id],
        });
      }
    }
  }
}

/**
 * People notice when the person who should be at the desk is not.
 *
 * Being *on the way* to your post does not count — running late is normal and
 * nobody files a report over it. What raises eyebrows is someone who is not
 * there and is not coming back, which is exactly the state a good manipulation
 * puts them in.
 */
export function noticeAbandonedPosts(state: GameState, minutes: number): void {
  for (const person of state.npcs.values()) {
    const block = blockAt(person, state.time);
    if (!block?.post) continue;
    if (person.placeId === block.placeId) continue;
    if (person.destinationId === block.placeId) continue;
    if (person.condition === "hospitalised" || person.condition === "incapacitated") continue;

    // Colleagues in the same building start wondering.
    const buildingId = state.city.graph.places.get(block.placeId)?.buildingId;
    if (!buildingId) continue;
    for (const other of state.npcs.values()) {
      if (other.id === person.id) continue;
      if (state.city.graph.places.get(other.placeId)?.buildingId !== buildingId) continue;
      if (other.archetypeId !== "guard" && other.archetypeId !== "security_chief" && other.archetypeId !== "manager") continue;
      other.suspicion = Math.min(1, other.suspicion + 0.0025 * minutes);
    }
  }
}
