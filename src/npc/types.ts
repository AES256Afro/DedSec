/**
 * People.
 *
 * An NPC is three things stacked together:
 *
 *  1. a *dossier* — the facts the profiler can surface, layer by layer;
 *  2. a *routine* — where they would be if you never touched them;
 *  3. an *impulse queue* — the pressure you apply, arbitrated against their
 *     personality to decide whether they comply, hesitate, or get suspicious.
 *
 * Manipulation in this game is always the same shape: learn a fact, turn the
 * fact into an impulse, and let the routine bend around it.
 */

import type { DayWindow, Instant } from "../core/time.js";
import type { NodeId, PlaceId, SecurityZone } from "../world/types.js";

export type NpcId = string;

/** Personality axes, each 0..1. These are the dials manipulation is checked against. */
export interface Traits {
  /** Stays on task, verifies claims, follows procedure. Resists social pretexts. */
  diligence: number;
  /** Takes bait. Opens the file. Walks over to look. */
  curiosity: number;
  /** Accepts asserted authority without checking. */
  gullibility: number;
  /** Responds to flattery, recognition, status. */
  vanity: number;
  /** Responds to money, discounts, deals. */
  greed: number;
  /** Escalates, panics, calls someone. High anxiety spreads alarm fast. */
  anxiety: number;
  /** Talks to people; gossip propagates suspicion through them. */
  sociability: number;
  /** Spots phishing, notices a cloned badge, reboots the weird phone. */
  techLiteracy: number;
}

export type TraitKey = keyof Traits;

/**
 * +1 — a high score makes the person harder to manipulate through this trait.
 * -1 — a high score makes them *easier*: the trait is the hook, not the shield.
 */
export const TRAIT_POLARITY: Record<TraitKey, 1 | -1> = {
  diligence: 1,
  techLiteracy: 1,
  curiosity: -1,
  gullibility: -1,
  vanity: -1,
  greed: -1,
  anxiety: -1,
  sociability: -1,
};

export type ActivityKind =
  | "sleep"
  | "commute"
  | "work"
  | "post" // stationed somewhere; leaving is noticed
  | "patrol"
  | "break"
  | "meal"
  | "leisure"
  | "errand"
  | "social"
  | "idle"
  | "responding"; // reacting to something you did

/** A block of the day this person would normally spend somewhere. */
export interface RoutineBlock {
  id: string;
  label: string;
  window: DayWindow;
  placeId: PlaceId;
  activity: ActivityKind;
  /** Leaving a post is a dereliction; colleagues notice and it costs them. */
  post: boolean;
  /** Weekday indices this applies to; omitted means every day. */
  days?: number[];
}

export interface Account {
  id: string;
  service: string;
  handle: string;
  /** Revealed at L1; reused across services when `reused` is set. */
  password?: string;
  reused: boolean;
  /** Node this account grants a login on, if any. */
  grantsNodeId?: NodeId;
}

export type RelationshipKind =
  | "spouse"
  | "partner"
  | "affair"
  | "ex"
  | "sibling"
  | "cousin"
  | "parent"
  | "child"
  | "friend"
  | "coworker"
  | "manager"
  | "report"
  | "rival"
  | "landlord"
  | "client"
  | "dealer"
  | "creditor";

export interface Relationship {
  otherId: NpcId;
  kind: RelationshipKind;
  /** 0..1 — how readily they act on a message that appears to come from them. */
  trust: number;
  /** The relationship itself is the secret (affairs, dealers, creditors). */
  covert: boolean;
}

export type SecretKind =
  | "affair"
  | "debt"
  | "gambling"
  | "substance"
  | "medical"
  | "allergy"
  | "record" // criminal record
  | "whistleblower"
  | "moonlighting"
  | "obsession"
  | "on_thin_ice" // about to be fired
  | "family_crisis"
  | "immigration"
  | "embezzlement";

/**
 * A concrete manipulation the fact unlocks. `verb` is a hack id; `params` is
 * merged into the hack invocation, which is how "he's allergic to shellfish"
 * becomes a *button* rather than flavour text.
 */
export interface LeverageHook {
  verb: string;
  label: string;
  params?: Record<string, unknown>;
}

export interface Secret {
  id: string;
  kind: SecretKind;
  /** Player-facing one-liner once revealed. */
  summary: string;
  /** Profile layer at which this becomes legible. */
  layer: 1 | 2 | 3;
  /** Other people this implicates. */
  involves: NpcId[];
  /** 0..1 how damaging — drives leverage strength and blowback. */
  weight: number;
  hooks: LeverageHook[];
  /** Node ids that carry the evidence; you must breach one of them. */
  sourceNodeIds: NodeId[];
  revealed: boolean;
}

/* ------------------------------------------------------------------ impulses */

export type ImpulseAction =
  /** Walk somewhere, linger, then decide whether to go back. */
  | { type: "goto"; placeId: PlaceId; dwellMinutes: number; thenResume: boolean }
  /** Stop working and stare at something for a while, without moving. */
  | { type: "fixate"; minutes: number; atPlaceId?: PlaceId }
  /** Take a call. Attention off, still in place. */
  | { type: "take_call"; minutes: number; fromNpcId?: NpcId }
  /** Go and look into something specific; may raise suspicion if it's fake. */
  | { type: "investigate"; placeId: PlaceId; minutes: number }
  /** Get out of the building entirely for a while. */
  | { type: "leave_site"; minutes: number }
  /** Medical event: collapses in place, draws every bystander and an ambulance. */
  | { type: "medical_episode"; severity: number }
  /** Go find another person and have it out with them. */
  | { type: "confront"; targetId: NpcId }
  /** Escort/handle a physical delivery at a place. */
  | { type: "handle_delivery"; placeId: PlaceId; minutes: number };

/**
 * Where an impulse came from, which decides whether the target gets to
 * disbelieve it.
 *
 *   player / social — a *claim*: a forged message, a fake alert, a rumour.
 *     These go through adjudication, because they can be seen through.
 *   stimulus        — a *fact*: a blaring speaker, a room driven to forty
 *     degrees, water coming out of the ceiling. There is nothing to disbelieve,
 *     so these are simply obeyed. That is the whole trade: environmental verbs
 *     always work and always cost trace; social verbs are quiet and fallible.
 *   work / emergency / schedule — the city's own business.
 */
export type ImpulseSource = "schedule" | "player" | "social" | "emergency" | "work" | "stimulus";

export interface Impulse {
  id: string;
  source: ImpulseSource;
  /** Feed text: "Aron believes he won the auction". */
  label: string;
  /** 0..1; higher beats the current activity. */
  priority: number;
  action: ImpulseAction;
  /**
   * 0..1 — how believable this is *in context*. The same forged text is
   * plausible at 12:05 and absurd at 03:40, and the verb layer is responsible
   * for computing that before the impulse is ever queued.
   */
  plausibility: number;
  /**
   * The trait this pretext turns on. Note that traits are not all resistances:
   * diligence and tech-literacy make a person harder to move, while curiosity,
   * greed, vanity, gullibility and anxiety make them *easier* to move by a
   * pretext aimed at them. `TRAIT_POLARITY` carries which is which, so a bait
   * file hinging on curiosity works better on curious people, not worse.
   */
  hingesOn: TraitKey;
  createdAt: Instant;
  expiresAt: Instant;
  /** Suspicion added if they see through it. */
  suspicionOnRefusal: number;
  /** Hack invocation that produced this, for forensics. */
  originHackId?: string;
}

export interface MemoryEntry {
  at: Instant;
  kind: string;
  text: string;
  /** 0..1 significance; decays, and above a threshold it gets reported. */
  weight: number;
  aboutNpcId?: NpcId;
}

export type NpcCondition =
  | "normal"
  | "distracted"
  | "alarmed"
  | "panicked"
  | "incapacitated" // medical episode in progress
  | "hospitalised"
  | "off_site"
  | "confined"; // locked in a room by a maintenance hack

export interface Npc {
  id: NpcId;
  name: string;
  age: number;
  /** Neutral by default; the generator never infers gender from a name. */
  pronouns: "they/them" | "she/her" | "he/him";
  archetypeId: string;
  occupation: string;
  orgId?: string;
  /** Badge clearance inside their own org's building. */
  clearance: SecurityZone;
  income: number;
  /** The WD2-style one-line profile fact. */
  quirk: string;
  traits: Traits;

  homePlaceId: PlaceId;
  workPlaceId?: PlaceId;

  deviceIds: NodeId[];
  phoneNodeId?: NodeId;
  accounts: Account[];
  relationships: Relationship[];
  secrets: Secret[];
  routine: RoutineBlock[];
  /** Interests drive which fake alerts they will believe. */
  interests: string[];

  /* --- runtime --------------------------------------------------------- */
  placeId: PlaceId;
  /** Set while walking an edge; `t` runs 0..1 from `fromPlaceId`. */
  transit?: { edgeId: string; fromPlaceId: PlaceId; toPlaceId: PlaceId; t: number };
  destinationId?: PlaceId;
  activity: ActivityKind;
  condition: NpcCondition;
  /** When the current condition or dwell ends. */
  busyUntil: Instant;
  /** Where to resume after an interruption. */
  resumePlaceId?: PlaceId;
  impulses: Impulse[];
  activeImpulse?: Impulse;
  /** 0..1. Above ~0.6 they report it; at 1.0 the org starts an audit. */
  suspicion: number;
  /** 0..1. Rises with disruption; high stress makes them erratic and chatty. */
  stress: number;
  memory: MemoryEntry[];
  /** Portable nodes physically on this person right now. */
  carrying: NodeId[];
  /** Profile layer the player has unlocked. */
  profileLayer: 0 | 1 | 2 | 3;
  /** Dossier field ids the player has surfaced. */
  revealedFields: Set<string>;
  /** Player-applied tag, shown on the world overlay. */
  tagged: boolean;
}
