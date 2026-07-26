/**
 * The Subverter's Toolkit — every action the player has.
 *
 * A verb is data: what it can point at, what it costs in trace, what the world
 * must look like for it to be offered, and what it does. The UI never hardcodes
 * a single one of them; it asks this registry what is possible against the
 * current selection and renders the answer. Adding a verb adds gameplay
 * everywhere at once.
 *
 * Three families:
 *
 *   · plumbing (breach, dump, clone) — turns proximity into information;
 *   · pressure (noise, bait, forged comms) — turns information into movement;
 *   · puppetry (orders, requisitions, locks) — makes the building do the work,
 *     so the logs show a valid user doing a normal thing.
 *
 * Verbs marked `leverageOnly` never appear until a secret has surfaced that
 * unlocks them. That is the core loop expressed as a data flag.
 */

import { formatTime, minuteOfDay } from "../core/time.js";
import { DOUBT_BAND, queueImpulse, scoreImpulse } from "../npc/behavior.js";
import type { Impulse, ImpulseAction, ImpulseSource, Npc, TraitKey } from "../npc/types.js";
import { blockAt } from "../npc/schedule.js";
import { nextId, schedule, type GameState } from "../sim/state.js";
import type { NetworkNode, NodeCapability, NodeKind, PlaceId } from "../world/types.js";
import { ZONE_RANK } from "../world/types.js";
import { SCAN_RANGE, computeReach } from "./access.js";
import { addEvidence, addTrace, raiseSubnetAnomaly } from "./trace.js";

export type VerbCategory = "recon" | "access" | "distraction" | "social" | "puppetry" | "environment";

export interface VerbContext {
  state: GameState;
  /** The node the verb is pointed at, when it targets a node. */
  node?: NetworkNode;
  /** The person the verb is pointed at, when it targets a person. */
  target?: Npc;
  /** Merged from the leverage hook that unlocked this verb, plus UI input. */
  params: Record<string, unknown>;
}

export interface VerbAvailability {
  ok: boolean;
  reason?: string;
}

export interface VerbOutcome {
  ok: boolean;
  message: string;
  /** Odds shown to the player before committing, when a person is involved. */
  belief?: number;
}

/**
 * What a fallible play would score if fired right now.
 *
 * Manipulation should be a read of a person, not a coin flip you only
 * understand afterwards. Verbs that can be disbelieved implement `forecast` so
 * the UI can show honest odds and the reasoning behind them *before* the player
 * spends the attempt — and spends the suspicion that a failure costs.
 */
export interface VerbForecast {
  /** 0..1 chance they act on it outright. */
  belief: number;
  /** Roughly this much again ends in hesitation rather than outright refusal. */
  doubtBand: number;
  hingesOn: TraitKey;
  /** Signed, player-facing reasons. */
  notes: string[];
  /** Suspicion this adds to the target if they see through it. */
  suspicionOnRefusal: number;
}

export interface HackVerb {
  id: string;
  label: string;
  category: VerbCategory;
  /** One line, written the way the player should think about it. */
  blurb: string;
  targets: "node" | "npc" | "self";
  requiresCapability?: NodeCapability;
  requiresNodeKinds?: NodeKind[];
  /** Node must already be breached to use this verb. */
  requiresBreach: boolean;
  /** Only offered when a revealed secret has unlocked it. */
  leverageOnly?: boolean;
  requiresSkill?: string;
  trace: number;
  /** Permanent forensic residue, independent of live trace. */
  evidence: number;
  minutes: number;
  available?(ctx: VerbContext): VerbAvailability;
  /** Implemented by verbs the target is allowed to disbelieve. */
  forecast?(ctx: VerbContext): VerbForecast | undefined;
  run(ctx: VerbContext): VerbOutcome;
}

/**
 * Score a pretext against a person without touching the world. Shares
 * `scoreImpulse` with the live path, so what the player is shown is exactly
 * what will be rolled against.
 */
export function forecastBelief(
  state: GameState,
  target: Npc,
  spec: { plausibility: number; hingesOn: TraitKey; suspicionOnRefusal: number },
  plausibilityNotes: string[] = [],
): VerbForecast {
  const probe: Impulse = {
    id: "forecast",
    source: "player",
    label: "",
    priority: 0.5,
    action: { type: "fixate", minutes: 1 },
    plausibility: spec.plausibility,
    hingesOn: spec.hingesOn,
    createdAt: state.time,
    expiresAt: state.time,
    suspicionOnRefusal: spec.suspicionOnRefusal,
  };
  const score = scoreImpulse(target, probe, state.time);
  return {
    belief: score.belief,
    doubtBand: DOUBT_BAND,
    hingesOn: spec.hingesOn,
    notes: [...plausibilityNotes, ...score.notes],
    suspicionOnRefusal: spec.suspicionOnRefusal,
  };
}

/* ------------------------------------------------------------------ helpers */

function ok(message: string, belief?: number): VerbOutcome {
  return belief === undefined ? { ok: true, message } : { ok: true, message, belief };
}
function fail(message: string): VerbOutcome {
  return { ok: false, message };
}

function placeName(state: GameState, id: PlaceId): string {
  return state.city.graph.places.get(id)?.name ?? id;
}

/** Everyone currently standing in a place. */
export function occupantsOf(state: GameState, placeId: PlaceId): Npc[] {
  return [...state.npcs.values()].filter((n) => n.placeId === placeId && n.condition !== "hospitalised");
}

/** Everyone within `metres` of a place, on the same floor. */
export function npcsNear(state: GameState, placeId: PlaceId, metres: number): Npc[] {
  const origin = state.city.graph.places.get(placeId);
  if (!origin) return [];
  return [...state.npcs.values()].filter((n) => {
    const p = state.city.graph.places.get(n.placeId);
    if (!p || p.floor !== origin.floor) return false;
    return Math.hypot(p.x - origin.x, p.y - origin.y) <= metres;
  });
}

/**
 * Context sensitivity for forged claims. The same message is convincing at
 * noon and absurd at four in the morning; a claim about someone's actual
 * hobby lands far harder than a generic one.
 */
export interface PlausibilityOptions {
  /** Interest the pretext leans on; matching one of theirs is a big boost. */
  interest?: string;
  /** Impersonated contact — their trust rating modulates belief. */
  asNpcId?: string;
  /** Hours the claim makes sense in; outside them it reads as wrong. */
  sensibleHours?: [number, number];
}

/**
 * Plausibility with its reasoning attached.
 *
 * The player is entitled to know *why* a pretext is weak before they spend it —
 * "you are telling a night-shift bartender their bank opens in ten minutes" is
 * a decision they should get to make, not a surprise they get to eat.
 */
export function explainPlausibility(
  state: GameState,
  target: Npc,
  base: number,
  opts: PlausibilityOptions = {},
): { value: number; notes: string[] } {
  let p = base;
  const notes: string[] = [];
  const hour = minuteOfDay(state.time) / 60;

  if (opts.interest) {
    const matches = target.interests.some((i) => i.toLowerCase().includes(opts.interest!.toLowerCase()));
    p += matches ? 0.25 : -0.15;
    notes.push(matches ? `+ leans on something they actually care about` : `− not one of their interests`);
  }

  if (opts.asNpcId) {
    const rel = target.relationships.find((r) => r.otherId === opts.asNpcId);
    const other = state.npcs.get(opts.asNpcId);
    if (rel) {
      p += (rel.trust - 0.5) * 0.5;
      notes.push(
        `${rel.trust >= 0.5 ? "+" : "−"} ${rel.kind.replace(/_/g, " ")} they trust ${(rel.trust * 100).toFixed(0)}%`,
      );
    } else {
      p -= 0.3;
      notes.push(`− ${other?.name ?? "that contact"} is a stranger to them`);
    }
  }

  if (opts.sensibleHours) {
    const [from, to] = opts.sensibleHours;
    const inWindow = from <= to ? hour >= from && hour < to : hour >= from || hour < to;
    if (!inWindow) {
      p -= 0.3;
      notes.push(`− wrong time of day for this claim`);
    }
  }

  if (target.condition === "normal" && blockAt(target, state.time)?.activity === "sleep") {
    p -= 0.2;
    notes.push(`− they are asleep`);
  }

  return { value: Math.max(0.03, Math.min(0.95, p)), notes };
}

export function contextualPlausibility(
  state: GameState,
  target: Npc,
  base: number,
  opts: PlausibilityOptions = {},
): number {
  return explainPlausibility(state, target, base, opts).value;
}

export interface DeliverOptions {
  label: string;
  action: ImpulseAction;
  priority: number;
  plausibility: number;
  hingesOn: TraitKey;
  ttlMinutes: number;
  suspicionOnRefusal: number;
  originHackId: string;
  /**
   * Defaults to "player". The ambient city uses this same pipe to hand out
   * genuine work, and those must not be scored as though someone were being
   * phished — a courier does not get sceptical about a real delivery.
   */
  source?: ImpulseSource;
}

/** Queue a manipulation against a person and return the impulse for reporting. */
export function deliver(state: GameState, target: Npc, opts: DeliverOptions): Impulse {
  const impulse: Impulse = {
    id: nextId(state, "imp"),
    source: opts.source ?? "player",
    label: opts.label,
    priority: opts.priority,
    action: opts.action,
    plausibility: opts.plausibility,
    hingesOn: opts.hingesOn,
    createdAt: state.time,
    expiresAt: state.time + opts.ttlMinutes,
    suspicionOnRefusal: opts.suspicionOnRefusal,
    originHackId: opts.originHackId,
  };
  queueImpulse(target, impulse);
  return impulse;
}

/** Pull the leverage param a hook attached, falling back to a default. */
function param<T>(ctx: VerbContext, key: string, fallback: T): T {
  const value = ctx.params[key];
  return (value === undefined ? fallback : value) as T;
}

/* -------------------------------------------------------- verb definitions */

const RECON: HackVerb[] = [
  {
    id: "scan_area",
    label: "Sweep profiles",
    category: "recon",
    blurb: "Run a passive ctOS profile on everyone you can currently see.",
    targets: "self",
    requiresBreach: false,
    trace: 0.01,
    evidence: 0,
    minutes: 0.5,
    run({ state }) {
      const graph = state.city.graph;
      const origin = state.player.drone.deployed ? state.player.drone.placeId : state.player.placeId;
      let count = 0;
      for (const person of state.npcs.values()) {
        if (!graph.canSee(origin, person.placeId, SCAN_RANGE)) continue;
        if (!person.revealedFields.has("identity")) {
          person.revealedFields.add("identity");
          count++;
        }
      }
      return count > 0
        ? ok(`Profiled ${count} ${count === 1 ? "person" : "people"} in view.`)
        : fail("Nobody new in line of sight.");
    },
  },
  {
    id: "watch_through",
    label: "Pilot camera",
    category: "recon",
    blurb: "See through this camera. Profiles anyone in its cone, from anywhere.",
    targets: "node",
    requiresNodeKinds: ["camera", "cleaning_bot", "phone"],
    requiresCapability: "observe",
    requiresBreach: true,
    trace: 0.01,
    evidence: 0.05,
    minutes: 0.2,
    run({ state, node }) {
      if (!node) return fail("No node selected.");
      state.player.viewingNodeId = node.id;
      const covered = new Set([node.placeId, ...(state.city.graph.places.get(node.placeId)?.sightlines ?? [])]);
      let count = 0;
      for (const person of state.npcs.values()) {
        if (!covered.has(person.placeId)) continue;
        if (!person.revealedFields.has("identity")) {
          person.revealedFields.add("identity");
          count++;
        }
      }
      return ok(`Viewing ${node.label}. ${count} new profile${count === 1 ? "" : "s"}.`);
    },
  },
  {
    id: "dump_device",
    label: "Dump device",
    category: "recon",
    blurb: "Pull messages, contacts, calendar and app data off a breached device.",
    targets: "node",
    requiresCapability: "records",
    requiresBreach: true,
    trace: 0.03,
    evidence: 0.3,
    minutes: 1.5,
    run({ state, node }) {
      if (!node) return fail("No node selected.");
      const owner = node.ownerId ? state.npcs.get(node.ownerId) : undefined;
      if (!owner) {
        // Org-owned records: still useful — they are a second source for staff.
        return ok(`Pulled ${node.label} record store. Cross-reference against a handset to deepen a profile.`);
      }
      owner.revealedFields.add("identity");
      owner.revealedFields.add("device_dump");
      return ok(`Dumped ${owner.name}'s ${node.kind}. Profile depth recalculated.`);
    },
  },
  {
    id: "clone_badge",
    label: "Clone badge",
    category: "access",
    blurb: "Copy the owner's building credential onto your handset.",
    targets: "node",
    requiresCapability: "credentials",
    requiresBreach: true,
    trace: 0.06,
    evidence: 0.6,
    minutes: 2,
    available({ state, node }) {
      const owner = node?.ownerId ? state.npcs.get(node.ownerId) : undefined;
      if (!owner) return { ok: false, reason: "No personal credential on this device." };
      if (!owner.orgId) return { ok: false, reason: `${owner.name} has no building credential.` };
      return { ok: true };
    },
    run({ state, node }) {
      const owner = node?.ownerId ? state.npcs.get(node.ownerId) : undefined;
      if (!owner?.orgId) return fail("No credential to clone.");
      state.player.badges.push({
        npcId: owner.id,
        npcName: owner.name,
        orgId: owner.orgId,
        clearance: owner.clearance,
        expiresAt: state.time + 240,
      });
      return ok(`Cloned ${owner.name}'s badge — ${owner.clearance} clearance, valid ~4h.`);
    },
  },
  {
    id: "harvest_credentials",
    label: "Harvest logins",
    category: "access",
    blurb: "Lift stored passwords. Reused ones open their workplace systems too.",
    targets: "node",
    requiresCapability: "credentials",
    requiresBreach: true,
    trace: 0.05,
    evidence: 0.5,
    minutes: 2,
    run({ state, node }) {
      const owner = node?.ownerId ? state.npcs.get(node.ownerId) : undefined;
      if (!owner) return fail("No account context on this device.");
      const granted = owner.accounts.filter((a) => a.grantsNodeId);
      for (const account of granted) {
        if (!account.grantsNodeId) continue;
        state.player.breachedNodeIds.add(account.grantsNodeId);
      }
      owner.revealedFields.add("credentials");
      return granted.length > 0
        ? ok(`Lifted ${owner.name}'s SSO. ${granted.length} workplace system${granted.length === 1 ? "" : "s"} now open.`)
        : ok(`Lifted ${owner.name}'s personal logins. No workplace SSO stored here.`);
    },
  },
  {
    id: "loop_camera",
    label: "Loop feed",
    category: "access",
    blurb: "Replay the last quiet minute to whoever is watching.",
    targets: "node",
    requiresNodeKinds: ["camera"],
    requiresBreach: true,
    trace: 0.04,
    evidence: 0.4,
    minutes: 0.5,
    run({ state, node }) {
      if (!node) return fail("No node selected.");
      node.state["looped"] = true;
      node.busyUntil = state.time + 20;
      schedule(state, state.time + 20, "camera.unloop", { nodeId: node.id });
      return ok(`${node.label} looping for 20 minutes.`);
    },
  },
];

const DISTRACTION: HackVerb[] = [
  {
    id: "mass_horn",
    label: "Mass horn cascade",
    category: "distraction",
    blurb: "Every scooter and car alarm on the street at once. Pulls the block outside.",
    targets: "node",
    requiresNodeKinds: ["scooter", "car_alarm"],
    requiresBreach: true,
    trace: 0.12,
    evidence: 0.35,
    minutes: 0.5,
    run({ state, node }) {
      if (!node) return fail("No node selected.");
      const street = node.placeId;
      const siblings = [...state.city.nodes.values()].filter(
        (n) => n.placeId === street && (n.kind === "scooter" || n.kind === "car_alarm"),
      );
      const crowd = npcsNear(state, street, 200);
      let moved = 0;
      for (const person of crowd) {
        if (person.condition !== "normal") continue;
        deliver(state, person, {
          label: "goes to see what the noise is",
          action: { type: "goto", placeId: street, dwellMinutes: 6, thenResume: true },
          priority: 0.5,
          plausibility: 0.8,
          hingesOn: "curiosity",
          ttlMinutes: 8,
          suspicionOnRefusal: 0.02,
          originHackId: "mass_horn",
        });
        moved++;
      }
      state.log.emit(state.time, {
        channel: "world",
        kind: "world.noise",
        text: `${siblings.length} vehicles start sounding at once on ${placeName(state, street)}.`,
        tone: "warn",
        subjects: [street],
        traceable: true,
      });
      return ok(`${siblings.length} vehicles blaring. ${moved} people drawn toward the street.`);
    },
  },
  {
    id: "blast_speaker",
    label: "Blast audio",
    category: "distraction",
    blurb: "Slam a speaker to full volume. Everyone in the room looks at it, not at you.",
    targets: "node",
    requiresCapability: "broadcast",
    requiresBreach: true,
    trace: 0.07,
    evidence: 0.2,
    minutes: 0.3,
    run({ state, node }) {
      if (!node) return fail("No node selected.");
      const here = occupantsOf(state, node.placeId);
      for (const person of here) {
        deliver(state, person, {
          label: `is distracted by ${node.label}`,
          action: { type: "fixate", minutes: 3, atPlaceId: node.placeId },
          priority: 0.45,
          plausibility: 0.9,
          hingesOn: "diligence",
          ttlMinutes: 4,
          suspicionOnRefusal: 0.04,
          originHackId: "blast_speaker",
          source: "stimulus",
        });
      }
      return ok(`${node.label} at full output — ${here.length} occupant${here.length === 1 ? "" : "s"} looking at it.`);
    },
  },
  {
    id: "vending_dispense",
    label: "Dump the vending machine",
    category: "distraction",
    blurb: "Free product, loudly. Reliably empties a break area of anyone curious.",
    targets: "node",
    requiresNodeKinds: ["vending"],
    requiresBreach: true,
    trace: 0.05,
    evidence: 0.15,
    minutes: 0.3,
    run({ state, node }) {
      if (!node) return fail("No node selected.");
      const nearby = npcsNear(state, node.placeId, 60);
      let drawn = 0;
      for (const person of nearby) {
        if (person.condition !== "normal") continue;
        deliver(state, person, {
          label: "wanders over to the vending machine",
          action: { type: "goto", placeId: node.placeId, dwellMinutes: 4, thenResume: true },
          priority: 0.35,
          plausibility: 0.7,
          hingesOn: "curiosity",
          ttlMinutes: 6,
          suspicionOnRefusal: 0.02,
          originHackId: "vending_dispense",
        });
        drawn++;
      }
      return ok(`Machine dumping stock. ${drawn} within earshot.`);
    },
  },
  {
    id: "flicker_lights",
    label: "Flicker lighting",
    category: "environment",
    blurb: "Reads as a fault. Degrades camera reliability in the room and unsettles people.",
    targets: "node",
    requiresNodeKinds: ["light"],
    requiresBreach: true,
    trace: 0.04,
    evidence: 0.1,
    minutes: 0.3,
    run({ state, node }) {
      if (!node) return fail("No node selected.");
      for (const camera of state.city.nodes.values()) {
        if (camera.kind === "camera" && camera.placeId === node.placeId) {
          camera.state["degraded"] = true;
          schedule(state, state.time + 15, "camera.restore", { nodeId: camera.id });
        }
      }
      for (const person of occupantsOf(state, node.placeId)) {
        person.stress = Math.min(1, person.stress + 0.08);
      }
      return ok(`Lighting fault in ${placeName(state, node.placeId)} for 15 minutes.`);
    },
  },
  {
    id: "fake_app_alert",
    label: "Fabricate an app alert",
    category: "social",
    blurb:
      "Push a notification from an app they actually use, about a thing they actually care about. The most precise tool you have.",
    targets: "npc",
    requiresBreach: true,
    trace: 0.05,
    evidence: 0.35,
    minutes: 1,
    available({ state, target }) {
      if (!target) return { ok: false, reason: "No person selected." };
      if (target.profileLayer < 1) return { ok: false, reason: "Need layer 1 — breach their handset first." };
      if (!target.phoneNodeId || !state.player.breachedNodeIds.has(target.phoneNodeId)) {
        return { ok: false, reason: "Their handset is not breached." };
      }
      return { ok: true };
    },
    forecast(ctx) {
      const { state, target } = ctx;
      if (!target) return undefined;
      const interest = param(ctx, "interest", target.interests[0] ?? "their hobby");
      const { value, notes } = explainPlausibility(state, target, 0.62, { interest });
      if (!ctx.params["placeId"]) {
        notes.push("− no destination pinned: they will only stop and stare");
      }
      return forecastBelief(
        state,
        target,
        { plausibility: value, hingesOn: "curiosity", suspicionOnRefusal: 0.18 },
        notes,
      );
    },
    run(ctx) {
      const { state, target } = ctx;
      if (!target) return fail("No person selected.");
      const interest = param(ctx, "interest", target.interests[0] ?? "their hobby");
      const destination = param<PlaceId | undefined>(ctx, "placeId", undefined);
      const plausibility = contextualPlausibility(state, target, 0.62, { interest });
      const action: ImpulseAction = destination
        ? { type: "goto", placeId: destination, dwellMinutes: 20, thenResume: true }
        : { type: "fixate", minutes: 8 };
      deliver(state, target, {
        label: `is chasing an alert about ${interest}`,
        action,
        priority: 0.6,
        plausibility,
        hingesOn: "curiosity",
        ttlMinutes: 25,
        suspicionOnRefusal: 0.18,
        originHackId: "fake_app_alert",
      });
      const belief = forecastBelief(state, target, {
        plausibility,
        hingesOn: "curiosity",
        suspicionOnRefusal: 0.18,
      }).belief;
      return ok(`Alert pushed to ${target.name} about ${interest}.`, belief);
    },
  },
  {
    id: "hijack_display",
    label: "Hijack display",
    category: "distraction",
    blurb: "Put something on a public screen that people will stop and read.",
    targets: "node",
    requiresNodeKinds: ["display"],
    requiresBreach: true,
    trace: 0.09,
    evidence: 0.3,
    minutes: 0.5,
    run({ state, node }) {
      if (!node) return fail("No node selected.");
      const nearby = npcsNear(state, node.placeId, 90);
      for (const person of nearby) {
        deliver(state, person, {
          label: "stops to read the hoarding",
          action: { type: "fixate", minutes: 3, atPlaceId: node.placeId },
          priority: 0.3,
          plausibility: 0.55,
          hingesOn: "curiosity",
          ttlMinutes: 5,
          suspicionOnRefusal: 0.01,
          originHackId: "hijack_display",
        });
      }
      return ok(`${node.label} hijacked — ${nearby.length} in viewing distance.`);
    },
  },
];

/* --------------------------------------------------------- social forgeries */

interface ForgeryDef {
  id: string;
  label: string;
  blurb: string;
  /** Base believability before context. */
  base: number;
  hingesOn: TraitKey;
  priority: number;
  ttlMinutes: number;
  suspicionOnRefusal: number;
  trace: number;
  evidence: number;
  sensibleHours?: [number, number];
  leverageOnly?: boolean;
  /** Builds the impulse label and action from context. */
  build(ctx: VerbContext, target: Npc): { label: string; action: ImpulseAction };
}

function forgery(def: ForgeryDef): HackVerb {
  return {
    id: def.id,
    label: def.label,
    category: "social",
    blurb: def.blurb,
    targets: "npc",
    requiresBreach: true,
    ...(def.leverageOnly ? { leverageOnly: true } : {}),
    trace: def.trace,
    evidence: def.evidence,
    minutes: 1,
    available({ state, target }) {
      if (!target) return { ok: false, reason: "No person selected." };
      if (target.profileLayer < 1) return { ok: false, reason: "Need layer 1 on this person." };
      if (!target.phoneNodeId || !state.player.breachedNodeIds.has(target.phoneNodeId)) {
        return { ok: false, reason: "Their handset is not breached." };
      }
      if (target.condition !== "normal" && target.condition !== "distracted") {
        return { ok: false, reason: `${target.name} is ${target.condition.replace(/_/g, " ")}.` };
      }
      return { ok: true };
    },
    forecast({ state, target, params }) {
      if (!target) return undefined;
      const { value, notes } = explainPlausibility(state, target, def.base, plausibilityOpts(def, params));
      return forecastBelief(
        state,
        target,
        { plausibility: value, hingesOn: def.hingesOn, suspicionOnRefusal: def.suspicionOnRefusal },
        notes,
      );
    },
    run(ctx) {
      const { state, target } = ctx;
      if (!target) return fail("No person selected.");
      const built = def.build(ctx, target);
      const plausibility = contextualPlausibility(state, target, def.base, plausibilityOpts(def, ctx.params));
      deliver(state, target, {
        label: built.label,
        action: built.action,
        priority: def.priority,
        plausibility,
        hingesOn: def.hingesOn,
        ttlMinutes: def.ttlMinutes,
        suspicionOnRefusal: def.suspicionOnRefusal,
        originHackId: def.id,
      });
      const belief = forecastBelief(state, target, {
        plausibility,
        hingesOn: def.hingesOn,
        suspicionOnRefusal: def.suspicionOnRefusal,
      }).belief;
      return ok(`Sent to ${target.name}. They act on it ${(belief * 100).toFixed(0)}% of the time.`, belief);
    },
  };
}

/** Shared so the forecast and the live send can never disagree. */
function plausibilityOpts(def: ForgeryDef, params: Record<string, unknown>): PlausibilityOptions {
  return {
    ...(params["asNpcId"] ? { asNpcId: String(params["asNpcId"]) } : {}),
    ...(params["interest"] ? { interest: String(params["interest"]) } : {}),
    ...(def.sensibleHours ? { sensibleHours: def.sensibleHours } : {}),
  };
}

/** Somewhere far enough away that going there costs them the afternoon. */
function distantPlace(state: GameState, from: PlaceId, preferKind?: string): PlaceId {
  const graph = state.city.graph;
  const candidates = [...graph.places.values()].filter(
    (p) => !p.indoor || p.zone === "public" || p.kind === "shop",
  );
  const scored = candidates
    .map((p) => ({ p, d: graph.distance(from, p.id) + (preferKind && p.kind === preferKind ? 400 : 0) }))
    .sort((a, b) => b.d - a.d);
  return scored[0]?.p.id ?? from;
}

const SOCIAL: HackVerb[] = [
  forgery({
    id: "spoof_call",
    label: "Spoof a call",
    blurb: "Ring them from a contact they trust. They step aside to take it.",
    base: 0.7,
    hingesOn: "techLiteracy",
    priority: 0.55,
    ttlMinutes: 6,
    suspicionOnRefusal: 0.12,
    trace: 0.05,
    evidence: 0.3,
    build(ctx, target) {
      const asId = ctx.params["asNpcId"] as string | undefined;
      const caller = asId ? ctx.state.npcs.get(asId) : undefined;
      return {
        label: `takes a call from ${caller?.name ?? "a trusted contact"}`,
        action: { type: "take_call", minutes: 4, ...(asId ? { fromNpcId: asId } : {}) },
      };
    },
  }),
  forgery({
    id: "forge_message",
    label: "Forge a message",
    blurb: "Write as someone else. Send them somewhere, or send them at someone.",
    base: 0.65,
    hingesOn: "techLiteracy",
    priority: 0.6,
    ttlMinutes: 30,
    suspicionOnRefusal: 0.15,
    trace: 0.06,
    evidence: 0.4,
    build(ctx, target) {
      const asId = ctx.params["asNpcId"] as string | undefined;
      const sender = asId ? ctx.state.npcs.get(asId) : undefined;
      const dest = (ctx.params["placeId"] as PlaceId | undefined) ?? distantPlace(ctx.state, target.placeId);
      return {
        label: `is going to meet ${sender?.name ?? "someone"} at ${placeName(ctx.state, dest)}`,
        action: { type: "goto", placeId: dest, dwellMinutes: 25, thenResume: true },
      };
    },
  }),
  forgery({
    id: "forge_auction_win",
    label: "Forge an auction win",
    blurb: "The winning bidder defaulted. It is theirs if they collect it in person, now.",
    base: 0.72,
    hingesOn: "curiosity",
    priority: 0.75,
    ttlMinutes: 40,
    suspicionOnRefusal: 0.2,
    trace: 0.06,
    evidence: 0.45,
    sensibleHours: [8, 21],
    leverageOnly: true,
    build(ctx, target) {
      const item = String(ctx.params["item"] ?? "the item they lost out on");
      const dest = distantPlace(ctx.state, target.placeId, "shop");
      return {
        label: `has left to collect ${item}`,
        action: { type: "goto", placeId: dest, dwellMinutes: 90, thenResume: true },
      };
    },
  }),
  forgery({
    id: "forge_interview_invite",
    label: "Forge an interview slot",
    blurb: "The second job they are hiding just offered them a slot this afternoon.",
    base: 0.62,
    hingesOn: "vanity",
    priority: 0.8,
    ttlMinutes: 45,
    suspicionOnRefusal: 0.2,
    trace: 0.06,
    evidence: 0.45,
    sensibleHours: [8, 19],
    leverageOnly: true,
    build(ctx, target) {
      return {
        label: "has slipped out for an interview",
        action: { type: "leave_site", minutes: 100 },
      };
    },
  }),
  forgery({
    id: "forge_family_emergency",
    label: "Forge a family emergency",
    blurb: "Cruel, effective, and it empties a post completely. People will remember it.",
    base: 0.8,
    hingesOn: "diligence",
    priority: 0.95,
    ttlMinutes: 20,
    suspicionOnRefusal: 0.3,
    trace: 0.1,
    evidence: 0.8,
    leverageOnly: true,
    build() {
      return { label: "has left over a family emergency", action: { type: "leave_site", minutes: 180 } };
    },
  }),
  forgery({
    id: "forge_creditor_call",
    label: "Spoof a collections call",
    blurb: "Their creditor, on their work number. They will take it somewhere private.",
    base: 0.68,
    hingesOn: "techLiteracy",
    priority: 0.7,
    ttlMinutes: 15,
    suspicionOnRefusal: 0.18,
    trace: 0.06,
    evidence: 0.4,
    sensibleHours: [8, 20],
    leverageOnly: true,
    build() {
      return { label: "steps away to take a call they do not want overheard", action: { type: "take_call", minutes: 9 } };
    },
  }),
  forgery({
    id: "forge_bet_alert",
    label: "Fake a live-bet alert",
    blurb: "Their position is moving. They will not look away from the phone.",
    base: 0.7,
    hingesOn: "greed",
    priority: 0.55,
    ttlMinutes: 20,
    suspicionOnRefusal: 0.12,
    trace: 0.05,
    evidence: 0.3,
    leverageOnly: true,
    build() {
      return { label: "is glued to a live betting screen", action: { type: "fixate", minutes: 14 } };
    },
  }),
  forgery({
    id: "forge_clinic_reminder",
    label: "Forge a clinic callback",
    blurb: "A results callback they will not risk ignoring.",
    base: 0.74,
    hingesOn: "diligence",
    priority: 0.85,
    ttlMinutes: 40,
    suspicionOnRefusal: 0.22,
    trace: 0.07,
    evidence: 0.55,
    sensibleHours: [8, 18],
    leverageOnly: true,
    build(ctx) {
      const clinic = ctx.state.city.roomPlaceIds.get("m0_waiting");
      return {
        label: "has left for a clinic appointment",
        action: clinic
          ? { type: "goto", placeId: clinic, dwellMinutes: 60, thenResume: true }
          : { type: "leave_site", minutes: 90 },
      };
    },
  }),
  forgery({
    id: "forge_summons",
    label: "Forge a summons",
    blurb: "A meeting request from someone they cannot say no to.",
    base: 0.66,
    hingesOn: "gullibility",
    priority: 0.75,
    ttlMinutes: 25,
    suspicionOnRefusal: 0.2,
    trace: 0.06,
    evidence: 0.4,
    sensibleHours: [8, 19],
    leverageOnly: true,
    build(ctx, target) {
      const manager = target.relationships.find((r) => r.kind === "manager");
      const boss = manager ? ctx.state.npcs.get(manager.otherId) : undefined;
      const dest = boss?.workPlaceId ?? distantPlace(ctx.state, target.placeId);
      return {
        label: `has been summoned by ${boss?.name ?? "management"}`,
        action: { type: "goto", placeId: dest, dwellMinutes: 20, thenResume: true },
      };
    },
  }),
  forgery({
    id: "forge_audit_notice",
    label: "Forge an audit notice",
    blurb: "Tell someone with something to hide that the auditors arrive in an hour.",
    base: 0.6,
    hingesOn: "diligence",
    priority: 0.85,
    ttlMinutes: 30,
    suspicionOnRefusal: 0.25,
    trace: 0.09,
    evidence: 0.6,
    sensibleHours: [7, 20],
    leverageOnly: true,
    build() {
      return { label: "is quietly clearing out ahead of an audit", action: { type: "leave_site", minutes: 120 } };
    },
  }),
  forgery({
    id: "forge_pharmacy_alert",
    label: "Fake a pharmacy collection",
    blurb: "Their prescription is ready and the window closes in thirty minutes.",
    base: 0.68,
    hingesOn: "diligence",
    priority: 0.7,
    ttlMinutes: 35,
    suspicionOnRefusal: 0.15,
    trace: 0.05,
    evidence: 0.35,
    sensibleHours: [8, 19],
    leverageOnly: true,
    build(ctx, target) {
      return {
        label: "has gone to collect a prescription",
        action: { type: "goto", placeId: distantPlace(ctx.state, target.placeId, "shop"), dwellMinutes: 45, thenResume: true },
      };
    },
  }),
  forgery({
    id: "dangle_payout",
    label: "Dangle a payout",
    blurb: "Money, now, if they are somewhere else in twenty minutes.",
    base: 0.55,
    hingesOn: "greed",
    priority: 0.7,
    ttlMinutes: 30,
    suspicionOnRefusal: 0.22,
    trace: 0.07,
    evidence: 0.5,
    leverageOnly: true,
    build(ctx, target) {
      return {
        label: "has gone to collect money they were promised",
        action: { type: "goto", placeId: distantPlace(ctx.state, target.placeId), dwellMinutes: 40, thenResume: true },
      };
    },
  }),
  {
    id: "expose_to_partner",
    label: "Route the evidence",
    category: "social",
    blurb: "Forward what you found to the person it will hurt. They will come and find them.",
    targets: "npc",
    requiresBreach: true,
    leverageOnly: true,
    trace: 0.12,
    evidence: 1.1,
    minutes: 1,
    available({ target }) {
      if (!target) return { ok: false, reason: "No person selected." };
      if (target.profileLayer < 2) return { ok: false, reason: "Need layer 2 to have anything worth sending." };
      const partner = target.relationships.find((r) => r.kind === "spouse" || r.kind === "partner");
      if (!partner) return { ok: false, reason: `${target.name} has no partner on file.` };
      return { ok: true };
    },
    run({ state, target }) {
      if (!target) return fail("No person selected.");
      const rel = target.relationships.find((r) => r.kind === "spouse" || r.kind === "partner");
      const partner = rel ? state.npcs.get(rel.otherId) : undefined;
      if (!partner) return fail("No partner on file.");
      deliver(state, partner, {
        label: `is going to confront ${target.name}`,
        action: { type: "confront", targetId: target.id },
        priority: 0.95,
        plausibility: 0.9,
        hingesOn: "diligence",
        ttlMinutes: 60,
        suspicionOnRefusal: 0.1,
        originHackId: "expose_to_partner",
      });
      target.stress = Math.min(1, target.stress + 0.4);
      state.log.emit(state.time, {
        channel: "social",
        kind: "social.exposed",
        text: `${partner.name} has seen it. They are on their way.`,
        tone: "warn",
        subjects: [target.id, partner.id],
        traceable: true,
      });
      return ok(`Sent to ${partner.name}. This will not stay quiet.`);
    },
  },
  {
    id: "blackmail_leverage",
    label: "Apply leverage",
    category: "social",
    blurb: "Tell them you know. They will do one thing for you and hate you for it.",
    targets: "npc",
    requiresBreach: true,
    leverageOnly: true,
    trace: 0.15,
    evidence: 1.4,
    minutes: 2,
    available({ target }) {
      if (!target) return { ok: false, reason: "No person selected." };
      const heavy = target.secrets.filter((s) => s.revealed && s.weight > 0.55);
      if (heavy.length === 0) return { ok: false, reason: "Nothing heavy enough to hold over them." };
      return { ok: true };
    },
    run({ state, target, params }) {
      if (!target) return fail("No person selected.");
      const dest = (params["placeId"] as PlaceId | undefined) ?? distantPlace(state, target.placeId);
      deliver(state, target, {
        label: "does what they are told, and remembers your handle",
        action: { type: "goto", placeId: dest, dwellMinutes: 30, thenResume: true },
        priority: 1,
        plausibility: 0.93,
        hingesOn: "anxiety",
        ttlMinutes: 20,
        suspicionOnRefusal: 0.6,
        originHackId: "blackmail_leverage",
      });
      target.stress = Math.min(1, target.stress + 0.6);
      target.suspicion = Math.min(1, target.suspicion + 0.35);
      return ok(`${target.name} will comply. They now know someone is working them.`);
    },
  },
  {
    id: "plant_bait_file",
    label: "Plant a bait file",
    category: "social",
    blurb:
      'Drop something irresistible on a share — "promotion_list_leaked.xlsx". Whoever is nosiest goes to read it on a private terminal.',
    targets: "node",
    requiresCapability: "records",
    requiresBreach: true,
    trace: 0.07,
    evidence: 0.5,
    minutes: 1.5,
    run({ state, node, params }) {
      if (!node) return fail("No node selected.");
      const orgId = node.ownerId;
      const filename = String(params["filename"] ?? "promotion_list_leaked.xlsx");
      const staff = [...state.npcs.values()].filter(
        (n) => n.orgId && n.orgId === orgId && n.condition === "normal",
      );
      if (staff.length === 0) return fail("Nobody on this network to take the bait.");
      // The nosiest, least busy person bites first.
      const ranked = staff.sort((a, b) => b.traits.curiosity - a.traits.curiosity).slice(0, 3);
      for (const person of ranked) {
        deliver(state, person, {
          label: `has gone to read "${filename}" somewhere private`,
          action: { type: "investigate", placeId: node.placeId, minutes: 10 },
          priority: 0.65,
          plausibility: 0.6,
          hingesOn: "curiosity",
          ttlMinutes: 40,
          suspicionOnRefusal: 0.1,
          originHackId: "plant_bait_file",
        });
      }
      state.log.emit(state.time, {
        channel: "hack",
        kind: "hack.bait_planted",
        text: `"${filename}" appears on ${node.label}.`,
        subjects: [node.id],
        traceable: true,
      });
      return ok(`Bait planted. ${ranked.map((p) => p.name).join(", ")} are the likeliest to bite.`);
    },
  },
  {
    id: "offer_channel",
    label: "Offer a secure channel",
    category: "social",
    blurb: "Give the whistleblower what they have been looking for. They walk out with the evidence.",
    targets: "npc",
    requiresBreach: true,
    leverageOnly: true,
    trace: 0.08,
    evidence: 0.7,
    minutes: 2,
    available({ target }) {
      if (!target) return { ok: false, reason: "No person selected." };
      const secret = target.secrets.find((s) => s.revealed && s.kind === "whistleblower");
      if (!secret) return { ok: false, reason: "They are not building a case against anyone." };
      return { ok: true };
    },
    run({ state, target }) {
      if (!target) return fail("No person selected.");
      deliver(state, target, {
        label: "has left with what they were collecting",
        action: { type: "leave_site", minutes: 200 },
        priority: 0.9,
        plausibility: 0.8,
        hingesOn: "anxiety",
        ttlMinutes: 45,
        suspicionOnRefusal: 0.25,
        originHackId: "offer_channel",
      });
      return ok(`${target.name} is going to take the chance.`);
    },
  },
];

/* ------------------------------------------------------------- puppetry */

const PUPPETRY: HackVerb[] = [
  {
    id: "tamper_food_order",
    label: "Amend a food order",
    category: "puppetry",
    blurb:
      "Edit an order already in flight. The kitchen makes what the ticket says, the courier delivers it, and the log shows a normal transaction.",
    targets: "npc",
    requiresBreach: false,
    leverageOnly: true,
    trace: 0.05,
    evidence: 0.9,
    minutes: 1,
    available({ state, target }) {
      if (!target) return { ok: false, reason: "No person selected." };
      const order = [...state.orders.values()].find(
        (o) => o.kind === "food" && o.forNpcId === target.id && o.status !== "delivered" && o.status !== "cancelled",
      );
      if (!order) return { ok: false, reason: `No food order in flight for ${target.name}.` };
      return { ok: true };
    },
    run(ctx) {
      const { state, target } = ctx;
      if (!target) return fail("No person selected.");
      const order = [...state.orders.values()].find(
        (o) => o.kind === "food" && o.forNpcId === target.id && o.status !== "delivered" && o.status !== "cancelled",
      );
      if (!order) return fail("Order already delivered.");
      const allergen = String(ctx.params["allergen"] ?? "shellfish");
      const existing = (order.payload["allergens"] as string[] | undefined) ?? [];
      order.payload["allergens"] = [...existing, allergen];
      order.tampered.push("allergens");
      state.log.emit(state.time, {
        channel: "hack",
        kind: "order.tampered",
        text: `Order ${order.id} amended: ${allergen} added to the ticket.`,
        subjects: [order.id, target.id],
        traceable: true,
      });
      return ok(`Ticket amended. Arrives ${formatTime(order.dueAt)}.`);
    },
  },
  {
    id: "reroute_delivery",
    label: "Reroute a delivery",
    category: "puppetry",
    blurb:
      "Change where a parcel is going. The courier turns up somewhere they have no business being and needs a signature.",
    targets: "node",
    requiresNodeKinds: ["delivery_tablet", "terminal"],
    requiresCapability: "records",
    requiresBreach: true,
    trace: 0.06,
    evidence: 0.7,
    minutes: 1.5,
    available({ state }) {
      const inFlight = [...state.orders.values()].filter((o) => o.kind === "parcel" && o.status === "in_transit");
      if (inFlight.length === 0) return { ok: false, reason: "No parcels in transit right now." };
      return { ok: true };
    },
    run(ctx) {
      const { state } = ctx;
      const destination = ctx.params["placeId"] as PlaceId | undefined;
      const order = [...state.orders.values()].find((o) => o.kind === "parcel" && o.status === "in_transit");
      if (!order) return fail("No parcel in transit.");
      const dest = destination ?? state.player.placeId;
      order.destinationPlaceId = dest;
      order.tampered.push("destination");
      const courier = order.assigneeNpcId ? state.npcs.get(order.assigneeNpcId) : undefined;
      if (courier) {
        courier.destinationId = dest;
        deliver(state, courier, {
          label: `is delivering to ${placeName(state, dest)}`,
          action: { type: "handle_delivery", placeId: dest, minutes: 8 },
          priority: 0.7,
          plausibility: 0.9,
          hingesOn: "diligence",
          ttlMinutes: 60,
          suspicionOnRefusal: 0.1,
          originHackId: "reroute_delivery",
        });
      }
      return ok(`${order.label} rerouted to ${placeName(state, dest)}.`);
    },
  },
  {
    id: "file_work_order",
    label: "File a work order",
    category: "puppetry",
    blurb:
      "Report a fault. Facilities dispatch someone with keys, and doors open along the way because they are supposed to.",
    targets: "node",
    requiresCapability: "records",
    requiresBreach: true,
    trace: 0.05,
    evidence: 0.6,
    minutes: 1.5,
    run(ctx) {
      const { state, node } = ctx;
      if (!node) return fail("No node selected.");
      const targetPlace = (ctx.params["placeId"] as PlaceId | undefined) ?? node.placeId;
      const orgId = node.ownerId;
      const description = String(ctx.params["description"] ?? "Water ingress reported — urgent");
      const janitors = [...state.npcs.values()].filter(
        (n) => n.orgId === orgId && n.archetypeId === "janitor" && n.condition === "normal",
      );
      const assignee = janitors[0];
      const order = {
        id: nextId(state, "ord"),
        kind: "work" as const,
        label: description,
        destinationPlaceId: targetPlace,
        createdAt: state.time,
        dueAt: state.time + 12,
        status: "pending" as const,
        payload: { description },
        tampered: [],
        forged: true,
        ...(orgId ? { orgId } : {}),
        ...(assignee ? { assigneeNpcId: assignee.id } : {}),
      };
      state.orders.set(order.id, order);
      if (assignee) {
        deliver(state, assignee, {
          label: `is responding to a work order at ${placeName(state, targetPlace)}`,
          action: { type: "handle_delivery", placeId: targetPlace, minutes: 15 },
          priority: 0.7,
          plausibility: 0.88,
          hingesOn: "diligence",
          ttlMinutes: 45,
          suspicionOnRefusal: 0.08,
          originHackId: "file_work_order",
        });
        return ok(`Work order filed. ${assignee.name} is on the way to ${placeName(state, targetPlace)}.`);
      }
      return ok("Work order filed, but nobody is rostered to take it.");
    },
  },
  {
    id: "requisition_asset",
    label: "Requisition an asset",
    category: "puppetry",
    blurb:
      "Flag the item for transfer. The building removes it from its own secure case and carries it somewhere you can reach. Nobody breaks anything, and the logs show a valid user following procedure.",
    targets: "node",
    requiresNodeKinds: ["inventory_case", "terminal"],
    requiresBreach: true,
    trace: 0.08,
    evidence: 0.75,
    minutes: 2.5,
    available({ state, node }) {
      if (!node) return { ok: false, reason: "No node selected." };
      const cases = [...state.city.nodes.values()].filter(
        (n) => n.kind === "inventory_case" && n.subnetId === node.subnetId,
      );
      if (cases.length === 0) return { ok: false, reason: "No inventory system on this subnet." };
      const holding = cases.find((c) => ((c.state["contents"] as string[] | undefined) ?? []).length > 0);
      if (!holding) return { ok: false, reason: "Every case on this subnet is empty." };
      return { ok: true };
    },
    run(ctx) {
      const { state, node } = ctx;
      if (!node) return fail("No node selected.");
      const cases = [...state.city.nodes.values()].filter(
        (n) => n.kind === "inventory_case" && n.subnetId === node.subnetId,
      );
      const holding = cases.find((c) => ((c.state["contents"] as string[] | undefined) ?? []).length > 0);
      if (!holding) return fail("Nothing in the case.");

      const contents = (holding.state["contents"] as string[]) ?? [];
      const item = contents[0]!;
      // Destination: the least-secure place on the same subnet the arm can reach.
      const arm = [...state.city.nodes.values()].find(
        (n) => n.kind === "lab_arm" && n.subnetId === node.subnetId,
      );
      const candidates = state.city.graph
        .placesInBuilding(state.city.graph.place(holding.placeId).buildingId ?? "")
        .filter((p) => p.floor === state.city.graph.place(holding.placeId).floor)
        .sort((a, b) => ZONE_RANK[a.zone] - ZONE_RANK[b.zone]);
      const dropPlace = (ctx.params["placeId"] as PlaceId | undefined) ?? candidates[0]?.id ?? holding.placeId;

      holding.state["locked"] = false;
      holding.state["contents"] = contents.slice(1);
      schedule(state, state.time + 6, "requisition.complete", {
        item,
        fromNodeId: holding.id,
        toPlaceId: dropPlace,
        ...(arm ? { armNodeId: arm.id } : {}),
      });
      state.log.emit(state.time, {
        channel: "hack",
        kind: "inventory.requisitioned",
        text: `Transfer order raised: ${item} → ${placeName(state, dropPlace)} for handling.`,
        subjects: [holding.id],
        traceable: true,
      });
      return ok(`${item} released for transfer. Arrives at ${placeName(state, dropPlace)} in ~6 minutes.`);
    },
  },
  {
    id: "dispatch_cleaning_bot",
    label: "Dispatch the cleaner",
    category: "puppetry",
    blurb: "Send the floor bot somewhere and have it make a mess worth reporting.",
    targets: "node",
    requiresNodeKinds: ["cleaning_bot"],
    requiresBreach: true,
    trace: 0.04,
    evidence: 0.25,
    minutes: 1,
    run(ctx) {
      const { state, node } = ctx;
      if (!node) return fail("No node selected.");
      const dest = (ctx.params["placeId"] as PlaceId | undefined) ?? state.player.placeId;
      node.state["destination"] = dest;
      schedule(state, state.time + 5, "bot.arrived", { nodeId: node.id, placeId: dest });
      return ok(`${node.label} en route to ${placeName(state, dest)}.`);
    },
  },
];

/* ---------------------------------------------------------- environment */

const ENVIRONMENT: HackVerb[] = [
  {
    id: "toggle_lock",
    label: "Unlock / lock door",
    category: "environment",
    blurb: "Throw the mag-lock. Works both ways — locking a door behind someone is often the better play.",
    targets: "node",
    requiresNodeKinds: ["smart_lock"],
    requiresBreach: true,
    trace: 0.05,
    evidence: 0.4,
    minutes: 0.4,
    run({ state, node }) {
      if (!node) return fail("No node selected.");
      const door = [...state.city.graph.doors.values()].find((d) => d.nodeId === node.id);
      if (!door) return fail("This lock is not wired to a door.");
      door.locked = !door.locked;
      return ok(`${door.name} is now ${door.locked ? "locked" : "unlocked"}.`);
    },
  },
  {
    id: "maintenance_lockout",
    label: "Maintenance lockout",
    category: "environment",
    blurb:
      'Flag the room as "maintenance in progress". Doors hold for the duration and whoever is inside stays inside.',
    targets: "node",
    requiresNodeKinds: ["smart_lock"],
    requiresBreach: true,
    trace: 0.09,
    evidence: 0.65,
    minutes: 0.6,
    run(ctx) {
      const { state, node } = ctx;
      if (!node) return fail("No node selected.");
      const door = [...state.city.graph.doors.values()].find((d) => d.nodeId === node.id);
      if (!door) return fail("This lock is not wired to a door.");
      const minutes = Number(ctx.params["minutes"] ?? 5);
      door.jammedUntil = state.time + minutes;
      door.locked = true;
      const trapped = occupantsOf(state, node.placeId);
      for (const person of trapped) {
        person.condition = "confined";
        person.busyUntil = state.time + minutes;
        person.stress = Math.min(1, person.stress + 0.25);
      }
      state.log.emit(state.time, {
        channel: "hack",
        kind: "door.lockout",
        text: `${door.name} held for ${minutes} minutes${trapped.length > 0 ? ` — ${trapped.map((t) => t.name).join(", ")} inside` : ""}.`,
        tone: "warn",
        subjects: [door.id],
        traceable: true,
      });
      return ok(`${door.name} held. ${trapped.length} inside.`);
    },
  },
  {
    id: "hvac_surge",
    label: "Drive the HVAC",
    category: "environment",
    blurb: "Make a room unbearable. People leave without anyone deciding to evacuate.",
    targets: "node",
    requiresNodeKinds: ["hvac"],
    requiresBreach: true,
    trace: 0.06,
    evidence: 0.3,
    minutes: 0.8,
    run({ state, node }) {
      if (!node) return fail("No node selected.");
      const here = occupantsOf(state, node.placeId);
      const graph = state.city.graph;
      const escape = graph
        .edgesFrom(node.placeId)
        .map((e) => graph.place(graph.neighbourOf(e, node.placeId)))
        .find((p) => p.zone !== "restricted");
      for (const person of here) {
        deliver(state, person, {
          label: "steps out — the room has gone unbearable",
          action: escape
            ? { type: "goto", placeId: escape.id, dwellMinutes: 10, thenResume: true }
            : { type: "fixate", minutes: 6 },
          priority: 0.55,
          plausibility: 0.85,
          hingesOn: "diligence",
          ttlMinutes: 12,
          suspicionOnRefusal: 0.06,
          originHackId: "hvac_surge",
          source: "stimulus",
        });
      }
      return ok(`${placeName(state, node.placeId)} climate driven to extremes — ${here.length} affected.`);
    },
  },
  {
    id: "trigger_sprinkler",
    label: "Trip the sprinklers",
    category: "environment",
    blurb: "Clears a room instantly and gets it written up. Loud, effective, and permanently on record.",
    targets: "node",
    requiresNodeKinds: ["sprinkler"],
    requiresBreach: true,
    trace: 0.22,
    evidence: 1.2,
    minutes: 0.5,
    run({ state, node }) {
      if (!node) return fail("No node selected.");
      const here = occupantsOf(state, node.placeId);
      const graph = state.city.graph;
      const escape = graph
        .edgesFrom(node.placeId)
        .map((e) => graph.place(graph.neighbourOf(e, node.placeId)))[0];
      for (const person of here) {
        deliver(state, person, {
          label: "gets out of the room — sprinklers",
          action: escape
            ? { type: "goto", placeId: escape.id, dwellMinutes: 15, thenResume: true }
            : { type: "leave_site", minutes: 20 },
          priority: 0.9,
          plausibility: 0.97,
          hingesOn: "diligence",
          ttlMinutes: 10,
          suspicionOnRefusal: 0,
          originHackId: "trigger_sprinkler",
          source: "stimulus",
        });
        person.stress = Math.min(1, person.stress + 0.35);
      }
      state.log.emit(state.time, {
        channel: "security",
        kind: "security.alarm",
        text: `Sprinkler activation in ${placeName(state, node.placeId)}. Facilities will want an explanation.`,
        tone: "bad",
        subjects: [node.placeId],
        traceable: true,
      });
      return ok(`Sprinklers tripped. ${here.length} cleared the room.`);
    },
  },
  {
    id: "pa_announcement",
    label: "PA announcement",
    category: "environment",
    blurb: "Say something with the building's own voice. Everyone believes the ceiling.",
    targets: "node",
    requiresNodeKinds: ["pa_system"],
    requiresBreach: true,
    trace: 0.12,
    evidence: 0.55,
    minutes: 0.8,
    run(ctx) {
      const { state, node } = ctx;
      if (!node) return fail("No node selected.");
      const message = String(ctx.params["message"] ?? "All staff to the lobby for a mandatory headcount.");
      const buildingId = state.city.graph.place(node.placeId).buildingId;
      const dest = (ctx.params["placeId"] as PlaceId | undefined) ?? node.placeId;
      const staff = [...state.npcs.values()].filter(
        (n) => state.city.graph.places.get(n.placeId)?.buildingId === buildingId && n.condition === "normal",
      );
      for (const person of staff) {
        deliver(state, person, {
          label: "is complying with a building announcement",
          action: { type: "goto", placeId: dest, dwellMinutes: 12, thenResume: true },
          priority: 0.8,
          plausibility: 0.75,
          hingesOn: "gullibility",
          ttlMinutes: 20,
          suspicionOnRefusal: 0.12,
          originHackId: "pa_announcement",
        });
      }
      state.log.emit(state.time, {
        channel: "world",
        kind: "world.announcement",
        text: `PA: "${message}"`,
        tone: "warn",
        subjects: [node.id],
        traceable: true,
      });
      return ok(`Announcement made to ${staff.length} people.`);
    },
  },
  {
    id: "fire_alarm",
    label: "Pull the fire alarm",
    category: "environment",
    blurb:
      "Full evacuation and every mag-lock fails open. It works on everyone and it puts an incident report on the record. Last resort.",
    targets: "node",
    requiresNodeKinds: ["pa_system", "sprinkler", "hvac"],
    requiresBreach: true,
    trace: 0.35,
    evidence: 1.8,
    minutes: 0.5,
    run({ state, node }) {
      if (!node) return fail("No node selected.");
      const buildingId = state.city.graph.place(node.placeId).buildingId;
      if (!buildingId) return fail("Not inside a building.");
      const building = state.city.buildings.get(buildingId);
      for (const door of state.city.graph.doors.values()) {
        const doorPlaces = [...state.city.graph.edges.values()]
          .filter((e) => e.doorId === door.id)
          .flatMap((e) => [e.a, e.b]);
        const inBuilding = doorPlaces.some(
          (p) => state.city.graph.places.get(p)?.buildingId === buildingId,
        );
        if (inBuilding) door.failOpen = true;
      }
      schedule(state, state.time + 25, "fire.reset", { buildingId });

      const streetPlace = [...state.city.graph.places.values()].find(
        (p) => !p.indoor && p.districtId === building?.districtId,
      );
      const occupants = [...state.npcs.values()].filter(
        (n) => state.city.graph.places.get(n.placeId)?.buildingId === buildingId,
      );
      for (const person of occupants) {
        if (person.condition === "hospitalised") continue;
        deliver(state, person, {
          label: "is evacuating",
          action: streetPlace
            ? { type: "goto", placeId: streetPlace.id, dwellMinutes: 20, thenResume: true }
            : { type: "leave_site", minutes: 25 },
          priority: 1,
          plausibility: 0.96,
          hingesOn: "diligence",
          ttlMinutes: 15,
          suspicionOnRefusal: 0,
          originHackId: "fire_alarm",
          source: "stimulus",
        });
      }
      state.log.emit(state.time, {
        channel: "security",
        kind: "security.alarm",
        text: `Fire alarm at ${building?.name ?? buildingId}. Mag-locks released, ${occupants.length} evacuating.`,
        tone: "bad",
        subjects: [buildingId],
        traceable: true,
      });
      return ok(`Evacuation under way. ${occupants.length} moving. Doors open for 25 minutes.`);
    },
  },
];

export const VERBS: HackVerb[] = [...RECON, ...DISTRACTION, ...SOCIAL, ...PUPPETRY, ...ENVIRONMENT];

const BY_ID = new Map(VERBS.map((v) => [v.id, v]));

export function verb(id: string): HackVerb | undefined {
  return BY_ID.get(id);
}

/* ------------------------------------------------------------- offering */

export interface OfferedVerb {
  verb: HackVerb;
  availability: VerbAvailability;
  /** Populated when the verb was unlocked by a specific piece of leverage. */
  leverageLabel?: string;
  params: Record<string, unknown>;
  /** Honest odds, for plays the target is allowed to disbelieve. */
  forecast?: VerbForecast;
}

/** Never let a broken forecast take the whole verb menu down with it. */
function safeForecast(v: HackVerb, ctx: VerbContext): VerbForecast | undefined {
  if (!v.forecast) return undefined;
  try {
    return v.forecast(ctx);
  } catch {
    return undefined;
  }
}

/** Every verb that could be pointed at this node right now, with reasons. */
export function verbsForNode(state: GameState, node: NetworkNode): OfferedVerb[] {
  const out: OfferedVerb[] = [];
  for (const v of VERBS) {
    if (v.targets !== "node" || v.leverageOnly) continue;
    // Kind and capability decide whether the verb is even *conceptually* about
    // this device; if it is not, it should not clutter the menu at all.
    if (v.requiresNodeKinds && !v.requiresNodeKinds.includes(node.kind)) continue;
    if (v.requiresCapability && !node.capabilities.includes(v.requiresCapability)) continue;

    const gated = gate(state, v, { node, params: {} });
    const availability = gated.ok && v.available ? v.available({ state, node, params: {} }) : gated;
    out.push({ verb: v, availability, params: {} });
  }
  return out;
}

/**
 * Every verb that could be pointed at this person, including the ones their
 * secrets have unlocked. This function is the profiling loop's payoff: what
 * appears here is a direct function of how deep the dossier goes.
 */
export function verbsForNpc(
  state: GameState,
  target: Npc,
  /**
   * Caller-supplied context merged into every offer — in practice the place the
   * player has pinned as a destination. Passing it here rather than at invoke
   * time means the odds shown account for it, so "no destination pinned" is
   * visible in the forecast instead of being a surprise afterwards.
   */
  extraParams: Record<string, unknown> = {},
): OfferedVerb[] {
  const out: OfferedVerb[] = [];

  const offer = (v: HackVerb, params: Record<string, unknown>, leverageLabel?: string) => {
    const ctx: VerbContext = { state, target, params };
    const gated = gate(state, v, { target, params });
    const availability = gated.ok && v.available ? v.available(ctx) : gated;
    const forecast = availability.ok ? safeForecast(v, ctx) : undefined;
    out.push({
      verb: v,
      availability,
      params,
      ...(leverageLabel ? { leverageLabel } : {}),
      ...(forecast ? { forecast } : {}),
    });
  };

  for (const v of VERBS) {
    if (v.targets !== "npc" || v.leverageOnly) continue;
    offer(v, extraParams);
  }

  // Leverage-gated verbs, one entry per hook so the parameters come along.
  for (const secret of target.secrets) {
    if (!secret.revealed) continue;
    for (const hook of secret.hooks) {
      const v = BY_ID.get(hook.verb);
      if (!v) continue;
      offer(v, { ...extraParams, ...(hook.params ?? {}) }, hook.label);
    }
  }

  return out;
}

/**
 * Structural gates that hold no matter who is calling — the UI, a test, or a
 * scripted agent. `verbsForNode` reports these so the player can see *why*
 * something is greyed out; `invoke` re-checks them so nothing can bypass the
 * listing and fire a verb it has not earned.
 */
function gate(state: GameState, v: HackVerb, ctx: Omit<VerbContext, "state">): VerbAvailability {
  if (v.requiresSkill && !state.player.skills.has(v.requiresSkill)) {
    return { ok: false, reason: `Requires ${v.requiresSkill.replace(/_/g, " ")}.` };
  }
  if (v.targets === "node") {
    if (!ctx.node) return { ok: false, reason: "No node selected." };
    if (!ctx.node.online) return { ok: false, reason: `${ctx.node.label} is offline.` };
    if (v.requiresNodeKinds && !v.requiresNodeKinds.includes(ctx.node.kind)) {
      return { ok: false, reason: `${v.label} does not apply to a ${ctx.node.kind.replace(/_/g, " ")}.` };
    }
    if (v.requiresCapability && !ctx.node.capabilities.includes(v.requiresCapability)) {
      return { ok: false, reason: `${ctx.node.label} cannot ${v.requiresCapability}.` };
    }
    if (v.requiresBreach && !ctx.node.breached) {
      return { ok: false, reason: `${ctx.node.label} is not breached.` };
    }
    if (!computeReach(state).has(ctx.node.id)) return { ok: false, reason: "Out of range." };
  }
  if (v.targets === "npc" && !ctx.target) return { ok: false, reason: "No person selected." };
  return { ok: true };
}

/** Run a verb, charging trace and evidence only when it actually fires. */
export function invoke(
  state: GameState,
  v: HackVerb,
  ctx: Omit<VerbContext, "state">,
): VerbOutcome {
  const full: VerbContext = { state, ...ctx };
  const gated = gate(state, v, ctx);
  if (!gated.ok) return fail(gated.reason ?? "Not available.");
  const availability = v.available ? v.available(full) : { ok: true };
  if (!availability.ok) return fail(availability.reason ?? "Not available.");

  const outcome = v.run(full);
  if (!outcome.ok) return outcome;

  addTrace(state, v.trace, v.label, ctx.node ? [ctx.node.id] : ctx.target ? [ctx.target.id] : []);
  addEvidence(state, v.evidence);
  if (ctx.node) raiseSubnetAnomaly(state, ctx.node, v.trace * 0.8);
  state.time += v.minutes;

  state.log.emit(state.time, {
    channel: "hack",
    kind: `hack.${v.id}`,
    text: outcome.message,
    tone: "good",
    subjects: [ctx.node?.id, ctx.target?.id].filter((x): x is string => Boolean(x)),
    traceable: v.evidence > 0,
  });
  return outcome;
}

/** Convenience for tests and scripted mission beats. */
export function invokeById(
  state: GameState,
  id: string,
  ctx: Omit<VerbContext, "state">,
): VerbOutcome {
  const v = BY_ID.get(id);
  if (!v) return fail(`No such verb: ${id}`);
  return invoke(state, v, ctx);
}

