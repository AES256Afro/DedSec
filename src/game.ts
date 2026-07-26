/**
 * Game bootstrap: seed in, running world out.
 */

import { installCases } from "./case/cases.js";
import { EventLog } from "./core/events.js";
import { Rng } from "./core/rng.js";
import { at } from "./core/time.js";
import { TARGET_BUILDING_ID, TARGET_LAB_KEY } from "./world/blueprint.js";
import { generateCity } from "./world/generator.js";
import { generatePopulation } from "./npc/generator.js";
import { blockAt, scheduledPlace } from "./npc/schedule.js";
import { installMissions } from "./mission/runtime.js";
import type { GameState, PlayerState, TraceState } from "./sim/state.js";

export interface NewGameOptions {
  seed?: string;
  /**
   * World start time. Defaults to 09:20 on day one: everybody is at their desk,
   * the lunch orders have not gone in yet, and there is a full working day
   * ahead of you. Starting before the commute means opening the game on an
   * empty street, which teaches the player nothing.
   */
  startAt?: number;
}

export function newGame(options: NewGameOptions = {}): GameState {
  const seed = options.seed ?? "dedsec";
  const city = generateCity(seed);
  const { npcs, rosters } = generatePopulation(city, seed);

  const startPlace =
    city.streetPlaceIds.get("s_foundry_plaza") ??
    city.streetPlaceIds.get("s_foundry_mid") ??
    [...city.graph.places.values()][0]!.id;

  const player: PlayerState = {
    placeId: startPlace,
    path: [],
    hackRange: 95,
    drone: { deployed: false, placeId: startPlace, battery: 1, range: 190 },
    skills: new Set<string>(["deep_crawler"]),
    breachedNodeIds: new Set<string>(),
    badges: [],
    items: [],
  };

  const trace: TraceState = {
    level: 0,
    evidence: 0,
    investigating: false,
    investigationEndsAt: 0,
    reports: 0,
    lastActionAt: 0,
  };

  const state: GameState = {
    seed,
    time: options.startAt ?? at(0, 9, 20),
    city,
    npcs,
    rosters,
    log: new EventLog(),
    rng: new Rng(`${seed}:runtime`),
    player,
    trace,
    orders: new Map(),
    schedule: [],
    missions: [],
    cases: [],
    ledger: { helped: 0, exposed: 0, warned: 0, walkedPast: 0, scanned: 0 },
    counter: 0,
  };

  warmStart(state);
  seedMissionProps(state);
  installMissions(state);
  installCases(state);

  state.log.emit(state.time, {
    channel: "world",
    kind: "world.start",
    text: "You are on the plaza with a handset, a drone, and nobody's attention. Start looking.",
    subjects: [],
  });

  return state;
}

/**
 * Put everybody where their routine says they already are.
 *
 * Without this the world boots with all fifty-odd people standing in their
 * bedrooms at half nine in the morning, and the first several minutes of play
 * are spent watching the city walk to work. The city has been running for
 * years before you showed up; it should look like it.
 */
function warmStart(state: GameState): void {
  for (const person of state.npcs.values()) {
    const placeId = scheduledPlace(person, state.time);
    if (!state.city.graph.places.has(placeId)) continue;
    person.placeId = placeId;
    person.activity = blockAt(person, state.time)?.activity ?? "idle";
    // Anything on their person came with them.
    for (const nodeId of person.carrying) {
      const device = state.city.nodes.get(nodeId);
      if (device) device.placeId = placeId;
    }
  }
}

/**
 * Place the things missions care about. The prototype goes into the lab's
 * inventory case; the case is the only legitimate way it leaves the room, which
 * is what forces the requisition play rather than a smash-and-grab.
 */
function seedMissionProps(state: GameState): void {
  const labPlaceId = state.city.roomPlaceIds.get(TARGET_LAB_KEY);
  if (!labPlaceId) return;
  const cases = [...state.city.nodes.values()].filter(
    (n) => n.kind === "inventory_case" && n.placeId === labPlaceId,
  );
  const target = cases[0];
  if (target) {
    target.state["contents"] = ["Specimen A7 prototype chip"];
    target.state["locked"] = true;
    target.state["weightSensor"] = true;
    target.label = "Prototype case · Specimen A7";
  }
}

export { TARGET_BUILDING_ID, TARGET_LAB_KEY };
