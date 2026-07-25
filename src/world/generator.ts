/**
 * Turns the blueprint into a live city: places, edges, doors, and the ctOS
 * device layer draped over the top of it.
 *
 * The network is deliberately *shaped like the building*. Devices sit in rooms,
 * rooms sit behind doors, and the router that exposes a subnet is usually in
 * the room you cannot reach yet. That is what makes chain-hacking through a
 * relay in the alley a real decision rather than a menu.
 */

import { Rng } from "../core/rng.js";
import { BUILDINGS, DISTRICTS, STREETS, type BuildingSpec, type RoomSpec } from "./blueprint.js";
import { CityGraph } from "./graph.js";
import type {
  Building,
  District,
  NetworkNode,
  NodeCapability,
  NodeId,
  NodeKind,
  Organisation,
  Place,
  PlaceId,
  SecurityZone,
  Subnet,
} from "./types.js";
import { ZONE_RANK } from "./types.js";

export interface City {
  graph: CityGraph;
  districts: Map<string, District>;
  buildings: Map<string, Building>;
  orgs: Map<string, Organisation>;
  subnets: Map<string, Subnet>;
  nodes: Map<NodeId, NetworkNode>;
  /** blueprint room key -> generated place id */
  roomPlaceIds: Map<string, PlaceId>;
  /** street key -> generated place id */
  streetPlaceIds: Map<string, PlaceId>;
}

const CAPABILITIES: Record<NodeKind, NodeCapability[]> = {
  router: ["route", "records"],
  relay: ["route"],
  camera: ["observe"],
  smart_lock: ["actuate"],
  phone: ["comms", "records", "credentials", "broadcast", "observe"],
  laptop: ["records", "comms", "credentials"],
  terminal: ["records", "credentials", "actuate"],
  speaker: ["broadcast"],
  display: ["broadcast"],
  light: ["actuate"],
  scooter: ["broadcast", "actuate"],
  car_alarm: ["broadcast"],
  vending: ["actuate", "broadcast"],
  hvac: ["actuate"],
  sprinkler: ["actuate"],
  elevator: ["actuate"],
  cleaning_bot: ["actuate", "observe"],
  lab_arm: ["actuate"],
  inventory_case: ["actuate", "records"],
  pa_system: ["broadcast"],
  printer: ["records", "actuate"],
  delivery_tablet: ["records", "comms"],
};

const RANGE: Partial<Record<NodeKind, number>> = {
  relay: 260,
  router: 180,
  phone: 30,
};

let nodeCounter = 0;

function makeNode(
  city: City,
  init: {
    kind: NodeKind;
    label: string;
    placeId: PlaceId;
    subnetId: string;
    hardening: number;
    ownerId?: string;
    portable?: boolean;
    state?: Record<string, unknown>;
  },
): NetworkNode {
  const node: NetworkNode = {
    id: `nd_${++nodeCounter}`,
    label: init.label,
    kind: init.kind,
    capabilities: CAPABILITIES[init.kind],
    placeId: init.placeId,
    subnetId: init.subnetId,
    hardening: Math.max(0.05, Math.min(0.98, init.hardening)),
    range: RANGE[init.kind] ?? 24,
    breached: false,
    state: init.state ?? {},
    portable: init.portable ?? false,
    online: true,
    ...(init.ownerId ? { ownerId: init.ownerId } : {}),
  };
  city.nodes.set(node.id, node);
  return node;
}

/** Exported so the NPC generator can attach personal devices to the same city. */
export function addNode(
  city: City,
  init: Parameters<typeof makeNode>[1],
): NetworkNode {
  return makeNode(city, init);
}

function addSubnet(city: City, init: Omit<Subnet, "exposed" | "anomalyScore">): Subnet {
  const subnet: Subnet = { ...init, exposed: false, anomalyScore: 0 };
  city.subnets.set(subnet.id, subnet);
  return subnet;
}

function placeFor(
  city: City,
  init: Omit<Place, "sightlines"> & { sightlines?: PlaceId[] },
): Place {
  const place: Place = { sightlines: [], ...init };
  city.graph.addPlace(place);
  return place;
}

/** Room devices are a function of what the room is for. */
function roomDeviceKinds(room: RoomSpec, rng: Rng): NodeKind[] {
  const kinds: NodeKind[] = ["light"];
  switch (room.kind) {
    case "lobby":
    case "reception":
      kinds.push("camera", "display", "pa_system");
      break;
    case "corridor":
      kinds.push("camera", "hvac");
      if (rng.chance(0.5)) kinds.push("cleaning_bot");
      break;
    case "office":
    case "meeting":
      kinds.push("terminal", "display");
      if (rng.chance(0.4)) kinds.push("printer");
      break;
    case "lab":
      kinds.push("terminal", "camera", "lab_arm", "inventory_case", "hvac");
      break;
    case "server":
      kinds.push("terminal", "hvac", "sprinkler", "camera");
      break;
    case "storage":
      kinds.push("camera");
      if (rng.chance(0.5)) kinds.push("terminal");
      break;
    case "breakroom":
      kinds.push("vending", "speaker");
      break;
    case "loading":
      kinds.push("camera", "delivery_tablet");
      break;
    case "clinic":
      kinds.push("terminal", "speaker");
      break;
    case "cafe":
    case "bar":
      kinds.push("speaker", "terminal");
      break;
    case "shop":
      kinds.push("terminal", "camera", "speaker");
      break;
    case "apartment":
      kinds.push("display");
      break;
    case "restroom":
      break;
    default:
      break;
  }
  return kinds;
}

function buildBuilding(city: City, spec: BuildingSpec, rng: Rng): void {
  const org: Organisation = {
    id: spec.orgId,
    name: spec.orgName,
    kind: spec.orgKind,
    buildingId: spec.id,
    securityPosture: spec.securityPosture,
  };
  city.orgs.set(org.id, org);

  const building: Building = {
    id: spec.id,
    name: spec.name,
    districtId: spec.districtId,
    orgId: spec.orgId,
    x: spec.x,
    y: spec.y,
    width: spec.width,
    depth: spec.depth,
    floors: spec.floors.length,
    placeIds: [],
  };
  city.buildings.set(building.id, building);

  const corporate = addSubnet(city, {
    id: `sn_${spec.id}`,
    name: `${spec.name} internal`,
    buildingId: spec.id,
    orgId: spec.orgId,
    firewall: spec.securityPosture,
  });

  const stairKeysByFloor = new Map<number, PlaceId>();

  for (const floorSpec of spec.floors) {
    // Every floor needs a circulation hub. Offices have a corridor or a lobby;
    // a café or a bar does not, and there the main floor plays that role.
    // Without this fallback the back rooms of small venues end up sealed off
    // from the rest of the world entirely.
    const corridor =
      floorSpec.rooms.find((r) => r.kind === "corridor" || r.kind === "lobby") ?? floorSpec.rooms[0];

    for (const room of floorSpec.rooms) {
      const place = placeFor(city, {
        id: `p_${room.key}`,
        name: room.name,
        kind: room.kind,
        x: spec.x + room.u * spec.width,
        y: spec.y + room.v * spec.depth,
        floor: floorSpec.floor,
        indoor: true,
        buildingId: spec.id,
        districtId: spec.districtId,
        zone: room.zone,
        radius: 16,
      });
      building.placeIds.push(place.id);
      city.roomPlaceIds.set(room.key, place.id);
    }

    // Stairwell: one per floor, wired vertically afterwards.
    const stair = placeFor(city, {
      id: `p_${spec.id}_stair_${floorSpec.floor}`,
      name: `${spec.name} stairwell L${floorSpec.floor}`,
      kind: "stairwell",
      x: spec.x + spec.width * 0.06,
      y: spec.y + spec.depth * 0.5,
      floor: floorSpec.floor,
      indoor: true,
      buildingId: spec.id,
      districtId: spec.districtId,
      zone: "staff",
      radius: 10,
    });
    building.placeIds.push(stair.id);
    stairKeysByFloor.set(floorSpec.floor, stair.id);

    // Everything on a floor hangs off the corridor/lobby hub.
    if (corridor) {
      const hubId = `p_${corridor.key}`;
      for (const room of floorSpec.rooms) {
        if (room.key === corridor.key) continue;
        const roomId = `p_${room.key}`;
        // Rooms with explicit `connects` are wired through those instead.
        const explicit = room.connects?.length ? room.connects : null;
        const attachTo = explicit ? explicit.map((k) => `p_${k}`) : [hubId];
        for (const target of attachTo) {
          if (!city.graph.places.has(target)) continue;
          if (city.graph.edgeBetween(roomId, target)) continue;
          const doorId = room.door ? `dr_${room.key}` : undefined;
          if (room.door && !city.graph.doors.has(doorId!)) {
            city.graph.addDoor({
              id: doorId!,
              name: `${room.name} door`,
              lock: room.door.lock,
              locked: true,
              clearance: room.door.clearance,
              failOpen: false,
            });
          }
          city.graph.connect(roomId, target, doorId ? { doorId } : {});
        }
        if (room.glass) {
          city.graph.place(roomId).sightlines.push(hubId);
          city.graph.place(hubId).sightlines.push(roomId);
        }
      }
      city.graph.connect(hubId, stair.id);
    }

    // Devices.
    for (const room of floorSpec.rooms) {
      const placeId = `p_${room.key}`;
      for (const kind of roomDeviceKinds(room, rng)) {
        makeNode(city, {
          kind,
          label: `${room.name} ${kind.replace(/_/g, " ")}`,
          placeId,
          subnetId: corporate.id,
          hardening: spec.securityPosture * rng.float(0.6, 1.05),
          ownerId: spec.orgId,
          state: kind === "inventory_case" ? { locked: true, contents: [] } : {},
        });
      }
      // Doors that are on the network get a smart lock node.
      if (room.door && room.door.lock !== "mechanical") {
        const lockNode = makeNode(city, {
          kind: "smart_lock",
          label: `${room.name} lock`,
          placeId,
          subnetId: corporate.id,
          hardening: spec.securityPosture * rng.float(0.8, 1.15),
          ownerId: spec.orgId,
        });
        const door = city.graph.doors.get(`dr_${room.key}`);
        if (door) door.nodeId = lockNode.id;
      }
    }
  }

  // Vertical circulation.
  const floors = [...stairKeysByFloor.keys()].sort((a, b) => a - b);
  for (let i = 0; i + 1 < floors.length; i++) {
    const lower = stairKeysByFloor.get(floors[i]!)!;
    const upper = stairKeysByFloor.get(floors[i + 1]!)!;
    city.graph.connect(lower, upper, { vertical: true, minutes: 0.6 });
  }
  if (floors.length > 1) {
    // The lift shares the stairwell node; hacking it strands whoever is inside.
    const groundStair = stairKeysByFloor.get(floors[0]!)!;
    makeNode(city, {
      kind: "elevator",
      label: `${spec.name} elevator`,
      placeId: groundStair,
      subnetId: corporate.id,
      hardening: spec.securityPosture * 0.9,
      ownerId: spec.orgId,
      state: { floor: 0, held: false },
    });
  }

  // The gateway lives in the most protected room the building has — a server
  // room if there is one, otherwise whatever has the highest clearance. This is
  // what makes "get onto their network" a spatial problem rather than a menu.
  const rooms = city.graph.placesInBuilding(spec.id);
  const routerRoom =
    rooms.find((p) => p.kind === "server") ??
    rooms.reduce((best, p) => (ZONE_RANK[p.zone] > ZONE_RANK[best.zone] ? p : best), rooms[0]!);
  makeNode(city, {
    kind: "router",
    label: `${spec.name} gateway`,
    placeId: routerRoom.id,
    subnetId: corporate.id,
    hardening: Math.min(0.95, spec.securityPosture + 0.15),
    ownerId: spec.orgId,
  });

  // Entrance onto the street.
  const streetPlaceId = city.streetPlaceIds.get(spec.entranceStreetKey);
  const groundHub =
    city.roomPlaceIds.get(spec.floors[0]!.rooms[0]!.key) ?? building.placeIds[0]!;
  if (streetPlaceId) {
    let doorId: string | undefined;
    if (spec.entranceLock !== "none") {
      doorId = `dr_${spec.id}_entrance`;
      city.graph.addDoor({
        id: doorId,
        name: `${spec.name} entrance`,
        lock: spec.entranceLock,
        locked: true,
        clearance: "semi",
        failOpen: false,
      });
      const lockNode = makeNode(city, {
        kind: "smart_lock",
        label: `${spec.name} entrance lock`,
        placeId: groundHub,
        subnetId: corporate.id,
        hardening: spec.securityPosture,
        ownerId: spec.orgId,
      });
      city.graph.doors.get(doorId)!.nodeId = lockNode.id;
    }
    city.graph.connect(groundHub, streetPlaceId, doorId ? { doorId } : {});
    city.graph.place(groundHub).sightlines.push(streetPlaceId);
    city.graph.place(streetPlaceId).sightlines.push(groundHub);
  }
}

export function generateCity(seed: number | string): City {
  nodeCounter = 0;
  const rng = new Rng(seed);
  const city: City = {
    graph: new CityGraph(),
    districts: new Map(),
    buildings: new Map(),
    orgs: new Map(),
    subnets: new Map(),
    nodes: new Map(),
    roomPlaceIds: new Map(),
    streetPlaceIds: new Map(),
  };

  for (const d of DISTRICTS) {
    city.districts.set(d.id, { ...d });
  }

  const publicNet = addSubnet(city, {
    id: "sn_public",
    name: "ctOS public infrastructure",
    firewall: 0.2,
  });

  // Streets first so building entrances have something to attach to.
  for (const s of STREETS) {
    const place = placeFor(city, {
      id: `p_${s.key}`,
      name: s.name,
      kind: s.kind,
      x: s.x,
      y: s.y,
      floor: 0,
      indoor: false,
      districtId: s.districtId,
      zone: "public",
      radius: 42,
    });
    city.streetPlaceIds.set(s.key, place.id);
  }
  for (const s of STREETS) {
    for (const other of s.connects) {
      const a = city.streetPlaceIds.get(s.key)!;
      const b = city.streetPlaceIds.get(other);
      if (!b || city.graph.edgeBetween(a, b)) continue;
      city.graph.connect(a, b);
      city.graph.place(a).sightlines.push(b);
      city.graph.place(b).sightlines.push(a);
    }
  }

  // Street furniture: the public layer you always have some purchase on.
  for (const s of STREETS) {
    const placeId = city.streetPlaceIds.get(s.key)!;
    makeNode(city, {
      kind: "relay",
      label: `${s.name} junction box`,
      placeId,
      subnetId: publicNet.id,
      hardening: rng.float(0.1, 0.3),
    });
    makeNode(city, {
      kind: "camera",
      label: `${s.name} ctOS camera`,
      placeId,
      subnetId: publicNet.id,
      hardening: rng.float(0.2, 0.45),
    });
    const scooters = rng.int(1, 4);
    for (let i = 0; i < scooters; i++) {
      makeNode(city, {
        kind: "scooter",
        label: `Parked scooter ${i + 1} · ${s.name}`,
        placeId,
        subnetId: publicNet.id,
        hardening: rng.float(0.08, 0.22),
      });
    }
    const cars = rng.int(1, 3);
    for (let i = 0; i < cars; i++) {
      makeNode(city, {
        kind: "car_alarm",
        label: `Parked car ${i + 1} · ${s.name}`,
        placeId,
        subnetId: publicNet.id,
        hardening: rng.float(0.1, 0.28),
      });
    }
    if (s.kind !== "alley") {
      makeNode(city, {
        kind: "display",
        label: `${s.name} ad hoarding`,
        placeId,
        subnetId: publicNet.id,
        hardening: rng.float(0.2, 0.4),
      });
    }
  }

  for (const spec of BUILDINGS) {
    buildBuilding(city, spec, rng.fork(spec.id));
  }

  return city;
}
