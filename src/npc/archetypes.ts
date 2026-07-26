/**
 * Occupation archetypes.
 *
 * An archetype is a template for a life: where the person is at any hour, what
 * they are likely to be personally compromised by, and which personality dials
 * skew. The generator jitters everything, so two receptionists are never quite
 * the same problem to solve.
 */

import type { PlaceKind, SecurityZone } from "../world/types.js";
import type { SecretKind, TraitKey } from "./types.js";

export interface Archetype {
  id: string;
  title: string;
  /** Place kinds this person can be stationed at. */
  workPlaceKinds: PlaceKind[];
  /** Organisation kinds that hire them. */
  orgKinds: string[];
  clearance: SecurityZone;
  income: [number, number];
  /** Trait centres; the generator adds noise around these. */
  traitBias: Partial<Record<TraitKey, number>>;
  /** Work window in minutes-of-day. */
  shift: [number, number];
  /** True when abandoning the station is itself an event. */
  post: boolean;
  /** Moves between places during the shift instead of sitting still. */
  patrols: boolean;
  /** Relative likelihood of each secret kind, on top of the global baseline. */
  secretBias: Partial<Record<SecretKind, number>>;
  /** Occupation-specific flavour lines, mixed with the generic pool. */
  quirks: string[];
  /** How much weight this person carries when they report something. */
  authority: number;
  /** Population weight. */
  frequency: number;
}

const H = (h: number, m = 0) => h * 60 + m;

export const ARCHETYPES: Archetype[] = [
  {
    id: "receptionist",
    title: "Receptionist",
    workPlaceKinds: ["reception", "lobby"],
    orgKinds: ["startup", "corp", "civic"],
    clearance: "staff",
    income: [34000, 52000],
    traitBias: { diligence: 0.6, sociability: 0.75, techLiteracy: 0.4, anxiety: 0.5 },
    shift: [H(8, 30), H(17, 30)],
    post: true,
    patrols: false,
    secretBias: { debt: 2.2, moonlighting: 2.5, on_thin_ice: 1.4 },
    quirks: [
      "Screenshots every rude visitor and maintains a private hall of shame",
      "Has memorised the badge number of everyone who ever forgot theirs",
      "Keeps a drawer of confiscated novelty pens",
    ],
    authority: 0.35,
    frequency: 3,
  },
  {
    id: "lab_tech",
    title: "Lab Technician",
    workPlaceKinds: ["lab"],
    orgKinds: ["startup", "corp"],
    clearance: "restricted",
    income: [58000, 92000],
    traitBias: { diligence: 0.55, curiosity: 0.8, techLiteracy: 0.6, vanity: 0.45 },
    shift: [H(9), H(18)],
    post: false,
    patrols: false,
    secretBias: { obsession: 3.2, whistleblower: 1.6, moonlighting: 1.3 },
    quirks: [
      "Posts 4,000-word forum essays about obsolete hardware",
      "Names every piece of equipment after a Roman emperor",
      "Has an unfinished restoration project blocking their hallway",
    ],
    authority: 0.4,
    frequency: 4,
  },
  {
    id: "security_chief",
    title: "Head of Security",
    workPlaceKinds: ["lobby", "office", "corridor"],
    orgKinds: ["startup", "corp", "civic"],
    clearance: "restricted",
    income: [78000, 120000],
    traitBias: { diligence: 0.85, gullibility: 0.2, anxiety: 0.35, techLiteracy: 0.55 },
    shift: [H(8), H(18)],
    post: false,
    patrols: true,
    secretBias: { medical: 2.4, allergy: 3.0, record: 1.8, gambling: 1.5 },
    quirks: [
      "Eats the same lunch from the same place every single working day",
      "Reviews camera footage of their own team more than of visitors",
      "Has an encyclopedic and unwanted knowledge of fire code",
    ],
    authority: 1.0,
    frequency: 1,
  },
  {
    id: "guard",
    title: "Security Officer",
    workPlaceKinds: ["lobby", "corridor", "loading"],
    orgKinds: ["startup", "corp", "civic", "logistics"],
    clearance: "staff",
    income: [38000, 58000],
    traitBias: { diligence: 0.55, curiosity: 0.4, techLiteracy: 0.3, sociability: 0.4 },
    shift: [H(7), H(19)],
    post: true,
    patrols: true,
    secretBias: { debt: 2.0, gambling: 2.2, moonlighting: 2.0 },
    quirks: [
      "Doing an online degree one module at a time, very slowly",
      "Knows every vending machine in the district by reliability",
      "Keeps a paperback in the podium and denies it",
    ],
    authority: 0.7,
    frequency: 3,
  },
  {
    id: "engineer",
    title: "Software Engineer",
    workPlaceKinds: ["office", "meeting"],
    orgKinds: ["startup", "corp"],
    clearance: "staff",
    income: [95000, 180000],
    traitBias: { techLiteracy: 0.85, curiosity: 0.65, gullibility: 0.25, diligence: 0.5 },
    shift: [H(10), H(19)],
    post: false,
    patrols: false,
    secretBias: { whistleblower: 2.2, obsession: 1.6, substance: 1.2, moonlighting: 1.8 },
    quirks: [
      "Maintains a package that 400,000 projects depend on and nobody funds",
      "Has strong public opinions about tab width",
      "Runs a home server rack louder than a dishwasher",
    ],
    authority: 0.4,
    frequency: 5,
  },
  {
    id: "manager",
    title: "Operations Manager",
    workPlaceKinds: ["office", "meeting"],
    orgKinds: ["startup", "corp", "logistics", "retail"],
    clearance: "restricted",
    income: [88000, 150000],
    traitBias: { vanity: 0.7, curiosity: 0.7, diligence: 0.5, sociability: 0.6 },
    shift: [H(8, 30), H(18, 30)],
    post: false,
    patrols: false,
    secretBias: { embezzlement: 2.6, affair: 2.0, on_thin_ice: 1.8 },
    quirks: [
      "Reads every internal document they are not supposed to have",
      "Books meetings that could have been a message, on purpose",
      "Has a promotion timeline written on the back of a coaster",
    ],
    authority: 0.8,
    frequency: 2,
  },
  {
    // A bar does not run on office hours. Staffing a late-opening venue with
    // the 08:30 `manager` archetype leaves its back office empty every evening
    // the place is actually alive — which, on a mechanical door, means nobody
    // ever opens it and the room may as well not exist.
    id: "venue_manager",
    title: "Venue Manager",
    workPlaceKinds: ["office"],
    orgKinds: ["hospitality"],
    clearance: "restricted",
    income: [42000, 72000],
    traitBias: { diligence: 0.5, vanity: 0.6, greed: 0.6, sociability: 0.65, anxiety: 0.5 },
    shift: [H(19), H(3)],
    post: false,
    patrols: false,
    secretBias: { embezzlement: 3.2, gambling: 2.4, affair: 2.0, debt: 1.8 },
    quirks: [
      "Counts the till three times and still does not trust the number",
      "Has barred the same regular four times and readmitted them four times",
      "Keeps a second set of books that balances differently",
    ],
    authority: 0.75,
    frequency: 1,
  },
  {
    id: "exec",
    title: "Executive",
    workPlaceKinds: ["office", "meeting"],
    orgKinds: ["startup", "corp"],
    clearance: "restricted",
    income: [200000, 480000],
    traitBias: { vanity: 0.85, diligence: 0.4, gullibility: 0.45, techLiteracy: 0.3 },
    shift: [H(9), H(17)],
    post: false,
    patrols: false,
    secretBias: { affair: 2.6, embezzlement: 2.4, substance: 1.6 },
    quirks: [
      "Has a media training habit of repeating the question back",
      "Owns a boat they have used twice",
      "Forwards their own press coverage to their family group chat",
    ],
    authority: 0.95,
    frequency: 1,
  },
  {
    id: "janitor",
    title: "Facilities Technician",
    workPlaceKinds: ["corridor", "storage", "restroom", "breakroom"],
    orgKinds: ["startup", "corp", "civic", "hospitality"],
    clearance: "staff",
    income: [32000, 46000],
    traitBias: { diligence: 0.65, sociability: 0.5, techLiteracy: 0.25, curiosity: 0.35 },
    shift: [H(18), H(2)],
    post: false,
    patrols: true,
    secretBias: { immigration: 2.0, family_crisis: 2.2, moonlighting: 2.4 },
    quirks: [
      "Knows which doors do not actually latch and has told nobody",
      "Has worked here longer than anyone on the leadership team",
      "Feeds a stray cat behind the loading bay",
    ],
    authority: 0.3,
    frequency: 2,
  },
  {
    id: "bartender",
    title: "Bartender",
    workPlaceKinds: ["bar"],
    orgKinds: ["hospitality"],
    clearance: "staff",
    income: [36000, 62000],
    traitBias: { sociability: 0.85, curiosity: 0.55, anxiety: 0.35, techLiteracy: 0.45 },
    shift: [H(20), H(4)],
    post: true,
    patrols: false,
    secretBias: { affair: 2.4, substance: 2.0, debt: 1.8 },
    quirks: [
      "Remembers every drink order and no single name",
      "Writing a screenplay assembled entirely from overheard arguments",
      "Has an encyclopedic memory for who left with whom",
    ],
    authority: 0.35,
    frequency: 2,
  },
  {
    id: "barista",
    title: "Barista",
    workPlaceKinds: ["cafe"],
    orgKinds: ["hospitality", "retail"],
    clearance: "staff",
    income: [28000, 40000],
    traitBias: { sociability: 0.7, curiosity: 0.6, anxiety: 0.45, techLiteracy: 0.5 },
    shift: [H(6), H(14)],
    post: true,
    patrols: false,
    secretBias: { moonlighting: 2.6, debt: 1.8, family_crisis: 1.4 },
    quirks: [
      "Deliberately misspells the names of rude customers",
      "Three semesters from a degree they will not finish",
      "Can identify the office someone works at from their order",
    ],
    authority: 0.2,
    frequency: 3,
  },
  {
    id: "courier",
    title: "Delivery Courier",
    workPlaceKinds: ["street", "loading", "lobby"],
    orgKinds: ["logistics"],
    clearance: "semi",
    income: [30000, 48000],
    traitBias: { diligence: 0.45, sociability: 0.45, techLiteracy: 0.4, anxiety: 0.4 },
    shift: [H(10), H(22)],
    post: false,
    patrols: true,
    secretBias: { debt: 2.4, immigration: 1.8, record: 1.4 },
    quirks: [
      "Rates every building's loading bay out of ten in a private notes app",
      "Has been bitten by the same dog on three separate routes",
      "Keeps a stash of other people's forgotten umbrellas",
    ],
    authority: 0.2,
    frequency: 3,
  },
  {
    id: "nurse",
    title: "Nurse Practitioner",
    workPlaceKinds: ["clinic"],
    orgKinds: ["civic"],
    clearance: "restricted",
    income: [72000, 110000],
    traitBias: { diligence: 0.8, anxiety: 0.4, sociability: 0.6, techLiteracy: 0.5 },
    shift: [H(7), H(19)],
    post: true,
    patrols: false,
    secretBias: { family_crisis: 2.0, debt: 1.6, whistleblower: 1.8 },
    quirks: [
      "Diagnoses strangers on public transport, silently, for practice",
      "Has not taken a full weekend off in fourteen months",
      "Carries a second phone for the ward that never stops buzzing",
    ],
    authority: 0.6,
    frequency: 1,
  },
  {
    id: "clerk",
    title: "Retail Clerk",
    workPlaceKinds: ["shop"],
    orgKinds: ["retail"],
    clearance: "staff",
    income: [29000, 42000],
    traitBias: { sociability: 0.6, curiosity: 0.5, diligence: 0.45, techLiteracy: 0.45 },
    shift: [H(9), H(18)],
    post: true,
    patrols: false,
    secretBias: { debt: 2.0, moonlighting: 2.0, record: 1.2 },
    quirks: [
      "Has strong theories about which customers are shoplifting and is usually wrong",
      "Rearranges the window display for their own amusement",
      "Knows the exact till total by feel",
    ],
    authority: 0.2,
    frequency: 2,
  },
  {
    id: "resident",
    title: "Resident",
    workPlaceKinds: ["apartment", "park", "cafe"],
    orgKinds: ["residential"],
    clearance: "public",
    income: [20000, 90000],
    traitBias: { sociability: 0.5, curiosity: 0.5, diligence: 0.45 },
    shift: [H(9), H(17)],
    post: false,
    patrols: false,
    secretBias: {},
    quirks: [],
    authority: 0.1,
    frequency: 8,
  },
];

export function archetype(id: string): Archetype {
  const found = ARCHETYPES.find((a) => a.id === id);
  if (!found) throw new Error(`Unknown archetype: ${id}`);
  return found;
}
