/**
 * The contract board.
 *
 * Each mission states what has to become true and says nothing about how. The
 * predicates below deliberately read world state that many different plays can
 * produce — "the lab has no staff in it" does not care whether you emptied it
 * with a forged auction, a work order, an HVAC surge or simple patience.
 */

import { ghostReport } from "../../hack/trace.js";
import { TARGET_BUILDING_ID, TARGET_LAB_KEY } from "../../world/blueprint.js";
import type { GameState } from "../../sim/state.js";
import type { Mission } from "../runtime.js";

/* ----------------------------------------------------------- shared probes */

function labPlaceId(state: GameState): string | undefined {
  return state.city.roomPlaceIds.get(TARGET_LAB_KEY);
}

function staffOf(state: GameState, orgId: string) {
  return [...state.npcs.values()].filter((n) => n.orgId === orgId);
}

function holdsItem(state: GameState, fragment: string): boolean {
  return state.player.items.some((i) => i.label.toLowerCase().includes(fragment.toLowerCase()));
}

function playerOutsideBuilding(state: GameState, buildingId: string): boolean {
  const here = state.city.graph.places.get(state.player.placeId);
  return !!here && here.buildingId !== buildingId;
}

function profiledToLayer(state: GameState, layer: number, minCount: number, orgId?: string): boolean {
  const pool = orgId ? staffOf(state, orgId) : [...state.npcs.values()];
  return pool.filter((n) => n.profileLayer >= layer).length >= minCount;
}

/* ------------------------------------------------------------- 1. tutorial */

const PATTERN_OF_LIFE: Mission = {
  id: "pattern_of_life",
  title: "Pattern of Life",
  client: "Self-directed",
  brief:
    "Before you touch anything that matters, learn to read a street. Profile the people around Foundry Block, get inside a handset, and link what you find to a second source until someone's private life falls open.",
  constraint: "Nothing here needs a single door opened. Everything you need is already broadcasting.",
  objectives: [
    {
      id: "scan_six",
      label: "Passively profile six people",
      hint: "Line of sight is enough. Cameras count — pilot one.",
      done: (state) => [...state.npcs.values()].filter((n) => n.revealedFields.has("identity")).length >= 6,
    },
    {
      id: "first_handset",
      label: "Breach a handset and reach layer 1 on someone",
      hint: "You need to be inside their radio range, or chain through a junction box.",
      done: (state) => profiledToLayer(state, 1, 1),
    },
    {
      id: "cross_source",
      label: "Reach layer 2 on someone by linking a second source",
      hint: "Their home network, their employer's records, or the clinic on Civic Way.",
      done: (state) => profiledToLayer(state, 2, 1),
    },
    {
      id: "surface_secret",
      label: "Surface a secret worth acting on",
      done: (state) => [...state.npcs.values()].some((n) => n.secrets.some((s) => s.revealed && s.weight > 0.4)),
    },
  ],
  accolades: [
    {
      id: "unnoticed",
      label: "Nobody noticed",
      met: (state) => [...state.npcs.values()].every((n) => n.suspicion < 0.25),
    },
    { id: "cold", label: "Trace never crossed 20%", met: (state) => state.trace.level < 0.2 },
  ],
};

/* --------------------------------------------------------- 2. the back room */

const BACK_ROOM: Mission = {
  id: "back_room",
  title: "The Back Room",
  client: "A very tired accountant",
  brief:
    "The Paper Lantern's back office holds a ledger someone would rather stayed unread. Get into that room during opening hours, while the bar is staffed, without anybody deciding you were a problem.",
  constraint:
    "The door is mechanical — no lock to hack. You do not get in by beating the door. You get in by arranging for the person with the key to be somewhere else, and for nobody to be looking at the gap.",
  requires: ["pattern_of_life"],
  objectives: [
    {
      id: "know_the_bar",
      label: "Reach layer 2 on a member of the Lantern's staff",
      done: (state) => profiledToLayer(state, 2, 1, "org_lantern"),
    },
    {
      id: "clear_the_bar",
      label: "Get the bar staff away from the back office",
      hint: "Anyone with staff clearance standing in the bar is a witness.",
      done: (state) => {
        const office = state.city.roomPlaceIds.get("l0_office");
        const bar = state.city.roomPlaceIds.get("l0_bar");
        if (!office || !bar) return false;
        return !staffOf(state, "org_lantern").some((n) => n.placeId === bar || n.placeId === office);
      },
    },
    {
      id: "inside",
      label: "Stand in the Lantern back office",
      done: (state) => state.player.placeId === state.city.roomPlaceIds.get("l0_office"),
    },
  ],
  accolades: [
    {
      id: "no_alarm",
      label: "No alarm, no evacuation",
      met: (state) => !state.log.all().some((e) => e.kind === "security.alarm"),
    },
    {
      id: "no_rejects",
      label: "Every play landed first time",
      met: (state) => !state.log.all().some((e) => e.kind === "npc.impulse_rejected"),
    },
  ],
};

/* ------------------------------------------------------ 3. the ghost shift */

const GHOST_SHIFT: Mission = {
  id: "ghost_shift",
  title: "Ghost Shift",
  client: "Rowan Freight (unwittingly)",
  brief:
    "Nodalis runs a security chief who has never once left his rounds early. Prove he can be moved — get him off site during his shift — and leave him with no reason to think anything was done to him.",
  constraint:
    "He is the single most sceptical person in the district. A crude pretext will bounce, and a bounced pretext makes him twice as hard for the rest of the day. Read him properly before you push.",
  requires: ["pattern_of_life"],
  objectives: [
    {
      id: "read_the_chief",
      label: "Reach layer 2 on the Nodalis head of security",
      done: (state) =>
        staffOf(state, "org_nodalis").some((n) => n.archetypeId === "security_chief" && n.profileLayer >= 2),
    },
    {
      id: "move_him",
      label: "Get him off the Nodalis site during his shift",
      done: (state) =>
        staffOf(state, "org_nodalis").some(
          (n) =>
            n.archetypeId === "security_chief" &&
            (n.condition === "off_site" ||
              n.condition === "hospitalised" ||
              state.city.graph.places.get(n.placeId)?.buildingId !== TARGET_BUILDING_ID),
        ),
    },
    {
      id: "clean_read",
      label: "He never saw through a single thing you sent him",
      done: (state) => {
        const chief = staffOf(state, "org_nodalis").find((n) => n.archetypeId === "security_chief");
        if (!chief) return false;
        const moved = chief.condition === "off_site" ||
          chief.condition === "hospitalised" ||
          state.city.graph.places.get(chief.placeId)?.buildingId !== TARGET_BUILDING_ID;
        return moved && chief.suspicion < 0.3;
      },
    },
  ],
  accolades: [
    {
      id: "no_medical",
      label: "Nobody ended up in an ambulance",
      met: (state) => !state.log.all().some((e) => e.kind === "npc.medical_episode"),
    },
    { id: "quiet", label: "No investigation opened", met: (state) => state.trace.reports === 0 },
  ],
};

/* ------------------------------------------------- 4. the flagship contract */

const PROTOTYPE_CHIP: Mission = {
  id: "prototype_chip",
  title: "Specimen A7",
  client: "An anonymous broker",
  brief:
    "Nodalis Labs, fourth floor, prototype lab. A chip sits in a weight-sensing case that alarms the moment anything lifts it. The broker wants the chip. The broker also wants Nodalis to spend three weeks arguing internally about who misplaced it.",
  constraint:
    "Do not take it off the shelf. The building has a legitimate procedure for moving that chip out of that case, and a valid user is allowed to invoke it. Be a valid user.",
  requires: ["pattern_of_life"],
  objectives: [
    {
      id: "recon",
      label: "Reach layer 2 on two Nodalis staff",
      hint: "The receptionist, a lab tech and the security chief are the three people between you and the fourth floor.",
      done: (state) => profiledToLayer(state, 2, 2, "org_nodalis"),
    },
    {
      id: "clearance",
      label: "Hold restricted clearance for the building",
      hint: "Somebody with lab access carries their credential on a device.",
      done: (state) =>
        state.player.badges.some(
          (b) => b.orgId === "org_nodalis" && b.clearance === "restricted" && b.expiresAt > state.time,
        ) || state.player.breachedNodeIds.size > 0 && labIsOpenToPlayer(state),
    },
    {
      id: "lab_clear",
      label: "Empty the prototype lab of staff",
      hint: "Anyone standing in that room will watch the case open.",
      done: (state) => {
        const lab = labPlaceId(state);
        if (!lab) return false;
        return ![...state.npcs.values()].some((n) => n.placeId === lab && n.orgId === "org_nodalis");
      },
    },
    {
      id: "case_open",
      label: "Get the chip out of the case without lifting it",
      hint: "Raise a transfer order. The building will carry it for you.",
      done: (state) =>
        [...state.orders.values()].some(
          (o) => o.kind === "requisition" && o.label.toLowerCase().includes("prototype"),
        ),
    },
    {
      id: "collect",
      label: "Take possession of Specimen A7",
      done: (state) => holdsItem(state, "prototype"),
    },
    {
      id: "exfil",
      label: "Leave the Nodalis building",
      done: (state) => holdsItem(state, "prototype") && playerOutsideBuilding(state, TARGET_BUILDING_ID),
    },
  ],
  accolades: [
    {
      id: "ghost",
      label: "Ghost — logs read as a normal working day",
      met: (state) => ghostGrade(state) === "ghost",
    },
    {
      id: "no_harm",
      label: "Nobody was hurt",
      met: (state) => !state.log.all().some((e) => e.kind === "npc.medical_episode"),
    },
    {
      id: "no_alarm",
      label: "No alarm was raised",
      met: (state) => !state.log.all().some((e) => e.kind === "security.alarm"),
    },
    {
      id: "procedural",
      label: "The chip left the case by a procedure the building approved",
      met: (state) =>
        state.log.all().some((e) => e.kind === "inventory.requisitioned") &&
        !state.log.all().some((e) => e.kind === "security.alarm"),
    },
    {
      id: "unbelieved_never",
      label: "Nobody ever doubted you",
      met: (state) => !state.log.all().some((e) => e.kind === "npc.impulse_rejected"),
    },
  ],
};

/** The player is standing in the lab, however they got there. */
function labIsOpenToPlayer(state: GameState): boolean {
  const lab = labPlaceId(state);
  return !!lab && state.player.placeId === lab;
}

function ghostGrade(state: GameState): string {
  return ghostReport(state).grade;
}

export const MISSIONS: Mission[] = [PATTERN_OF_LIFE, BACK_ROOM, GHOST_SHIFT, PROTOTYPE_CHIP];
