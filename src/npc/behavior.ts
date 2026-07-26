/**
 * NPC behaviour: the arbitration between what someone was going to do and what
 * you are trying to make them do.
 *
 * The interesting part is `adjudicate`. An impulse is not a command — it is a
 * *claim about the world* delivered through a channel the target trusts to some
 * degree. They weigh it against the trait it targets, against whether it is
 * plausible at this hour, and against how much abandoning their current task
 * costs them. Three outcomes:
 *
 *   accept  — they act, and you get your window;
 *   doubt   — they verify first, which costs you time and gives you a chance to
 *             corroborate before they decide;
 *   reject  — they see through it, gain suspicion, and remember your handle.
 *
 * Everything the player does to a person eventually lands here.
 */

import type { EventLog } from "../core/events.js";
import type { Rng } from "../core/rng.js";
import type { Instant } from "../core/time.js";
import { formatTime } from "../core/time.js";
import type { CityGraph } from "../world/graph.js";
import type { Door, Edge, PlaceId } from "../world/types.js";
import { ZONE_RANK } from "../world/types.js";
import { blockAt, minutesLeftInBlock, onPost, scheduledPlace } from "./schedule.js";
import { TRAIT_POLARITY } from "./types.js";
import type { Impulse, ImpulseAction, Npc, NpcId } from "./types.js";

export interface BehaviourContext {
  time: Instant;
  graph: CityGraph;
  log: EventLog;
  rng: Rng;
  npcs: Map<NpcId, Npc>;
  /** Personal devices move with their owner, so the tick needs to reach them. */
  nodes: Map<string, { placeId: PlaceId }>;
}

/** Metres per world-minute; NPCs move a little faster when responding. */
const BASE_SPEED = 70;

/**
 * Can this person open this door, right now, unaided?
 *
 * Badge clearance is the general rule, with one exception that matters: people
 * can always get into and out of their own home. Without it the residential
 * block's own tenants are locked in by its access control, which is both
 * absurd and — as it turned out — a very effective way to make the whole city
 * look like it had abandoned its posts.
 */
export function npcCanPass(
  npc: Npc,
  edge: Edge,
  door: Door | undefined,
  time: Instant,
  graph?: CityGraph,
): boolean {
  if (!door) return true;
  if (door.jammedUntil !== undefined && door.jammedUntil > time) return false;
  if (door.failOpen) return true;
  if (!door.locked) return true;
  if (edge.a === npc.homePlaceId || edge.b === npc.homePlaceId) return true;
  if (graph && livesBeyond(npc, edge, graph)) return true;
  return ZONE_RANK[npc.clearance] >= ZONE_RANK[door.clearance];
}

/** True when this door sits inside the building the person lives in. */
function livesBeyond(npc: Npc, edge: Edge, graph: CityGraph): boolean {
  const home = graph.places.get(npc.homePlaceId);
  if (!home?.buildingId) return false;
  const a = graph.places.get(edge.a);
  const b = graph.places.get(edge.b);
  return a?.buildingId === home.buildingId || b?.buildingId === home.buildingId;
}

export function npcEdgeFilter(npc: Npc, time: Instant, graph?: CityGraph) {
  return (edge: Edge, door: Door | undefined) => npcCanPass(npc, edge, door, time, graph);
}

/* ------------------------------------------------------------ adjudication */

export type Verdict = "accept" | "doubt" | "reject";

export interface AdjudicationResult {
  verdict: Verdict;
  /** 0..1 belief score actually rolled against, exposed for the UI's odds readout. */
  belief: number;
  reason: string;
}

/**
 * Score an impulse against a person. Pure and deterministic given `roll`, so
 * the planner UI can show honest odds before you commit to a play.
 */
export interface ImpulseScore {
  /** 0..1 chance they act on it outright. */
  belief: number;
  /** Signed, player-facing reasons, strongest first. */
  notes: string[];
  /** Terse summary for the event log. */
  reason: string;
}

export function scoreImpulse(npc: Npc, impulse: Impulse, time: Instant): ImpulseScore {
  const trait = npc.traits[impulse.hingesOn];
  const polarity = TRAIT_POLARITY[impulse.hingesOn];
  // A shield trait scales belief down as it rises; a hook trait scales it up.
  const traitFactor = polarity > 0 ? 1 - trait * 0.8 : 0.4 + trait * 0.7;
  let belief = impulse.plausibility * traitFactor;
  const notes: string[] = [];

  const level = trait > 0.66 ? "high" : trait < 0.34 ? "low" : "middling";
  notes.push(
    `${polarity > 0 ? (trait > 0.5 ? "−" : "+") : trait > 0.5 ? "+" : "−"} ${level} ${impulse.hingesOn} (${trait.toFixed(2)})`,
  );

  // Procedure-followers verify things regardless of which trait was targeted.
  belief -= npc.traits.diligence * 0.12;
  if (npc.traits.diligence > 0.7) notes.push("− follows procedure, will check");

  // Abandoning a post is a real cost to them, so the pretext has to be worth it.
  if (onPost(npc, time)) {
    belief -= 0.18;
    notes.push("− on a post they are accountable for");
  }

  // Stress cuts both ways: frayed people are easier to push and quicker to bolt,
  // but they are also already looking over their shoulder.
  belief += npc.stress * 0.15;
  if (npc.stress > 0.5) notes.push("+ already frayed");
  belief -= npc.suspicion * 0.45;
  if (npc.suspicion > 0.4) notes.push("− already suspicious of someone");

  // Tech-literate targets discount anything arriving through a device.
  if (impulse.source === "player") {
    belief -= npc.traits.techLiteracy * 0.1;
    if (npc.traits.techLiteracy > 0.7) notes.push("− spots tampered devices");
  }

  belief = Math.max(0.02, Math.min(0.97, belief));
  return { belief, notes, reason: notes.join("; ") };
}

/**
 * How far past the belief threshold a roll can land and still be hesitation
 * rather than outright disbelief. Exported so the pre-commit odds readout and
 * the live roll cannot drift apart.
 */
export const DOUBT_BAND = 0.22;

export function adjudicate(npc: Npc, impulse: Impulse, time: Instant, rng: Rng): AdjudicationResult {
  const { belief, reason } = scoreImpulse(npc, impulse, time);
  const roll = rng.next();
  if (roll < belief) return { verdict: "accept", belief, reason };
  // A near miss is hesitation rather than disbelief — they go and check.
  if (roll < belief + DOUBT_BAND) return { verdict: "doubt", belief, reason };
  return { verdict: "reject", belief, reason };
}

/* ---------------------------------------------------------------- impulses */

export function queueImpulse(npc: Npc, impulse: Impulse): void {
  npc.impulses.push(impulse);
  npc.impulses.sort((a, b) => b.priority - a.priority);
}

function actionDestination(action: ImpulseAction, npc: Npc): PlaceId | undefined {
  switch (action.type) {
    case "goto":
      return action.placeId;
    case "investigate":
      return action.placeId;
    case "handle_delivery":
      return action.placeId;
    case "fixate":
      return action.atPlaceId ?? npc.placeId;
    default:
      return undefined;
  }
}

function actionMinutes(action: ImpulseAction): number {
  switch (action.type) {
    case "goto":
      return action.dwellMinutes;
    case "fixate":
      return action.minutes;
    case "take_call":
      return action.minutes;
    case "investigate":
      return action.minutes;
    case "leave_site":
      return action.minutes;
    case "handle_delivery":
      return action.minutes;
    case "medical_episode":
      return 12 + action.severity * 20;
    case "confront":
      return 14;
  }
}

/** Apply an accepted impulse: set the destination, condition and timers. */
function commit(npc: Npc, impulse: Impulse, ctx: BehaviourContext): void {
  npc.activeImpulse = impulse;
  npc.activity = "responding";
  npc.resumePlaceId = npc.resumePlaceId ?? scheduledPlace(npc, ctx.time);

  const action = impulse.action;
  const dest = actionDestination(action, npc);
  if (dest) npc.destinationId = dest;

  switch (action.type) {
    case "medical_episode":
      npc.condition = "incapacitated";
      npc.busyUntil = ctx.time + actionMinutes(action);
      npc.destinationId = undefined;
      ctx.log.emit(ctx.time, {
        channel: "emergency",
        kind: "npc.medical_episode",
        text: `${npc.name} collapses at ${ctx.graph.place(npc.placeId).name}.`,
        tone: "bad",
        subjects: [npc.id, npc.placeId],
      });
      break;
    case "leave_site":
      npc.condition = "off_site";
      npc.busyUntil = ctx.time + actionMinutes(action);
      npc.destinationId = npc.homePlaceId;
      break;
    case "take_call":
    case "fixate":
      npc.condition = "distracted";
      npc.busyUntil = ctx.time + actionMinutes(action);
      break;
    case "confront": {
      const target = ctx.npcs.get(action.targetId);
      npc.destinationId = target?.placeId ?? npc.placeId;
      npc.busyUntil = ctx.time + actionMinutes(action);
      npc.stress = Math.min(1, npc.stress + 0.3);
      break;
    }
    default:
      npc.busyUntil = ctx.time + actionMinutes(action);
      break;
  }

  // Standing still and staring at something is a lapse, not a dereliction —
  // only an impulse that actually takes them somewhere else abandons the post.
  const goesElsewhere = (dest !== undefined && dest !== npc.placeId) || action.type === "leave_site";
  const leftPost = onPost(npc, ctx.time) && goesElsewhere;
  ctx.log.emit(ctx.time, {
    channel: "social",
    kind: leftPost ? "npc.left_post" : "npc.impulse_accepted",
    text: leftPost
      ? `${npc.name} leaves their post — ${impulse.label}.`
      : `${npc.name}: ${impulse.label}.`,
    tone: impulse.source === "player" ? "good" : "info",
    subjects: [npc.id],
    data: { impulseId: impulse.id, originHackId: impulse.originHackId },
  });
}

function refuse(npc: Npc, impulse: Impulse, result: AdjudicationResult, ctx: BehaviourContext): void {
  npc.suspicion = Math.min(1, npc.suspicion + impulse.suspicionOnRefusal);
  npc.memory.push({
    at: ctx.time,
    kind: "suspicious_contact",
    text: `Did not believe: ${impulse.label}`,
    weight: impulse.suspicionOnRefusal,
  });
  ctx.log.emit(ctx.time, {
    channel: "social",
    kind: "npc.impulse_rejected",
    text: `${npc.name} does not buy it — ${result.reason}.`,
    tone: "bad",
    subjects: [npc.id],
    traceable: impulse.source === "player",
    data: { impulseId: impulse.id, belief: result.belief, originHackId: impulse.originHackId },
  });
}

/**
 * Doubt: they stop what they are doing and spend a few minutes checking. If a
 * corroborating impulse arrives during that window it tips them over; otherwise
 * they roll again at a penalty.
 */
function hesitate(npc: Npc, impulse: Impulse, ctx: BehaviourContext): void {
  const verifyMinutes = 2 + Math.round(npc.traits.diligence * 6);
  impulse.plausibility = Math.max(0.05, impulse.plausibility - 0.12);
  impulse.expiresAt = Math.max(impulse.expiresAt, ctx.time + verifyMinutes + 1);
  npc.condition = "distracted";
  npc.busyUntil = ctx.time + verifyMinutes;
  ctx.log.emit(ctx.time, {
    channel: "social",
    kind: "npc.impulse_doubted",
    text: `${npc.name} pauses to check — ${impulse.label}.`,
    tone: "warn",
    subjects: [npc.id],
    data: { impulseId: impulse.id, originHackId: impulse.originHackId },
  });
}

/* ----------------------------------------------------------------- movement */

function stepMovement(npc: Npc, ctx: BehaviourContext, minutes: number): void {
  const target = npc.destinationId;
  if (!target || target === npc.placeId) {
    npc.destinationId = undefined;
    npc.transit = undefined;
    return;
  }

  const speedFactor = npc.activity === "responding" ? 1.35 : 1;

  if (!npc.transit) {
    const path = ctx.graph.findPath(npc.placeId, target, npcEdgeFilter(npc, ctx.time, ctx.graph));
    const first = path?.steps[0];
    if (!first) {
      // No legal route — give up on this destination rather than stall forever.
      npc.destinationId = undefined;
      return;
    }
    npc.transit = { edgeId: first.edgeId, fromPlaceId: first.from, toPlaceId: first.to, t: 0 };
  }

  const edge = ctx.graph.edges.get(npc.transit.edgeId);
  if (!edge) {
    npc.transit = undefined;
    return;
  }
  npc.transit.t += (minutes * speedFactor) / Math.max(0.05, edge.minutes);
  if (npc.transit.t >= 1) {
    npc.placeId = npc.transit.toPlaceId;
    npc.transit = undefined;
    // Devices on their person travel with them; anything they put down or
    // forgot stays where it was, which is the whole point of the phone play.
    for (const nodeId of npc.carrying) {
      const carried = ctx.nodes.get(nodeId);
      if (carried) carried.placeId = npc.placeId;
    }
  }
}

/* --------------------------------------------------------------- main tick */

export function tickNpc(npc: Npc, ctx: BehaviourContext, minutes: number): void {
  // Terminal conditions run themselves out first.
  if (npc.condition === "hospitalised" || npc.condition === "confined" || npc.condition === "off_site") {
    if (ctx.time >= npc.busyUntil) {
      const previous = npc.condition;
      npc.condition = "normal";
      npc.activeImpulse = undefined;
      npc.destinationId = npc.resumePlaceId ?? scheduledPlace(npc, ctx.time);
      npc.resumePlaceId = undefined;
      ctx.log.emit(ctx.time, {
        channel: "npc",
        kind: "npc.recovered",
        text:
          previous === "hospitalised"
            ? `${npc.name} is discharged and heading back.`
            : previous === "confined"
              ? `${npc.name} gets the door open and walks out.`
              : `${npc.name} returns to the area.`,
        subjects: [npc.id],
      });
    } else {
      stepMovement(npc, ctx, minutes);
      return;
    }
  }

  if (npc.condition === "incapacitated") {
    // Held until an ambulance or a bystander resolves it; dispatch handles that.
    return;
  }

  // Expire stale impulses.
  npc.impulses = npc.impulses.filter((i) => i.expiresAt > ctx.time);

  // Adjudicate the strongest pending impulse when they are free to consider it.
  if (npc.impulses.length > 0 && ctx.time >= npc.busyUntil) {
    const impulse = npc.impulses.shift()!;
    const current = blockAt(npc, ctx.time);
    const activePriority = current?.post ? 0.55 : 0.3;
    if (impulse.priority >= activePriority || !npc.activeImpulse) {
      // Adjudication models *deception detection*. Genuine work handed down by
      // the world, and physical facts like heat or water, have nothing to see
      // through, so they are simply obeyed.
      const deceptive = impulse.source === "player" || impulse.source === "social";
      if (!deceptive) {
        commit(npc, impulse, ctx);
      } else {
        const result = adjudicate(npc, impulse, ctx.time, ctx.rng);
        if (result.verdict === "accept") commit(npc, impulse, ctx);
        else if (result.verdict === "doubt") {
          hesitate(npc, impulse, ctx);
          // Put it back so the post-verification roll happens next time round.
          npc.impulses.unshift(impulse);
        } else refuse(npc, impulse, result, ctx);
      }
    }
  }

  // Finish an active impulse.
  if (npc.activeImpulse && ctx.time >= npc.busyUntil && !npc.transit) {
    const action = npc.activeImpulse.action;
    const arrived = !npc.destinationId || npc.destinationId === npc.placeId;
    if (arrived) {
      const resumes = action.type !== "leave_site";
      // Only report the end of something *you* started. The city finishing its
      // own errands all day is noise that buries the one line that matters.
      if (npc.activeImpulse.source === "player") {
        ctx.log.emit(ctx.time, {
          channel: "npc",
          kind: "npc.impulse_done",
          text: `${npc.name} is done with it and ${resumes ? "heads back" : "stays away"}.`,
          subjects: [npc.id],
        });
      }
      npc.activeImpulse = undefined;
      npc.condition = "normal";
      npc.activity = "idle";
      if (resumes) {
        npc.destinationId = npc.resumePlaceId ?? scheduledPlace(npc, ctx.time);
        npc.resumePlaceId = undefined;
      }
    }
  }

  // Baseline routine when nothing is overriding it.
  if (!npc.activeImpulse && npc.condition === "normal") {
    const block = blockAt(npc, ctx.time);
    const want = block?.placeId ?? npc.homePlaceId;
    npc.activity = block?.activity ?? "idle";
    if (npc.placeId !== want && npc.destinationId !== want) {
      npc.destinationId = want;
    }
    // Patrollers drift between rooms on their floor instead of standing still.
    if (
      block?.activity === "patrol" &&
      npc.placeId === want &&
      !npc.destinationId &&
      ctx.rng.chance(0.06)
    ) {
      const here = ctx.graph.place(npc.placeId);
      const options = ctx.graph
        .edgesFrom(npc.placeId)
        .map((e) => ctx.graph.place(ctx.graph.neighbourOf(e, npc.placeId)))
        .filter((p) => p.buildingId === here.buildingId && ZONE_RANK[p.zone] <= ZONE_RANK[npc.clearance]);
      if (options.length > 0) npc.destinationId = ctx.rng.pick(options).id;
    }
  }

  stepMovement(npc, ctx, minutes);

  // Suspicion and stress bleed off slowly; a rattled person stays rattled for
  // most of a shift, which is what makes a botched play expensive.
  npc.suspicion = Math.max(0, npc.suspicion - 0.0012 * minutes);
  npc.stress = Math.max(0, npc.stress - 0.0008 * minutes);

  if (npc.memory.length > 40) npc.memory.splice(0, npc.memory.length - 40);
}

/** Human-readable one-liner for the world overlay. */
export function describeNpc(npc: Npc, graph: CityGraph, time: Instant): string {
  if (npc.condition === "incapacitated") return "medical emergency";
  if (npc.condition === "hospitalised") return "at hospital";
  if (npc.condition === "confined") return "locked in";
  if (npc.condition === "off_site") return "off site";
  if (npc.activeImpulse) return npc.activeImpulse.label;
  const block = blockAt(npc, time);
  if (npc.transit) return `moving to ${graph.place(npc.transit.toPlaceId).name}`;
  if (block) return `${block.label} · until ${formatTime(time + minutesLeftInBlock(npc, time))}`;
  return "unscheduled";
}

export { BASE_SPEED };
