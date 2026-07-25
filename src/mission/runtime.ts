/**
 * Missions as predicates, not as scripts.
 *
 * An objective is a question asked of world state every tick — "is the chip in
 * the player's hands", "is the lab empty of staff" — never a sequence the
 * player is expected to walk through. Two runs can satisfy the same contract by
 * completely different routes, and neither one is the "intended" solution,
 * because there isn't one. The brief tells you what has to be true; how you
 * make it true is the game.
 *
 * Accolades are graded separately at completion, which is where the pressure to
 * be *clean* rather than merely successful actually lives.
 */

import type { Instant } from "../core/time.js";
import { ghostReport, type GhostReport } from "../hack/trace.js";
import type { GameState } from "../sim/state.js";
import { setMissionTicker } from "../sim/step.js";
import { MISSIONS } from "./missions/index.js";

export interface Objective {
  id: string;
  label: string;
  hint?: string;
  optional?: boolean;
  /** True once world state satisfies this. Latched — never un-completes. */
  done(state: GameState): boolean;
}

export interface Accolade {
  id: string;
  label: string;
  /** Evaluated once, at mission completion. */
  met(state: GameState): boolean;
}

export interface Mission {
  id: string;
  title: string;
  client: string;
  brief: string;
  /** Shown under the brief — the fiction's framing of the constraint. */
  constraint: string;
  objectives: Objective[];
  accolades: Accolade[];
  /** Mission is only offered once these mission ids are complete. */
  requires?: string[];
}

export type MissionStatus = "locked" | "available" | "active" | "complete";

export interface MissionRuntime {
  mission: Mission;
  status: MissionStatus;
  completed: Set<string>;
  startedAt?: Instant;
  completedAt?: Instant;
  awarded: string[];
  report?: GhostReport;
}

export function installMissions(state: GameState): void {
  const runtimes: MissionRuntime[] = MISSIONS.map((mission) => ({
    mission,
    status: (mission.requires && mission.requires.length > 0 ? "locked" : "available") as MissionStatus,
    completed: new Set<string>(),
    awarded: [],
  }));
  state.missions = runtimes;
  setMissionTicker(tickMissions);
}

export function missionRuntimes(state: GameState): MissionRuntime[] {
  return state.missions as MissionRuntime[];
}

export function activateMission(state: GameState, missionId: string): boolean {
  const runtime = missionRuntimes(state).find((r) => r.mission.id === missionId);
  if (!runtime || runtime.status === "complete" || runtime.status === "locked") return false;
  runtime.status = "active";
  runtime.startedAt = state.time;
  state.log.emit(state.time, {
    channel: "mission",
    kind: "mission.started",
    text: `Contract accepted — ${runtime.mission.title}.`,
    subjects: [runtime.mission.id],
  });
  return true;
}

export function tickMissions(state: GameState): void {
  const runtimes = missionRuntimes(state);

  for (const runtime of runtimes) {
    if (runtime.status === "locked") {
      const unmet = (runtime.mission.requires ?? []).some(
        (id) => runtimes.find((r) => r.mission.id === id)?.status !== "complete",
      );
      if (!unmet) {
        runtime.status = "available";
        state.log.emit(state.time, {
          channel: "mission",
          kind: "mission.unlocked",
          text: `New contract available — ${runtime.mission.title}.`,
          subjects: [runtime.mission.id],
        });
      }
      continue;
    }

    if (runtime.status !== "active") continue;

    for (const objective of runtime.mission.objectives) {
      if (runtime.completed.has(objective.id)) continue;
      let done = false;
      try {
        done = objective.done(state);
      } catch {
        done = false;
      }
      if (!done) continue;
      runtime.completed.add(objective.id);
      state.log.emit(state.time, {
        channel: "mission",
        kind: "mission.objective",
        text: `✓ ${objective.label}`,
        tone: "good",
        subjects: [runtime.mission.id],
      });
    }

    const required = runtime.mission.objectives.filter((o) => !o.optional);
    const allDone = required.every((o) => runtime.completed.has(o.id));
    if (!allDone) continue;

    runtime.status = "complete";
    runtime.completedAt = state.time;
    runtime.report = ghostReport(state);
    runtime.awarded = runtime.mission.accolades.filter((a) => a.met(state)).map((a) => a.id);

    state.log.emit(state.time, {
      channel: "mission",
      kind: "mission.complete",
      text: `Contract complete — ${runtime.mission.title}. Assessed as: ${runtime.report.grade}.`,
      tone: "good",
      subjects: [runtime.mission.id],
    });
  }
}

/** Progress summary for the UI. */
export function missionProgress(runtime: MissionRuntime): { done: number; total: number } {
  const required = runtime.mission.objectives.filter((o) => !o.optional);
  return {
    done: required.filter((o) => runtime.completed.has(o.id)).length,
    total: required.length,
  };
}
