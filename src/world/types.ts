/**
 * Spatial and network types.
 *
 * Space is a graph, not a physics sim. Every position in the game is either a
 * `Place` (a node) or a point interpolated along an `Edge` between two places.
 * That is enough fidelity for line-of-sight, room occupancy, camera cones and
 * "who is standing between you and the stairwell", and it keeps the whole world
 * deterministic and cheap to step.
 */

export type PlaceId = string;
export type EdgeId = string;
export type DoorId = string;
export type BuildingId = string;
export type DistrictId = string;
export type NodeId = string;
export type SubnetId = string;

/** How much authority you need to be standing somewhere without raising eyebrows. */
export type SecurityZone = "public" | "semi" | "staff" | "restricted";

export const ZONE_RANK: Record<SecurityZone, number> = {
  public: 0,
  semi: 1,
  staff: 2,
  restricted: 3,
};

export type PlaceKind =
  | "street"
  | "plaza"
  | "alley"
  | "rooftop"
  | "lobby"
  | "reception"
  | "office"
  | "meeting"
  | "lab"
  | "server"
  | "storage"
  | "breakroom"
  | "restroom"
  | "stairwell"
  | "elevator"
  | "corridor"
  | "loading"
  | "cafe"
  | "bar"
  | "gym"
  | "shop"
  | "clinic"
  | "apartment"
  | "park";

export interface Place {
  id: PlaceId;
  name: string;
  kind: PlaceKind;
  /** World-space metres. */
  x: number;
  y: number;
  /** 0 = ground. Rendering slices by floor; movement between floors needs stairs. */
  floor: number;
  indoor: boolean;
  buildingId?: BuildingId;
  districtId: DistrictId;
  zone: SecurityZone;
  /** Rough footprint radius, used for drawing and for crowd density. */
  radius: number;
  /** Places that are visually open to this one (no wall between) — cheap LOS. */
  sightlines: PlaceId[];
}

export interface Edge {
  id: EdgeId;
  a: PlaceId;
  b: PlaceId;
  /** Traversal cost in world-minutes for an unhurried adult. */
  minutes: number;
  doorId?: DoorId;
  /** Stairs and elevators are the only edges that may change floor. */
  vertical: boolean;
}

export type LockKind = "none" | "mechanical" | "badge" | "electronic" | "biometric";

export interface Door {
  id: DoorId;
  name: string;
  lock: LockKind;
  locked: boolean;
  /** Badge clearance required when `lock === "badge"`. */
  clearance: SecurityZone;
  /** The hackable node that controls this door, if it is on the network. */
  nodeId?: NodeId;
  /** Set by a maintenance-lockout hack; nobody in or out until this instant. */
  jammedUntil?: number;
  /** True while a fire event has released the mag-locks. */
  failOpen: boolean;
  /**
   * When a mechanical door someone left open swings back to locked.
   *
   * People do not re-lock behind themselves. A mechanical door has no lock to
   * hack and no node to breach, so the *only* way through one is the gap
   * somebody else leaves — which is exactly the play the Back Room contract
   * asks for, and which did not exist until this field did.
   */
  relockAt?: number;
}

export interface Building {
  id: BuildingId;
  name: string;
  districtId: DistrictId;
  /** Owning organisation id; drives badge clearance and employee rosters. */
  orgId: string;
  x: number;
  y: number;
  width: number;
  depth: number;
  floors: number;
  placeIds: PlaceId[];
}

export interface District {
  id: DistrictId;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Ambient density; drives crowd size and how much noise cover you get. */
  footTraffic: number;
}

export interface Organisation {
  id: string;
  name: string;
  kind: "startup" | "corp" | "civic" | "hospitality" | "logistics" | "retail" | "residential";
  buildingId?: BuildingId;
  /** Rough security investment, 0..1. Raises trace rates and guard diligence. */
  securityPosture: number;
}

/* ------------------------------------------------------------------ network */

export type NodeKind =
  | "router" // subnet gateway; breaching it exposes the subnet
  | "relay" // extends your hack range (junction boxes, public wifi)
  | "camera"
  | "smart_lock"
  | "phone"
  | "laptop"
  | "terminal" // workstation with an account context
  | "speaker"
  | "display"
  | "light"
  | "scooter"
  | "car_alarm"
  | "vending"
  | "hvac"
  | "sprinkler"
  | "elevator"
  | "cleaning_bot"
  | "lab_arm"
  | "inventory_case"
  | "pa_system"
  | "printer"
  | "delivery_tablet";

/** What a node lets you do once you have access — verbs filter on these. */
export type NodeCapability =
  | "observe" // see through it
  | "actuate" // make it do something physical
  | "broadcast" // make noise / show a message
  | "records" // stores documents, logs, orders
  | "comms" // can send messages as its owner
  | "credentials" // holds a badge or login you can clone
  | "route"; // extends network reach

export interface NetworkNode {
  id: NodeId;
  label: string;
  kind: NodeKind;
  capabilities: NodeCapability[];
  placeId: PlaceId;
  subnetId: SubnetId;
  /** Owning NPC id for personal devices; org id for fixtures. */
  ownerId?: string;
  /** 0..1. Higher means a longer breach and a bigger trace spike. */
  hardening: number;
  /** Radio reach in metres for relays and for being hacked from a distance. */
  range: number;
  /** Player has cracked this node. */
  breached: boolean;
  /** Node is currently doing something the player told it to. */
  busyUntil?: number;
  /** Node-specific mutable state (light colour, camera pan, case unlocked...). */
  state: Record<string, unknown>;
  /** Physical devices can be carried; a forgotten phone stays where it was left. */
  portable: boolean;
  /** Powered-off or bricked nodes cannot be used by anyone, including the owner. */
  online: boolean;
}

export interface Subnet {
  id: SubnetId;
  name: string;
  buildingId?: BuildingId;
  orgId?: string;
  /** 0..1 firewall strength; the router's hardening floor. */
  firewall: number;
  /** True once the router has been breached: member nodes get much cheaper. */
  exposed: boolean;
  /** Rising counter that triggers an internal security audit. */
  anomalyScore: number;
}
