/**
 * Trace, suspicion and forensics — the failure axis of a game with no combat.
 *
 * There are three separate pressures, and conflating them would flatten the
 * whole design:
 *
 *   trace     — live, decaying. ctOS noticing *now*. Fills, and the city starts
 *               actively looking: cameras sweep, security sweeps, your reach
 *               degrades. Falls again if you go quiet.
 *   suspicion — per person, sticky. Someone who did not believe you stays
 *               unconvinced for hours and tells their colleagues.
 *   evidence  — permanent. What an investigator could reconstruct afterwards.
 *               Never decays, never visible in-world, and is the entire basis
 *               of the ghost score.
 *
 * You can win loud. You cannot win loud *and* clean.
 */

import type { Instant } from "../core/time.js";
import type { GameState } from "../sim/state.js";
import type { NetworkNode } from "../world/types.js";

/** Trace bled off per world-minute of inactivity. */
const TRACE_DECAY = 0.006;
/** Grace period after your last traceable action before decay starts. */
const TRACE_QUIET_MINUTES = 3;

export function addTrace(state: GameState, amount: number, reason: string, subjects: string[] = []): void {
  const before = state.trace.level;
  state.trace.level = Math.min(1, state.trace.level + amount);
  state.trace.lastActionAt = state.time;

  if (before < 0.5 && state.trace.level >= 0.5) {
    state.log.emit(state.time, {
      channel: "security",
      kind: "trace.elevated",
      text: "ctOS anomaly threshold crossed — automated correlation started.",
      tone: "warn",
      subjects,
    });
  }
  if (before < 1 && state.trace.level >= 1) {
    beginInvestigation(state, `trace saturated (${reason})`);
  }
}

export function addEvidence(state: GameState, amount: number): void {
  state.trace.evidence += amount;
}

export function beginInvestigation(state: GameState, reason: string): void {
  if (state.trace.investigating) {
    state.trace.investigationEndsAt = Math.max(state.trace.investigationEndsAt, state.time + 45);
    return;
  }
  state.trace.investigating = true;
  state.trace.investigationEndsAt = state.time + 60;
  state.trace.reports += 1;
  state.log.emit(state.time, {
    channel: "security",
    kind: "security.investigation_started",
    text: `Active investigation opened — ${reason}. Expect sweeps and re-keyed credentials.`,
    tone: "bad",
    subjects: [],
  });
  // Credentials get rotated the moment anyone starts looking properly.
  for (const badge of state.player.badges) {
    badge.expiresAt = Math.min(badge.expiresAt, state.time + 12);
  }
}

/** Called once per tick from the sim loop. */
export function tickTrace(state: GameState, minutes: number): void {
  if (state.time - state.trace.lastActionAt > TRACE_QUIET_MINUTES) {
    state.trace.level = Math.max(0, state.trace.level - TRACE_DECAY * minutes);
  }
  if (state.trace.investigating && state.time >= state.trace.investigationEndsAt) {
    state.trace.investigating = false;
    state.trace.level = Math.min(state.trace.level, 0.5);
    state.log.emit(state.time, {
      channel: "security",
      kind: "security.investigation_closed",
      text: "Investigation wound down. Nothing conclusive on file.",
      subjects: [],
    });
  }
}

/**
 * Someone reported something. Enough independent reports and the org escalates
 * to a real investigation, regardless of your ctOS trace.
 */
export function reportAnomaly(state: GameState, reporterName: string, detail: string, weight: number): void {
  state.log.emit(state.time, {
    channel: "security",
    kind: "security.reported",
    text: `${reporterName} reported it: ${detail}`,
    tone: "warn",
    subjects: [],
  });
  addTrace(state, weight * 0.3, "human report");
  addEvidence(state, weight * 0.5);
  if (weight > 0.5) beginInvestigation(state, `report from ${reporterName}`);
}

/** Anomaly pressure on a single subnet — triggers a local security audit. */
export function raiseSubnetAnomaly(state: GameState, node: NetworkNode, amount: number): void {
  const subnet = state.city.subnets.get(node.subnetId);
  if (!subnet) return;
  subnet.anomalyScore += amount;
  if (subnet.anomalyScore >= 1 && !state.trace.investigating) {
    subnet.anomalyScore = 0;
    beginInvestigation(state, `${subnet.name} integrity audit`);
  }
}

export interface GhostReport {
  /** 0..100; 100 is a clean ghost. */
  score: number;
  grade: "ghost" | "shadow" | "person of interest" | "suspect" | "identified";
  evidence: number;
  reports: number;
  /** Human-readable list of what an investigator would be able to reconstruct. */
  findings: string[];
}

export function ghostReport(state: GameState): GhostReport {
  const findings: string[] = [];
  const traceable = state.log.all().filter((e) => e.traceable);

  // Only the player's own plays count against them — the city rejecting one of
  // its own routine work orders is not evidence of anything.
  const rejected = traceable.filter(
    (e) => e.kind === "npc.impulse_rejected" && e.data?.["originHackId"] !== "world",
  ).length;
  if (rejected > 0) findings.push(`${rejected} manipulation${rejected === 1 ? "" : "s"} seen through and remembered`);

  const forgedOrders = [...state.orders.values()].filter((o) => o.forged || o.tampered.length > 0);
  if (forgedOrders.length > 0) {
    findings.push(`${forgedOrders.length} order record${forgedOrders.length === 1 ? "" : "s"} shows an out-of-band edit`);
  }

  const medical = state.log.all().filter((e) => e.kind === "npc.medical_episode").length;
  if (medical > 0) findings.push(`${medical} medical incident${medical === 1 ? "" : "s"} on site the same day`);

  const alarms = state.log.all().filter((e) => e.kind === "security.alarm").length;
  if (alarms > 0) findings.push(`${alarms} alarm activation${alarms === 1 ? "" : "s"} with no physical cause`);

  if (state.trace.reports > 0) findings.push(`${state.trace.reports} incident report${state.trace.reports === 1 ? "" : "s"} filed by staff`);

  const suspicious = [...state.npcs.values()].filter((n) => n.suspicion > 0.5);
  if (suspicious.length > 0) {
    findings.push(
      `${suspicious.length} staff can describe something that did not add up (${suspicious
        .slice(0, 3)
        .map((n) => n.name)
        .join(", ")}${suspicious.length > 3 ? ", …" : ""})`,
    );
  }

  if (findings.length === 0) findings.push("Logs read as a normal working day.");

  const raw = state.trace.evidence + state.trace.reports * 0.8 + rejected * 0.6;
  const score = Math.max(0, Math.round(100 - raw * 9));
  const grade: GhostReport["grade"] =
    score >= 90 ? "ghost" : score >= 72 ? "shadow" : score >= 50 ? "person of interest" : score >= 28 ? "suspect" : "identified";

  return { score, grade, evidence: state.trace.evidence, reports: state.trace.reports, findings };
}

export function traceDescription(level: number): string {
  if (level < 0.15) return "quiet";
  if (level < 0.4) return "background noise";
  if (level < 0.65) return "correlating";
  if (level < 0.9) return "narrowing";
  return "locked on";
}

export function investigationRemaining(state: GameState): Instant {
  return Math.max(0, state.trace.investigationEndsAt - state.time);
}
