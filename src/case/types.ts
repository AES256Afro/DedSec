/**
 * Cases — the reason to keep walking.
 *
 * The contract board is a sequence of jobs with briefs and grades. A case is the
 * opposite: something you *notice*, in the street, because you scanned somebody
 * and the readout did not sit right. There is no timer, no failure state and no
 * grade. You either do something about it or you keep walking, and both are
 * legitimate.
 *
 * Every case is a pair. One person carries the harm; one person carries the
 * cost. That pairing is the whole design — a lone "bad person" is a label, but
 * a bad person *attached to someone they are hurting* is a situation, and a
 * situation is something a player can be moved by.
 */

import type { NpcId } from "../npc/types.js";
import type { NodeId } from "../world/types.js";

export type CaseKind =
  /** Somebody lending at a rate that was never going to be paid back. */
  | "shakedown"
  /** Somebody selling a habit to a person who cannot stop buying. */
  | "supply"
  /** A landlord making a flat unliveable to get a tenant out of a fixed rent. */
  | "squeeze"
  /** A manager holding a report's private life over their job. */
  | "coercion"
  /** Somebody skimming an org while a colleague is being blamed for the gap. */
  | "skimming"
  /** An ex who will not let go, and a phone full of the proof. */
  | "fixation"
  /** Nobody is at fault. Someone is just drowning quietly. */
  | "undertow";

/** Where the case sits in the player's head, not in the world. */
export type CaseStatus =
  /** Generated, but the player has never scanned either party. */
  | "unseen"
  /** Scanned one of them: a coloured chip on the card, and the tell. */
  | "flagged"
  /** Read a phone: you know what it actually is, and what you could do. */
  | "open"
  /** Closed, one way or another. */
  | "resolved";

export type ResolutionKind =
  /** Fix the subject's problem directly. Quiet. Nobody is punished. */
  | "help"
  /** Put the evidence where it lands on the person doing the harm. */
  | "expose"
  /** Tell the subject what you found and let them decide. */
  | "warn"
  /** Close it without acting. Costs nothing, counts for nothing. */
  | "walk_away";

export interface CaseResolution {
  kind: ResolutionKind;
  /** Player-facing button text, written for this specific case. */
  label: string;
  /** What it does, in one line, shown under the button. */
  detail: string;
}

export interface CaseRecord {
  id: string;
  kind: CaseKind;
  /** The person doing the harm. Absent for `undertow`: nobody is. */
  harmNpcId?: NpcId;
  /** The person carrying the cost. Always present — that is the point. */
  subjectNpcId: NpcId;
  /** One line, shown once the case is open. */
  headline: string;
  /**
   * What a passive scan actually surfaces — an observable behaviour, not a
   * verdict. "Checks a balance every time the door opens" is a tell; "loan
   * shark" is a conclusion the player gets to reach themselves.
   */
  tell: string;
  /** Reading any of these opens the case. */
  evidenceNodeIds: NodeId[];
  resolutions: CaseResolution[];
  status: CaseStatus;
  resolvedBy?: ResolutionKind;
  resolvedAt?: number;
}

/**
 * What the player has done, cumulatively. Not a score — there is no ceiling and
 * no par. It is a record of a walk through a city, which is the only kind of
 * progress this loop wants.
 */
export interface Ledger {
  helped: number;
  exposed: number;
  warned: number;
  walkedPast: number;
  /** Distinct people scanned at all. The denominator everything else sits over. */
  scanned: number;
}
