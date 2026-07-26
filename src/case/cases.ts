/**
 * Where cases come from.
 *
 * Not sprinkled on top of the city — read out of it. Every template below
 * requires a real configuration that the population generator already produced:
 * a person with a gambling secret, a manager who already has a report, an org
 * with somebody skimming it. The case names the relationship and writes the
 * tell; it never invents a person, and it never attaches harm to somebody the
 * simulation says is fine.
 *
 * Two consequences worth stating, because they are the design:
 *
 *   · **the pair is the unit.** A perpetrator with nobody on the other end is a
 *     label. Every case except `undertow` carries both, and `undertow` exists
 *     precisely so that "someone needs help" does not always imply "someone is
 *     to blame";
 *   · **noticing is passive.** Cases promote themselves from `unseen` to
 *     `flagged` to `open` by looking at what the player has scanned and
 *     breached. Nothing in the UI has to remember to tell them.
 */

import { Rng } from "../core/rng.js";
import type { Npc, NpcId, Relationship, SecretKind } from "../npc/types.js";
import type { GameState } from "../sim/state.js";
import type { NodeId } from "../world/types.js";
import type { CaseKind, CaseRecord, CaseResolution, Ledger, ResolutionKind } from "./types.js";

/** Roughly this share of the population is entangled in something. */
const CASE_DENSITY = 0.17;

interface CaseTemplate {
  kind: CaseKind;
  /** Relative frequency; the city should not be all loan sharks. */
  weight: number;
  /** Secret kinds that make somebody a plausible *subject*. */
  subjectSecrets: SecretKind[];
  /** Tie to create between the two, if the graph does not already have one. */
  tie?: Relationship["kind"];
  /** Prefer a perpetrator the subject is already tied to by one of these. */
  viaExisting?: Relationship["kind"][];
  /** How appealing a given person is as the one doing the harm. */
  perpetratorFit?: (npc: Npc) => number;
  headline: (a: { harm?: Npc; subject: Npc; detail: string }) => string;
  tell: (a: { harm?: Npc; subject: Npc; detail: string }) => string;
  detail: (rng: Rng) => string;
  resolutions: (a: { harm?: Npc; subject: Npc; detail: string }) => CaseResolution[];
}

const walkAway: CaseResolution = {
  kind: "walk_away",
  label: "Keep walking",
  detail: "Close it. Not everything on this street is yours to fix.",
};

export const CASE_TEMPLATES: CaseTemplate[] = [
  {
    kind: "shakedown",
    weight: 1.15,
    subjectSecrets: ["debt", "gambling"],
    tie: "creditor",
    perpetratorFit: (n) => n.traits.greed * 2 + (1 - n.traits.diligence) + n.income / 200_000,
    detail: (rng) => rng.pick(["forty per cent a month", "a rate that doubles on a missed Friday", "interest they stopped itemising"]),
    headline: ({ harm, subject, detail }) =>
      `${harm?.name ?? "Someone"} is lending to ${subject.name} at ${detail}. The balance has not moved in four months; only the fear has.`,
    tell: ({ subject }) => `${subject.name} checks a balance every time the door opens.`,
    resolutions: ({ harm, subject }) => [
      {
        kind: "help",
        label: "Clear the balance",
        detail: `Push the arrears through a settlement account nobody audits. ${subject.name} wakes up level.`,
      },
      {
        kind: "expose",
        label: "Send the book to the licensing board",
        detail: `Route ${harm?.name ?? "the lender"}'s actual ledger to the people who issue the licence.`,
      },
      {
        kind: "warn",
        label: "Show them the rate",
        detail: `Put the real arithmetic on ${subject.name}'s phone and let them decide.`,
      },
      walkAway,
    ],
  },
  {
    kind: "supply",
    weight: 0.85,
    subjectSecrets: ["substance"],
    tie: "dealer",
    perpetratorFit: (n) => n.traits.greed * 2 + (1 - n.traits.anxiety),
    detail: (rng) => rng.pick(["twice a week, always the same bench", "on a repeat order they never placed", "through a courier who bills it as groceries"]),
    headline: ({ harm, subject, detail }) =>
      `${harm?.name ?? "Someone"} is supplying ${subject.name} ${detail}. They are the only reason the habit is still affordable.`,
    tell: ({ subject }) => `${subject.name} is running on something, and the shift is winning.`,
    resolutions: ({ harm, subject }) => [
      {
        kind: "help",
        label: "Book the referral",
        detail: `File the clinic referral ${subject.name} has been putting off, and clear the waiting list ahead of it.`,
      },
      {
        kind: "expose",
        label: "Hand the route to the clinic",
        detail: `${harm?.name ?? "The supplier"}'s delivery pattern goes to the people who can cut it off.`,
      },
      { kind: "warn", label: "Tell them what is in it", detail: "Forward the lab breakdown. No lecture attached." },
      walkAway,
    ],
  },
  {
    kind: "squeeze",
    weight: 0.9,
    subjectSecrets: ["family_crisis", "debt", "immigration", "medical"],
    tie: "landlord",
    perpetratorFit: (n) => n.income / 120_000 + n.traits.greed,
    detail: (rng) => rng.pick(["the heating", "the lift", "the hot water", "the front-door entry system"]),
    headline: ({ harm, subject, detail }) =>
      `${harm?.name ?? "Someone"} has let ${detail} stay broken in ${subject.name}'s block for eleven weeks. It is cheaper than buying out a fixed rent.`,
    tell: ({ subject }) => `${subject.name} has been logging the same repair request since spring.`,
    resolutions: ({ harm, subject }) => [
      {
        kind: "help",
        label: "Raise the work order",
        detail: `File the repair against the building's own maintenance budget. It gets fixed on ${harm?.name ?? "the landlord"}'s money.`,
      },
      {
        kind: "expose",
        label: "Send eleven weeks of logs to the inspector",
        detail: "The complaint history is already written. It has just never left the building.",
      },
      { kind: "warn", label: "Send them the tenancy clause", detail: `${subject.name} has more standing than they think.` },
      walkAway,
    ],
  },
  {
    kind: "coercion",
    weight: 1,
    subjectSecrets: ["on_thin_ice", "immigration", "record", "affair", "moonlighting"],
    viaExisting: ["manager"],
    perpetratorFit: (n) => 1 + (1 - n.traits.diligence),
    detail: (rng) => rng.pick(["unpaid weekend cover", "signing off hours they never worked", "a rota nobody else gets"]),
    headline: ({ harm, subject, detail }) =>
      `${harm?.name ?? "Their manager"} knows something about ${subject.name}, and has been spending it on ${detail}.`,
    tell: ({ subject }) => `${subject.name} agrees to things before they have finished being asked.`,
    resolutions: ({ harm, subject }) => [
      {
        kind: "help",
        label: "Make the leverage worthless",
        detail: `Close the file the pressure hangs on. There is nothing left to hold over ${subject.name}.`,
      },
      {
        kind: "expose",
        label: "Route the rota to HR",
        detail: `Eighteen months of ${harm?.name ?? "the manager"}'s scheduling, side by side, addressed to someone senior.`,
      },
      { kind: "warn", label: "Tell them it is not legal", detail: "One message, with the clause number in it." },
      walkAway,
    ],
  },
  {
    kind: "skimming",
    weight: 0.8,
    subjectSecrets: ["on_thin_ice", "debt", "family_crisis"],
    viaExisting: ["coworker", "manager"],
    perpetratorFit: (n) => (n.secrets.some((s) => s.kind === "embezzlement") ? 6 : 0) + n.traits.greed,
    detail: (rng) => rng.pick(["a shell vendor", "duplicated expense claims", "a padded retainer"]),
    headline: ({ harm, subject, detail }) =>
      `${harm?.name ?? "Someone"} has been draining the org through ${detail}, and the shortfall has landed on ${subject.name}'s numbers.`,
    tell: ({ subject }) => `${subject.name} is being counselled about a gap they did not make.`,
    resolutions: ({ harm, subject }) => [
      {
        kind: "help",
        label: "Correct the attribution",
        detail: `Repoint the shortfall at the account it actually left from. ${subject.name}'s review comes back clean.`,
      },
      {
        kind: "expose",
        label: "Open the vendor to audit",
        detail: `${harm?.name ?? "The skimmer"}'s shell supplier goes on the auditors' desk with two quarters attached.`,
      },
      { kind: "warn", label: "Send them the reconciliation", detail: "So they walk into the meeting holding it." },
      walkAway,
    ],
  },
  {
    kind: "fixation",
    weight: 0.75,
    subjectSecrets: ["affair", "family_crisis", "medical", "on_thin_ice"],
    tie: "ex",
    perpetratorFit: (n) => n.traits.anxiety + n.traits.curiosity + (1 - n.traits.diligence),
    detail: (rng) => rng.pick(["calendar", "location history", "home network", "parcel tracking"]),
    headline: ({ harm, subject, detail }) =>
      `${harm?.name ?? "An ex"} still has access to ${subject.name}'s ${detail}, and has read it every day since they left.`,
    tell: ({ subject }) => `${subject.name} takes a different route home each night, and does not seem to know why.`,
    resolutions: ({ harm, subject }) => [
      {
        kind: "help",
        label: "Cut the access",
        detail: `Rotate every credential ${harm?.name ?? "they"} still hold. ${subject.name} never has to know it was there.`,
      },
      {
        kind: "expose",
        label: "Put the access log where it counts",
        detail: "Four months of reads, timestamped, sent somewhere it will be acted on.",
      },
      { kind: "warn", label: "Show them the log", detail: "The hard version. Their call what happens next." },
      walkAway,
    ],
  },
  {
    kind: "undertow",
    weight: 1.1,
    subjectSecrets: ["family_crisis", "medical", "debt", "immigration", "substance"],
    detail: (rng) =>
      rng.pick([
        "have not slept properly in a month",
        "are two payments from losing the flat",
        "have been eating at work because there is nothing in at home",
        "have cancelled the same appointment four times",
      ]),
    headline: ({ subject, detail }) =>
      `Nobody is doing this to ${subject.name}. They ${detail}, and there is no version of this week where it gets easier.`,
    tell: ({ subject }) => `${subject.name} is holding it together at some cost.`,
    resolutions: ({ subject }) => [
      {
        kind: "help",
        label: "Take one thing off them",
        detail: `Pay the arrears, book the appointment, file the form. One fewer thing on ${subject.name}'s list.`,
      },
      { kind: "warn", label: "Point them at the scheme", detail: "They qualify for something they have never been told about." },
      walkAway,
    ],
  },
];

/* -------------------------------------------------------------- generation */

function hasSecret(npc: Npc, kinds: SecretKind[]): boolean {
  return npc.secrets.some((s) => kinds.includes(s.kind));
}

function tieBetween(a: Npc, b: Npc, kinds: Relationship["kind"][]): boolean {
  return a.relationships.some((r) => r.otherId === b.id && kinds.includes(r.kind));
}

/** Evidence lives on both handsets plus wherever the subject's secret is filed. */
function evidenceFor(subject: Npc, harm: Npc | undefined, kinds: SecretKind[]): NodeId[] {
  const ids = new Set<NodeId>();
  if (subject.phoneNodeId) ids.add(subject.phoneNodeId);
  if (harm?.phoneNodeId) ids.add(harm.phoneNodeId);
  for (const secret of subject.secrets) {
    if (!kinds.includes(secret.kind)) continue;
    for (const id of secret.sourceNodeIds) ids.add(id);
  }
  return [...ids];
}

/**
 * Build the caseload for a fresh world.
 *
 * Runs on its own Rng stream so adding, removing or retuning a template cannot
 * shift a single decision the population generator already made — the same seed
 * still produces the same people, secrets and routines it always did.
 */
export function installCases(state: GameState): void {
  const rng = new Rng(`${state.seed}:cases`);
  const everyone = [...state.npcs.values()];
  const target = Math.max(6, Math.round(everyone.length * CASE_DENSITY));

  const spokenFor = new Set<NpcId>();
  const cases: CaseRecord[] = [];
  let counter = 0;

  // Deterministic order: the map's insertion order, shuffled once on our own
  // stream. Iterating the map directly would make the caseload an artefact of
  // how the population happens to be keyed.
  const order = rng.shuffle([...everyone]);

  // A template can fail to place — the graph may not offer a manager, or the
  // last eligible subject may already be spoken for. Bounded attempts, because
  // "keep drawing until the caseload is full" is exactly the shape of loop that
  // hangs a browser tab on an unlucky seed.
  for (let attempt = 0; attempt < target * 40 && cases.length < target; attempt++) {
    const template = rng.weighted(CASE_TEMPLATES, (t) => t.weight);

    const subject = order.find(
      (n) => !spokenFor.has(n.id) && hasSecret(n, template.subjectSecrets),
    );
    if (!subject) {
      // No one left this template can speak for. Drop it and try again; if
      // every template is exhausted we are simply done early.
      if (CASE_TEMPLATES.every((t) => !order.some((n) => !spokenFor.has(n.id) && hasSecret(n, t.subjectSecrets)))) {
        break;
      }
      continue;
    }

    let harm: Npc | undefined;
    if (template.viaExisting) {
      const candidates = subject.relationships
        .filter((r) => template.viaExisting!.includes(r.kind))
        .map((r) => state.npcs.get(r.otherId))
        .filter((n): n is Npc => Boolean(n) && !spokenFor.has(n!.id));
      if (candidates.length === 0) continue; // the graph does not support it here
      harm = candidates.reduce((best, n) =>
        (template.perpetratorFit?.(n) ?? 0) > (template.perpetratorFit?.(best) ?? 0) ? n : best,
      );
    } else if (template.tie) {
      const pool = order.filter(
        (n) =>
          n.id !== subject.id &&
          !spokenFor.has(n.id) &&
          // Someone already close to them is the wrong shape for these — a
          // creditor is not your spouse.
          !tieBetween(subject, n, ["spouse", "partner", "sibling", "parent", "child"]),
      );
      if (pool.length === 0) continue;
      harm = rng.weighted(pool, (n) => Math.max(0.01, template.perpetratorFit?.(n) ?? 1));
      // Write the tie into the graph so the relationship is real: it shows up
      // in the dossier, it can be exploited by every existing verb, and the
      // case is describing the world rather than annotating it.
      if (!tieBetween(harm, subject, [template.tie])) {
        harm.relationships.push({ otherId: subject.id, kind: template.tie, trust: rng.float(0.1, 0.3), covert: true });
      }
    }

    spokenFor.add(subject.id);
    if (harm) spokenFor.add(harm.id);

    const detail = template.detail(rng);
    const ctx = { harm, subject, detail };
    cases.push({
      id: `case_${++counter}`,
      kind: template.kind,
      ...(harm ? { harmNpcId: harm.id } : {}),
      subjectNpcId: subject.id,
      headline: template.headline(ctx),
      tell: template.tell(ctx),
      evidenceNodeIds: evidenceFor(subject, harm, template.subjectSecrets),
      resolutions: template.resolutions(ctx),
      status: "unseen",
    });
  }

  state.cases = cases;
  state.ledger = { helped: 0, exposed: 0, warned: 0, walkedPast: 0, scanned: 0 };
}

/* ------------------------------------------------------------------ notice */

/**
 * Promote every case against what the player has actually seen and opened.
 *
 * Cheap enough to run every tick — a caseload is on the order of fifteen — and
 * running it from the tick rather than from the scan verb means there is no way
 * for a new route to a fact to forget to update the caseload.
 */
export function refreshCases(state: GameState): void {
  const breached = state.player.breachedNodeIds;
  let scanned = 0;
  for (const person of state.npcs.values()) if (person.revealedFields.has("identity")) scanned++;
  state.ledger.scanned = scanned;

  for (const record of state.cases) {
    if (record.status === "resolved") continue;

    const subject = state.npcs.get(record.subjectNpcId);
    const harm = record.harmNpcId ? state.npcs.get(record.harmNpcId) : undefined;
    const seen =
      Boolean(subject?.revealedFields.has("identity")) || Boolean(harm?.revealedFields.has("identity"));
    const read = record.evidenceNodeIds.some((id) => breached.has(id));

    const next = read && seen ? "open" : seen ? "flagged" : "unseen";
    if (next === record.status) continue;
    // Only ever forward. Releasing a node should not un-know something.
    if (record.status === "open") continue;
    if (record.status === "flagged" && next === "unseen") continue;

    record.status = next;
    if (next === "flagged") {
      state.log.emit(state.time, {
        channel: "social",
        kind: "case.flagged",
        text: record.tell,
        tone: "warn",
        subjects: [record.id, record.subjectNpcId],
      });
    } else if (next === "open") {
      state.log.emit(state.time, {
        channel: "social",
        kind: "case.open",
        text: record.headline,
        tone: "warn",
        subjects: [record.id, record.subjectNpcId, ...(record.harmNpcId ? [record.harmNpcId] : [])],
      });
    }
  }
}

/* ------------------------------------------------------------------ lookup */

export function caseById(state: GameState, id: string): CaseRecord | undefined {
  return state.cases.find((c) => c.id === id);
}

/** Every unresolved case this person is a party to. */
export function casesFor(state: GameState, npcId: NpcId): CaseRecord[] {
  return state.cases.filter(
    (c) => c.status !== "resolved" && (c.subjectNpcId === npcId || c.harmNpcId === npcId),
  );
}

export type CaseFlag = "harm" | "need";

/**
 * The chip on the ctOS card: red if this person is the one doing it, amber if
 * they are the one it is happening to. Nothing shows until they have been
 * scanned, which is what makes scanning worth doing.
 */
export function caseFlag(state: GameState, npcId: NpcId): CaseFlag | undefined {
  let flag: CaseFlag | undefined;
  for (const record of state.cases) {
    if (record.status === "unseen" || record.status === "resolved") continue;
    if (record.harmNpcId === npcId) return "harm"; // red wins
    if (record.subjectNpcId === npcId) flag = "need";
  }
  return flag;
}

/* -------------------------------------------------------------- resolution */

export interface CaseOutcome {
  ok: boolean;
  message: string;
}

/**
 * Act on a case.
 *
 * Deliberately infallible. Everything else in this game can be doubted,
 * refused, traced or seen through; this is the one surface where deciding to do
 * something *is* doing it. A casual loop that can fail is not a casual loop —
 * and the interesting question was never "can you", it was "will you, and
 * which way".
 */
export function resolveCase(state: GameState, caseId: string, kind: ResolutionKind): CaseOutcome {
  const record = caseById(state, caseId);
  if (!record) return { ok: false, message: "No such case." };
  if (record.status === "resolved") return { ok: false, message: "Already closed." };
  if (kind !== "walk_away" && record.status !== "open") {
    return { ok: false, message: "You do not know enough yet. Read a phone." };
  }
  if (!record.resolutions.some((r) => r.kind === kind)) {
    return { ok: false, message: "Not something this case offers." };
  }

  const subject = state.npcs.get(record.subjectNpcId);
  const harm = record.harmNpcId ? state.npcs.get(record.harmNpcId) : undefined;
  if (!subject) return { ok: false, message: "That person is gone." };

  record.status = "resolved";
  record.resolvedBy = kind;
  record.resolvedAt = state.time;

  switch (kind) {
    case "help": {
      subject.stress = Math.max(0, subject.stress - 0.45);
      remember(subject, state.time, "Something that had been getting worse stopped getting worse.");
      // The tie itself goes. That is what "helped" has to mean, or the case
      // regenerates the same pressure tomorrow.
      if (harm) severTie(harm, subject.id);
      state.ledger.helped++;
      state.log.emit(state.time, {
        channel: "social",
        kind: "case.helped",
        text: `${subject.name} is out from under it. Nobody will ever know it was you.`,
        tone: "good",
        subjects: [record.id, subject.id],
      });
      return { ok: true, message: `${subject.name} is out from under it.` };
    }

    case "expose": {
      if (!harm) return { ok: true, message: "Nobody to expose. Closed." };
      // The city acts, not the player: they are off the floor for the day and
      // the thing they were doing stops being possible.
      harm.condition = "off_site";
      harm.busyUntil = state.time + 8 * 60;
      harm.stress = Math.min(1, harm.stress + 0.5);
      severTie(harm, subject.id);
      subject.stress = Math.max(0, subject.stress - 0.3);
      remember(harm, state.time, "Somebody sent it to exactly the right desk.");
      state.ledger.exposed++;
      state.log.emit(state.time, {
        channel: "security",
        kind: "case.exposed",
        text: `${harm.name} has been pulled off the floor. It landed where it needed to land.`,
        tone: "good",
        subjects: [record.id, harm.id, subject.id],
      });
      return { ok: true, message: `${harm.name} has been pulled off the floor.` };
    }

    case "warn": {
      subject.stress = Math.max(0, subject.stress - 0.15);
      subject.suspicion = Math.min(1, subject.suspicion + 0.05);
      remember(subject, state.time, "Someone told them the truth and did not stay to be thanked.");
      state.ledger.warned++;
      state.log.emit(state.time, {
        channel: "social",
        kind: "case.warned",
        text: `${subject.name} knows now. What they do with it is theirs.`,
        tone: "good",
        subjects: [record.id, subject.id],
      });
      return { ok: true, message: `${subject.name} knows now.` };
    }

    case "walk_away": {
      state.ledger.walkedPast++;
      state.log.emit(state.time, {
        channel: "social",
        kind: "case.passed",
        text: `You kept walking. ${subject.name} carries on.`,
        subjects: [record.id, subject.id],
      });
      return { ok: true, message: "You kept walking." };
    }
  }
}

function severTie(from: Npc, otherId: NpcId): void {
  from.relationships = from.relationships.filter(
    (r) => !(r.otherId === otherId && ["creditor", "dealer", "landlord", "ex"].includes(r.kind)),
  );
}

function remember(npc: Npc, at: number, text: string): void {
  npc.memory.push({ at, kind: "case", text, weight: 0.4 });
}

/* ---------------------------------------------------------------- readouts */

/** The one line the HUD carries: what this walk has added up to. */
export function ledgerLine(ledger: Ledger): string {
  const parts: string[] = [];
  if (ledger.helped > 0) parts.push(`${ledger.helped} helped`);
  if (ledger.exposed > 0) parts.push(`${ledger.exposed} exposed`);
  if (ledger.warned > 0) parts.push(`${ledger.warned} warned`);
  if (parts.length === 0) return `${ledger.scanned} profiled`;
  return `${parts.join(" · ")} · ${ledger.scanned} profiled`;
}

export function openCases(state: GameState): CaseRecord[] {
  return state.cases.filter((c) => c.status === "open" || c.status === "flagged");
}
