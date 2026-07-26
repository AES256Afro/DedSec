/**
 * Hand-authored city blueprint.
 *
 * The district and building layout is fixed so that missions can name a
 * specific lab on a specific floor; everything inside — room adjacency, device
 * placement, the entire population — is generated from the seed. Designed
 * bones, procedural flesh.
 */

import type { PlaceKind, SecurityZone } from "./types.js";

export interface RoomSpec {
  key: string;
  name: string;
  kind: PlaceKind;
  zone: SecurityZone;
  /** Offsets within the building footprint, 0..1. */
  u: number;
  v: number;
  /** Rooms on the same floor that are directly connected; corridor is implicit. */
  connects?: string[];
  /** A controlled door guards entry to this room. */
  door?: { lock: "badge" | "electronic" | "biometric" | "mechanical"; clearance: SecurityZone };
  /** Rooms you can see into from the corridor (glass walls). */
  glass?: boolean;
}

export interface FloorSpec {
  floor: number;
  rooms: RoomSpec[];
}

export interface BuildingSpec {
  id: string;
  name: string;
  orgId: string;
  orgName: string;
  orgKind: "startup" | "corp" | "civic" | "hospitality" | "logistics" | "retail" | "residential";
  districtId: string;
  x: number;
  y: number;
  width: number;
  depth: number;
  securityPosture: number;
  floors: FloorSpec[];
  /** Street place this building's entrance opens onto. */
  entranceStreetKey: string;
  entranceLock: "none" | "badge" | "electronic";
  /** Headcount targets per archetype id. */
  staffing: Array<{ archetypeId: string; count: number }>;
}

export interface StreetSpec {
  key: string;
  name: string;
  kind: PlaceKind;
  districtId: string;
  x: number;
  y: number;
  connects: string[];
}

export interface DistrictSpec {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  footTraffic: number;
}

export const DISTRICTS: DistrictSpec[] = [
  { id: "d_foundry", name: "Foundry Block", x: 0, y: 0, width: 900, height: 620, footTraffic: 0.7 },
  { id: "d_marina", name: "Marina Row", x: 900, y: 0, width: 700, height: 620, footTraffic: 0.9 },
  { id: "d_civic", name: "Civic Spine", x: 0, y: 620, width: 900, height: 560, footTraffic: 0.6 },
  { id: "d_terrace", name: "Terrace Hill", x: 900, y: 620, width: 700, height: 560, footTraffic: 0.4 },
];

export const STREETS: StreetSpec[] = [
  { key: "s_foundry_w", name: "Foundry St (west)", kind: "street", districtId: "d_foundry", x: 120, y: 300, connects: ["s_foundry_mid", "s_civic_w"] },
  { key: "s_foundry_mid", name: "Foundry St", kind: "street", districtId: "d_foundry", x: 430, y: 300, connects: ["s_foundry_e", "s_foundry_plaza"] },
  { key: "s_foundry_plaza", name: "Kettle Plaza", kind: "plaza", districtId: "d_foundry", x: 555, y: 150, connects: [] },
  { key: "s_foundry_alley", name: "Service Alley", kind: "alley", districtId: "d_foundry", x: 620, y: 470, connects: ["s_foundry_mid", "s_foundry_e"] },
  { key: "s_foundry_e", name: "Foundry St (east)", kind: "street", districtId: "d_foundry", x: 800, y: 300, connects: ["s_marina_w"] },
  { key: "s_marina_w", name: "Marina Row (west)", kind: "street", districtId: "d_marina", x: 1050, y: 300, connects: ["s_marina_e"] },
  { key: "s_marina_e", name: "Marina Row (east)", kind: "street", districtId: "d_marina", x: 1420, y: 300, connects: ["s_terrace_n"] },
  { key: "s_civic_w", name: "Civic Way (west)", kind: "street", districtId: "d_civic", x: 160, y: 880, connects: ["s_civic_e"] },
  { key: "s_civic_e", name: "Civic Way (east)", kind: "street", districtId: "d_civic", x: 620, y: 880, connects: ["s_civic_park", "s_terrace_n"] },
  { key: "s_civic_park", name: "Reservoir Green", kind: "park", districtId: "d_civic", x: 620, y: 1080, connects: [] },
  { key: "s_terrace_n", name: "Terrace Hill (north)", kind: "street", districtId: "d_terrace", x: 1120, y: 665, connects: ["s_terrace_s"] },
  { key: "s_terrace_s", name: "Terrace Hill (south)", kind: "street", districtId: "d_terrace", x: 1160, y: 1085, connects: [] },
];

/** Shared upper-floor office plan, reused with different room names per floor. */
function officeFloor(floor: number, prefix: string): FloorSpec {
  return {
    floor,
    rooms: [
      { key: `${prefix}_corridor`, name: `Floor ${floor} corridor`, kind: "corridor", zone: "staff", u: 0.5, v: 0.5 },
      { key: `${prefix}_open`, name: `Floor ${floor} open plan`, kind: "office", zone: "staff", u: 0.24, v: 0.32, glass: true },
      { key: `${prefix}_meeting`, name: `Floor ${floor} meeting room`, kind: "meeting", zone: "staff", u: 0.76, v: 0.28, glass: true },
      { key: `${prefix}_break`, name: `Floor ${floor} break area`, kind: "breakroom", zone: "staff", u: 0.78, v: 0.72 },
      { key: `${prefix}_wc`, name: `Floor ${floor} restrooms`, kind: "restroom", zone: "staff", u: 0.2, v: 0.76 },
    ],
  };
}

export const BUILDINGS: BuildingSpec[] = [
  {
    id: "b_nodalis",
    name: "Nodalis Labs",
    orgId: "org_nodalis",
    orgName: "Nodalis Labs",
    orgKind: "startup",
    districtId: "d_foundry",
    x: 180,
    y: 60,
    width: 260,
    depth: 190,
    securityPosture: 0.68,
    entranceStreetKey: "s_foundry_plaza",
    entranceLock: "none",
    staffing: [
      { archetypeId: "receptionist", count: 1 },
      { archetypeId: "security_chief", count: 1 },
      { archetypeId: "guard", count: 2 },
      { archetypeId: "lab_tech", count: 3 },
      { archetypeId: "engineer", count: 5 },
      { archetypeId: "manager", count: 2 },
      { archetypeId: "exec", count: 1 },
      { archetypeId: "janitor", count: 1 },
    ],
    floors: [
      {
        floor: 0,
        rooms: [
          { key: "n0_lobby", name: "Nodalis lobby", kind: "lobby", zone: "public", u: 0.5, v: 0.82 },
          { key: "n0_reception", name: "Reception desk", kind: "reception", zone: "semi", u: 0.5, v: 0.56, connects: ["n0_lobby"], glass: true },
          { key: "n0_corridor", name: "Ground corridor", kind: "corridor", zone: "staff", u: 0.5, v: 0.34, connects: ["n0_reception"], door: { lock: "badge", clearance: "staff" } },
          { key: "n0_security", name: "Security office", kind: "office", zone: "restricted", u: 0.18, v: 0.2, door: { lock: "badge", clearance: "restricted" } },
          { key: "n0_mail", name: "Mailroom", kind: "storage", zone: "staff", u: 0.82, v: 0.2 },
          { key: "n0_loading", name: "Loading bay", kind: "loading", zone: "staff", u: 0.9, v: 0.5, connects: ["n0_mail"], door: { lock: "electronic", clearance: "staff" } },
        ],
      },
      officeFloor(1, "n1"),
      officeFloor(2, "n2"),
      {
        floor: 3,
        rooms: [
          { key: "n3_corridor", name: "Floor 3 corridor", kind: "corridor", zone: "staff", u: 0.5, v: 0.5 },
          { key: "n3_open", name: "Engineering floor", kind: "office", zone: "staff", u: 0.24, v: 0.3, glass: true },
          { key: "n3_server", name: "Server room", kind: "server", zone: "restricted", u: 0.8, v: 0.28, door: { lock: "badge", clearance: "restricted" } },
          { key: "n3_break", name: "Floor 3 break area", kind: "breakroom", zone: "staff", u: 0.76, v: 0.74 },
          { key: "n3_wc", name: "Floor 3 restrooms", kind: "restroom", zone: "staff", u: 0.2, v: 0.78 },
        ],
      },
      {
        floor: 4,
        rooms: [
          { key: "n4_corridor", name: "Lab corridor", kind: "corridor", zone: "staff", u: 0.5, v: 0.62 },
          { key: "n4_lab", name: "Prototype lab", kind: "lab", zone: "restricted", u: 0.32, v: 0.3, door: { lock: "badge", clearance: "restricted" }, glass: true },
          { key: "n4_biocontain", name: "Bio-containment 2", kind: "storage", zone: "restricted", u: 0.74, v: 0.26, door: { lock: "electronic", clearance: "restricted" } },
          { key: "n4_prep", name: "Lab prep room", kind: "storage", zone: "staff", u: 0.76, v: 0.72 },
          { key: "n4_wc", name: "Floor 4 restrooms", kind: "restroom", zone: "staff", u: 0.2, v: 0.8 },
        ],
      },
    ],
  },
  {
    id: "b_helix",
    name: "Helix Tower",
    orgId: "org_helix",
    orgName: "Helix Capital",
    orgKind: "corp",
    districtId: "d_foundry",
    x: 640,
    y: 90,
    width: 200,
    depth: 160,
    securityPosture: 0.8,
    entranceStreetKey: "s_foundry_e",
    entranceLock: "badge",
    staffing: [
      { archetypeId: "receptionist", count: 1 },
      { archetypeId: "guard", count: 2 },
      { archetypeId: "manager", count: 2 },
      { archetypeId: "exec", count: 2 },
      { archetypeId: "engineer", count: 2 },
    ],
    floors: [
      {
        floor: 0,
        rooms: [
          { key: "h0_lobby", name: "Helix lobby", kind: "lobby", zone: "semi", u: 0.5, v: 0.8 },
          { key: "h0_reception", name: "Helix reception", kind: "reception", zone: "semi", u: 0.5, v: 0.5, connects: ["h0_lobby"], glass: true },
          { key: "h0_corridor", name: "Helix ground corridor", kind: "corridor", zone: "staff", u: 0.5, v: 0.24, connects: ["h0_reception"], door: { lock: "badge", clearance: "staff" } },
        ],
      },
      officeFloor(1, "h1"),
      officeFloor(2, "h2"),
    ],
  },
  {
    id: "b_kettle",
    name: "Kettle & Coil",
    orgId: "org_kettle",
    orgName: "Kettle & Coil Coffee",
    orgKind: "hospitality",
    districtId: "d_foundry",
    x: 260,
    y: 380,
    width: 150,
    depth: 110,
    securityPosture: 0.15,
    entranceStreetKey: "s_foundry_mid",
    entranceLock: "none",
    staffing: [{ archetypeId: "barista", count: 2 }],
    floors: [
      {
        floor: 0,
        rooms: [
          { key: "k0_floor", name: "Kettle & Coil floor", kind: "cafe", zone: "public", u: 0.42, v: 0.6 },
          { key: "k0_counter", name: "Kettle & Coil counter", kind: "cafe", zone: "semi", u: 0.72, v: 0.35, connects: ["k0_floor"] },
          { key: "k0_back", name: "Kettle back room", kind: "storage", zone: "staff", u: 0.2, v: 0.25, connects: ["k0_counter"], door: { lock: "mechanical", clearance: "staff" } },
        ],
      },
    ],
  },
  {
    id: "b_lantern",
    name: "The Paper Lantern",
    orgId: "org_lantern",
    orgName: "Paper Lantern Bar",
    orgKind: "hospitality",
    districtId: "d_marina",
    x: 1000,
    y: 150,
    width: 170,
    depth: 130,
    securityPosture: 0.25,
    entranceStreetKey: "s_marina_w",
    entranceLock: "none",
    // The manager works out of the back office, which is what makes that room
    // enterable at all: they go in and out and leave a mechanical door open
    // behind them. Without somebody rostered to that room there is no gap, and
    // the Back Room contract has no solution.
    staffing: [
      { archetypeId: "bartender", count: 2 },
      { archetypeId: "venue_manager", count: 1 },
      { archetypeId: "guard", count: 1 },
    ],
    floors: [
      {
        floor: 0,
        rooms: [
          { key: "l0_floor", name: "Lantern floor", kind: "bar", zone: "public", u: 0.45, v: 0.62 },
          { key: "l0_bar", name: "Lantern bar", kind: "bar", zone: "semi", u: 0.72, v: 0.34, connects: ["l0_floor"] },
          { key: "l0_office", name: "Lantern back office", kind: "office", zone: "staff", u: 0.18, v: 0.26, connects: ["l0_bar"], door: { lock: "mechanical", clearance: "staff" } },
        ],
      },
    ],
  },
  {
    id: "b_meridian",
    name: "Meridian Clinic",
    orgId: "org_meridian",
    orgName: "Meridian Community Clinic",
    orgKind: "civic",
    districtId: "d_civic",
    x: 180,
    y: 700,
    width: 210,
    depth: 150,
    securityPosture: 0.5,
    entranceStreetKey: "s_civic_w",
    entranceLock: "none",
    staffing: [
      { archetypeId: "nurse", count: 2 },
      { archetypeId: "receptionist", count: 1 },
    ],
    floors: [
      {
        floor: 0,
        rooms: [
          { key: "m0_waiting", name: "Clinic waiting room", kind: "clinic", zone: "public", u: 0.4, v: 0.75 },
          { key: "m0_desk", name: "Clinic front desk", kind: "reception", zone: "semi", u: 0.68, v: 0.5, connects: ["m0_waiting"] },
          { key: "m0_ward", name: "Treatment ward", kind: "clinic", zone: "restricted", u: 0.3, v: 0.25, connects: ["m0_desk"], door: { lock: "badge", clearance: "restricted" } },
          { key: "m0_records", name: "Records room", kind: "storage", zone: "restricted", u: 0.78, v: 0.2, door: { lock: "electronic", clearance: "restricted" } },
        ],
      },
    ],
  },
  {
    id: "b_depot",
    name: "Rowan Freight Depot",
    orgId: "org_rowan",
    orgName: "Rowan Freight",
    orgKind: "logistics",
    districtId: "d_civic",
    x: 560,
    y: 700,
    width: 230,
    depth: 140,
    securityPosture: 0.35,
    entranceStreetKey: "s_civic_e",
    entranceLock: "none",
    staffing: [
      { archetypeId: "courier", count: 4 },
      { archetypeId: "manager", count: 1 },
      { archetypeId: "guard", count: 1 },
    ],
    floors: [
      {
        floor: 0,
        rooms: [
          { key: "r0_yard", name: "Depot yard", kind: "loading", zone: "semi", u: 0.35, v: 0.7 },
          { key: "r0_dispatch", name: "Dispatch office", kind: "office", zone: "staff", u: 0.72, v: 0.4, connects: ["r0_yard"], door: { lock: "mechanical", clearance: "staff" } },
          { key: "r0_store", name: "Parcel store", kind: "storage", zone: "staff", u: 0.22, v: 0.3, connects: ["r0_yard"] },
        ],
      },
    ],
  },
  {
    id: "b_grove",
    name: "Grove Court",
    orgId: "org_grove",
    orgName: "Grove Court Residences",
    orgKind: "residential",
    districtId: "d_terrace",
    x: 1040,
    y: 720,
    width: 220,
    depth: 160,
    securityPosture: 0.3,
    entranceStreetKey: "s_terrace_n",
    entranceLock: "electronic",
    staffing: [],
    floors: [
      {
        floor: 0,
        rooms: [
          { key: "g0_lobby", name: "Grove Court lobby", kind: "lobby", zone: "semi", u: 0.5, v: 0.78 },
          { key: "g0_corridor", name: "Grove ground corridor", kind: "corridor", zone: "semi", u: 0.5, v: 0.4, connects: ["g0_lobby"] },
          { key: "g0_a", name: "Apartment 1A", kind: "apartment", zone: "restricted", u: 0.2, v: 0.2, door: { lock: "electronic", clearance: "restricted" } },
          { key: "g0_b", name: "Apartment 1B", kind: "apartment", zone: "restricted", u: 0.8, v: 0.2, door: { lock: "electronic", clearance: "restricted" } },
        ],
      },
      {
        floor: 1,
        rooms: [
          { key: "g1_corridor", name: "Grove floor 2 corridor", kind: "corridor", zone: "semi", u: 0.5, v: 0.5 },
          { key: "g1_a", name: "Apartment 2A", kind: "apartment", zone: "restricted", u: 0.2, v: 0.22, door: { lock: "electronic", clearance: "restricted" } },
          { key: "g1_b", name: "Apartment 2B", kind: "apartment", zone: "restricted", u: 0.8, v: 0.22, door: { lock: "electronic", clearance: "restricted" } },
          { key: "g1_c", name: "Apartment 2C", kind: "apartment", zone: "restricted", u: 0.2, v: 0.78, door: { lock: "electronic", clearance: "restricted" } },
          { key: "g1_d", name: "Apartment 2D", kind: "apartment", zone: "restricted", u: 0.8, v: 0.78, door: { lock: "electronic", clearance: "restricted" } },
        ],
      },
    ],
  },
  {
    id: "b_vault",
    name: "Vault Vintage Tech",
    orgId: "org_vault",
    orgName: "Vault Vintage Tech",
    orgKind: "retail",
    districtId: "d_terrace",
    x: 1240,
    y: 980,
    width: 150,
    depth: 110,
    securityPosture: 0.2,
    entranceStreetKey: "s_terrace_s",
    entranceLock: "none",
    staffing: [{ archetypeId: "clerk", count: 1 }],
    floors: [
      {
        floor: 0,
        rooms: [
          { key: "v0_floor", name: "Vault shop floor", kind: "shop", zone: "public", u: 0.45, v: 0.6 },
          { key: "v0_back", name: "Vault stockroom", kind: "storage", zone: "staff", u: 0.75, v: 0.25, connects: ["v0_floor"], door: { lock: "mechanical", clearance: "staff" } },
        ],
      },
    ],
  },
];

/** The building the flagship contract targets. */
export const TARGET_BUILDING_ID = "b_nodalis";
export const TARGET_LAB_KEY = "n4_lab";
