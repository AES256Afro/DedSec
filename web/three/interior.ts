/**
 * Floor plans.
 *
 * The blueprint has always known where every room is — it places them at
 * normalised `u`/`v` inside the footprint, and the graph knows which of them
 * connect and what lock is on the door between. None of that had ever been
 * built in three dimensions, so the entire interior of the city was a solid
 * block with one public room hollowed out of the front.
 *
 * This turns that data into architecture:
 *
 *   · **rooms are a partition, not boxes.** The floor is diced into a fine grid
 *     and every cell is assigned to the room whose centre it is nearest. That
 *     tiles the footprint exactly — no gaps to fall through, no overlaps — and
 *     it keeps the authored positions, so the security office stays where the
 *     blueprint put it and simply grows to fill the corner it is in;
 *   · **walls are the boundaries of that partition.** Wherever two adjacent
 *     cells belong to different rooms, there is a wall;
 *   · **doors are the exceptions.** Where the graph has an edge between two
 *     rooms, one boundary segment is left open, and if that edge carries a door
 *     the opening gets a slab that is solid exactly while the simulation says
 *     the player cannot pass.
 *
 * The consequence worth stating: the locks in this building are not decoration
 * and not a second implementation. A badge door is physically shut until
 * `playerCanPass` agrees, and it agrees for the same reasons it always did.
 *
 * One structural note. Twenty-odd floors of partition walls is somewhere north
 * of ten thousand boxes, and ten thousand meshes is a slideshow no matter how
 * few triangles each one has. So nothing here adds a mesh: walls, floors and
 * ceilings are *collected*, and `flushInteriors` turns the whole city's worth of
 * them into two instanced draws at the end. Doors are the exception — there are
 * about thirty, and each has to be shown or hidden on its own.
 */

import * as THREE from "three";

import type { GameState } from "../../src/sim/state.js";
import type { Building, Place, PlaceKind } from "../../src/world/types.js";

export const FLOOR_HEIGHT = 3.6;
/** Wall thickness. */
const WALL = 0.32;
/** Target room-grid resolution. Finer means tighter doorways and more segments. */
const CELL = 4.5;
/** Head height for the ceiling slab, so a 3.6 m floor still feels like a room. */
const CEILING = FLOOR_HEIGHT - 0.18;
/**
 * Clear width of a doorway.
 *
 * Generous for a door and deliberately so: the player is a 1.8 m wide cylinder
 * as far as the collider is concerned, and a gap they have to line up with is a
 * gap they will spend the whole game bouncing off.
 */
const DOOR_WIDTH = 2.6;
/** Clear height. What is left above it is a lintel, which is what makes it read as a door. */
const DOOR_HEIGHT = 2.2;
/** Metres between ceiling light strips. */
const LIGHT_SPACING = 4;
/** Cells between attempts to put something in a room. */
const PROP_STRIDE = 1;
/** Furniture stays this far off the room's own centre, where the player lands. */
const LANDING_CLEARANCE = 3.2;
/** Structural bay, in metres. Columns land on this grid. */
const BAY = 9;
const COLUMN = 0.7;

const PALETTE = {
  wall: 0xb9b2a6,
  partition: 0xa9a397,
  floor: 0x8b8478,
  ceiling: 0x6d675e,
};

/**
 * Indoors is a place the sun does not reach.
 *
 * Every light in this game belongs to the sky, and a ceiling faces away from
 * all of them — so the first version of these interiors rendered exactly as
 * physics says they should: a black slab overhead and walls that went out
 * whenever the sun swung round. That is correct and unplayable.
 *
 * Rather than scatter a hundred point lights the renderer would have to solve
 * per fragment, interior surfaces carry an emissive floor. It is a flat lift,
 * so shape still comes from the real lights and nothing looks self-illuminated
 * — it just means no wall in this city is ever unreadably dark, at any hour.
 * The strips under the ceiling are what makes that read as *lighting* rather
 * than as fog: something in the room is obviously the reason it is bright.
 */
const EMISSIVE = {
  solid: 0x3a382f,
  slab: 0x4a463c,
};
const STRIP = 0xffe9c4;
const COLUMN_COLOUR = 0xa39c8e;

export interface FloorPlan {
  buildingId: string;
  floor: number;
  x0: number;
  z0: number;
  cellX: number;
  cellZ: number;
  nx: number;
  nz: number;
  /** placeId per cell, row-major. */
  owner: string[];
  bounds: THREE.Box3;
}

/** A door in the world, solid or not depending on what the simulation says. */
export interface DoorSlab {
  doorId: string;
  box: THREE.Box3;
  mesh: THREE.Mesh;
}

/** A way in off the street: where the opening is, and which way is out. */
export interface Entrance {
  buildingId: string;
  placeId: string;
  doorId: string | undefined;
  /** Centre of the opening, at floor level. */
  x: number;
  z: number;
  /** Unit vector pointing out of the building, on the ground plane. */
  ox: number;
  oz: number;
}

interface BoxInstance {
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  d: number;
  colour: number;
}

export interface BuiltInteriors {
  plans: FloorPlan[];
  doors: DoorSlab[];
  entrances: Entrance[];
  /** Walls and furniture, held back until `flushInteriors` batches it. */
  solids: BoxInstance[];
  /** Floor and ceiling slabs, which want a duller lift than a wall does. */
  slabs: BoxInstance[];
  /** Ceiling strips. Unlit and bright: these are the reason a room is visible. */
  strips: BoxInstance[];
}

export function emptyInteriors(): BuiltInteriors {
  return { plans: [], doors: [], entrances: [], solids: [], slabs: [], strips: [] };
}

type Face = "n" | "s" | "e" | "w";

interface Segment {
  /** Centre of the wall segment. */
  x: number;
  z: number;
  /** True when the wall runs along X (a north/south boundary). */
  alongX: boolean;
  length: number;
  a: string;
  b: string | undefined;
  /** Which side of the building this is, for perimeter segments only. */
  face?: Face;
}

const OUTWARD: Record<Face, [number, number]> = {
  n: [0, -1],
  s: [0, 1],
  e: [1, 0],
  w: [-1, 0],
};

function linkKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * Build every floor of one building.
 *
 * Fills `out` with the plans (so the client can answer "which room am I in"),
 * the door slabs (so it can keep asking whether they are shut), the entrances
 * (so anything that wants to walk in knows where to aim), and the geometry.
 */
export function buildInteriors(
  state: GameState,
  building: Building,
  colliders: THREE.Box3[],
  out: BuiltInteriors,
  root: THREE.Group,
): void {
  const graph = state.city.graph;
  const places = graph.placesInBuilding(building.id).filter((p) => p.indoor);
  if (places.length === 0) return;

  // Which rooms connect, and through what.
  const links = new Map<string, { doorId?: string }>();
  const exterior = new Map<string, { outside: Place; doorId?: string }>();
  for (const edge of graph.edges.values()) {
    const a = graph.places.get(edge.a);
    const b = graph.places.get(edge.b);
    if (!a || !b) continue;
    const aMine = a.buildingId === building.id && a.indoor;
    const bMine = b.buildingId === building.id && b.indoor;
    if (aMine && bMine) {
      if (a.floor !== b.floor) continue; // stairs are not a doorway in plan
      links.set(linkKey(a.id, b.id), edge.doorId ? { doorId: edge.doorId } : {});
    } else if (aMine && !b.indoor) {
      exterior.set(a.id, { outside: b, ...(edge.doorId ? { doorId: edge.doorId } : {}) });
    } else if (bMine && !a.indoor) {
      exterior.set(b.id, { outside: a, ...(edge.doorId ? { doorId: edge.doorId } : {}) });
    }
  }

  const floors = [...new Set(places.map((p) => p.floor))].sort((x, y) => x - y);
  for (const floor of floors) {
    buildFloor(state, building, floor, places, links, exterior, colliders, out, root);
  }
}

function buildFloor(
  state: GameState,
  building: Building,
  floor: number,
  allPlaces: Place[],
  links: Map<string, { doorId?: string }>,
  exterior: Map<string, { outside: Place; doorId?: string }>,
  colliders: THREE.Box3[],
  out: BuiltInteriors,
  root: THREE.Group,
): void {
  const rooms = allPlaces.filter((p) => p.floor === floor);
  if (rooms.length === 0) return;

  const nx = Math.max(4, Math.round(building.width / CELL));
  const nz = Math.max(4, Math.round(building.depth / CELL));
  const cellX = building.width / nx;
  const cellZ = building.depth / nz;
  const base = floor * FLOOR_HEIGHT;

  // Assign every cell to the nearest room. This is what makes the rooms tile.
  const owner: string[] = new Array(nx * nz);
  for (let j = 0; j < nz; j++) {
    const cz = building.y + (j + 0.5) * cellZ;
    for (let i = 0; i < nx; i++) {
      const cx = building.x + (i + 0.5) * cellX;
      let best = rooms[0]!;
      let bestDistance = Infinity;
      for (const room of rooms) {
        const d = (room.x - cx) ** 2 + (room.y - cz) ** 2;
        if (d < bestDistance) {
          bestDistance = d;
          best = room;
        }
      }
      owner[j * nx + i] = best.id;
    }
  }

  const plan: FloorPlan = {
    buildingId: building.id,
    floor,
    x0: building.x,
    z0: building.y,
    cellX,
    cellZ,
    nx,
    nz,
    owner,
    bounds: new THREE.Box3(
      new THREE.Vector3(building.x, base, building.y),
      new THREE.Vector3(building.x + building.width, base + FLOOR_HEIGHT, building.y + building.depth),
    ),
  };
  out.plans.push(plan);

  /* --------------------------------------------------------- the segments */

  const internal: Segment[] = [];
  const perimeter: Segment[] = [];

  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const here = owner[j * nx + i]!;

      // Boundary with the cell to the east.
      if (i + 1 < nx) {
        const east = owner[j * nx + i + 1]!;
        if (east !== here) {
          internal.push({
            x: building.x + (i + 1) * cellX,
            z: building.y + (j + 0.5) * cellZ,
            alongX: false,
            length: cellZ,
            a: here,
            b: east,
          });
        }
      } else {
        perimeter.push({
          x: building.x + building.width,
          z: building.y + (j + 0.5) * cellZ,
          alongX: false,
          length: cellZ,
          a: here,
          b: undefined,
          face: "e",
        });
      }
      if (i === 0) {
        perimeter.push({
          x: building.x,
          z: building.y + (j + 0.5) * cellZ,
          alongX: false,
          length: cellZ,
          a: here,
          b: undefined,
          face: "w",
        });
      }

      // Boundary with the cell to the south.
      if (j + 1 < nz) {
        const south = owner[(j + 1) * nx + i]!;
        if (south !== here) {
          internal.push({
            x: building.x + (i + 0.5) * cellX,
            z: building.y + (j + 1) * cellZ,
            alongX: true,
            length: cellX,
            a: here,
            b: south,
          });
        }
      } else {
        perimeter.push({
          x: building.x + (i + 0.5) * cellX,
          z: building.y + building.depth,
          alongX: true,
          length: cellX,
          a: here,
          b: undefined,
          face: "s",
        });
      }
      if (j === 0) {
        perimeter.push({
          x: building.x + (i + 0.5) * cellX,
          z: building.y,
          alongX: true,
          length: cellX,
          a: here,
          b: undefined,
          face: "n",
        });
      }
    }
  }

  /* ------------------------------------------------------------ doorways */

  // For every pair of rooms the graph connects, leave exactly one segment out
  // of the wall — the one nearest the straight line between them, which is
  // where a person would have put the door.
  const doorwayAt = new Set<Segment>();
  const doorFor = new Map<Segment, string>();
  const byPair = new Map<string, Segment[]>();
  for (const segment of internal) {
    if (!segment.b) continue;
    const key = linkKey(segment.a, segment.b);
    if (!links.has(key)) continue;
    const list = byPair.get(key);
    if (list) list.push(segment);
    else byPair.set(key, [segment]);
  }
  for (const [key, segments] of byPair) {
    const [aId, bId] = key.split("|") as [string, string];
    const a = state.city.graph.places.get(aId);
    const b = state.city.graph.places.get(bId);
    if (!a || !b) continue;
    const mx = (a.x + b.x) / 2;
    const mz = (a.y + b.y) / 2;
    const near = closest(segments, mx, mz);
    doorwayAt.add(near);
    const doorId = links.get(key)?.doorId;
    if (doorId) doorFor.set(near, doorId);
  }

  // The way in from the street, on the perimeter nearest the outdoor place.
  for (const [roomId, link] of exterior) {
    const room = state.city.graph.places.get(roomId);
    if (!room || room.floor !== floor) continue;
    const candidates = perimeter.filter((s) => s.a === roomId);
    if (candidates.length === 0) continue;
    const near = closest(candidates, link.outside.x, link.outside.y);
    // Stay on one face: the nearest-by-distance neighbour of a corner segment
    // is around the corner, and an entrance bent round a corner is two holes.
    const wide = widen(
      candidates.filter((s) => s.face === near.face),
      near,
      cellX,
      cellZ,
    );
    for (const segment of wide) {
      doorwayAt.add(segment);
      if (link.doorId) doorFor.set(segment, link.doorId);
    }
    const [ox, oz] = OUTWARD[near.face ?? "s"];
    // The nearest segment's own centre, not the average of the pair: a two-cell
    // entrance has a pier down the middle of it, and the average is the pier.
    out.entrances.push({
      buildingId: building.id,
      placeId: roomId,
      doorId: link.doorId,
      x: near.x,
      z: near.z,
      ox,
      oz,
    });
  }

  /* -------------------------------------------------------------- geometry */

  /**
   * A run of wall, `length` metres of it, centred on the segment.
   *
   * `offset` slides it along the run so a doorway can be flanked by two of
   * these with a gap between.
   */
  const solid = (segment: Segment, colour: number, length = segment.length, offset = 0): void => {
    if (length <= 0.01) return;
    const w = segment.alongX ? length : WALL;
    const d = segment.alongX ? WALL : length;
    const x = segment.x + (segment.alongX ? offset : 0);
    const z = segment.z + (segment.alongX ? 0 : offset);
    out.solids.push({ x, y: base + FLOOR_HEIGHT / 2, z, w, h: FLOOR_HEIGHT, d, colour });
    colliders.push(
      new THREE.Box3(
        new THREE.Vector3(x - w / 2, base, z - d / 2),
        new THREE.Vector3(x + w / 2, base + FLOOR_HEIGHT, z + d / 2),
      ),
    );
  };

  /**
   * A doorway: a door-sized hole, and wall either side of it.
   *
   * The grid's own cell is four and a half metres, and simply dropping one out
   * of the wall left a gap that read as a missing facade rather than as a way
   * in. The opening is cut to the width of a door instead, and what is left of
   * the cell is still wall — which is also what turns a two-cell entrance into
   * a pair of doors with a pier between them, rather than one enormous hole.
   */
  const openDoorway = (segment: Segment, colour: number): void => {
    const span = Math.min(segment.length, DOOR_WIDTH);
    const flank = (segment.length - span) / 2;
    if (flank > 0.01) {
      const shift = (span + flank) / 2;
      solid(segment, colour, flank, -shift);
      solid(segment, colour, flank, shift);
    }
    // The lintel. No collider: it starts well above the top of the player's
    // collision probe, so nothing can ever be stopped by it.
    const head = FLOOR_HEIGHT - DOOR_HEIGHT;
    out.solids.push({
      x: segment.x,
      y: base + DOOR_HEIGHT + head / 2,
      z: segment.z,
      w: segment.alongX ? span : WALL,
      h: head,
      d: segment.alongX ? WALL : span,
      colour,
    });
    const doorId = doorFor.get(segment);
    // A locked door is still a door: it exists, and it is shut.
    if (doorId) out.doors.push(makeDoor(root, segment, base, doorId));
  };

  for (const segment of perimeter) {
    if (doorwayAt.has(segment)) openDoorway(segment, PALETTE.wall);
    else solid(segment, PALETTE.wall);
  }
  for (const segment of internal) {
    if (doorwayAt.has(segment)) openDoorway(segment, PALETTE.partition);
    else solid(segment, PALETTE.partition);
  }

  // Floor and ceiling. Neither needs a collider — the walls already fence you
  // in, and there is no way to leave a floor except by the stairs.
  const cx = building.x + building.width / 2;
  const cz = building.y + building.depth / 2;
  out.slabs.push({ x: cx, y: base + 0.06, z: cz, w: building.width, h: 0.12, d: building.depth, colour: PALETTE.floor });
  out.slabs.push({ x: cx, y: base + CEILING, z: cz, w: building.width, h: 0.12, d: building.depth, colour: PALETTE.ceiling });

  // Strip lights, in rows across the whole floor. They are geometry rather than
  // lights: three would have to solve every one of them per fragment, and what
  // the room actually needs is for something in it to look like the reason it
  // is bright.
  const rows = Math.max(1, Math.round(building.depth / LIGHT_SPACING));
  const runs = Math.max(1, Math.round(building.width / (LIGHT_SPACING * 4)));
  for (let r = 0; r < rows; r++) {
    const z = building.y + ((r + 0.5) / rows) * building.depth;
    for (let c = 0; c < runs; c++) {
      const w = (building.width / runs) * 0.62;
      out.strips.push({
        x: building.x + ((c + 0.5) / runs) * building.width,
        y: base + CEILING - 0.1,
        z,
        w,
        h: 0.06,
        d: 0.3,
        colour: STRIP,
      });
    }
  }

  const thresholds = [...doorwayAt].map((s) => [s.x, s.z] as const);
  columns(building, plan, base, rooms, thresholds, colliders, out);
  furnish(building, plan, rooms, thresholds, colliders, out);
}

/**
 * The structural grid.
 *
 * A hundred-metre floorplate with nothing in it is a warehouse, and the reason
 * no real one looks like that is that something has to hold the next storey up.
 * Columns on a nine-metre bay cost almost nothing, break the space into rooms
 * you can read the depth of, and give you something to stand behind.
 */
function columns(
  building: Building,
  plan: FloorPlan,
  base: number,
  rooms: Place[],
  thresholds: Array<readonly [number, number]>,
  colliders: THREE.Box3[],
  out: BuiltInteriors,
): void {
  const across = Math.max(1, Math.round(building.width / BAY));
  const deep = Math.max(1, Math.round(building.depth / BAY));
  for (let a = 1; a < across; a++) {
    for (let b = 1; b < deep; b++) {
      const x = building.x + (a / across) * building.width;
      const z = building.y + (b / deep) * building.depth;
      // Never in a doorway: a column in a threshold is a door you cannot use.
      if (thresholds.some(([tx, tz]) => Math.hypot(tx - x, tz - z) < 2.4)) continue;
      // Never on a landing either. Anything arriving by the place graph is put
      // down on the room's own coordinates, and a column there is a player
      // standing inside a solid box with every direction blocked.
      if (rooms.some((room) => Math.hypot(room.x - x, room.y - z) < LANDING_CLEARANCE)) continue;
      out.solids.push({
        x,
        y: base + FLOOR_HEIGHT / 2,
        z,
        w: COLUMN,
        h: FLOOR_HEIGHT,
        d: COLUMN,
        colour: COLUMN_COLOUR,
      });
      colliders.push(
        new THREE.Box3(
          new THREE.Vector3(x - COLUMN / 2, base, z - COLUMN / 2),
          new THREE.Vector3(x + COLUMN / 2, base + FLOOR_HEIGHT, z + COLUMN / 2),
        ),
      );
    }
  }
}

/* ---------------------------------------------------------------- fitting out */

interface Prop {
  /** Footprint and height, in metres. */
  w: number;
  h: number;
  d: number;
  colour: number;
  /** How often a candidate cell actually gets one. */
  density: number;
}

/**
 * What is in a room of this kind.
 *
 * Deliberately blunt: a box at desk height reads as a desk, and a rank of them
 * reads as an open-plan floor. The point is not furniture, it is that a room
 * you walk into has something in it to walk around, which is the difference
 * between a building and a set of empty boxes stacked five high.
 */
const FURNITURE: Partial<Record<PlaceKind, Prop>> = {
  office: { w: 3.4, h: 0.74, d: 1.7, colour: 0x7d6a54, density: 0.7 },
  meeting: { w: 3.6, h: 0.74, d: 1.5, colour: 0x6b5a48, density: 0.34 },
  lab: { w: 3.0, h: 0.92, d: 1.3, colour: 0x8d9aa0, density: 0.6 },
  server: { w: 1.1, h: 2.1, d: 2.0, colour: 0x33383d, density: 0.72 },
  storage: { w: 1.6, h: 1.5, d: 1.6, colour: 0x8a7a5e, density: 0.55 },
  loading: { w: 2.0, h: 1.6, d: 2.0, colour: 0x7f6d52, density: 0.42 },
  breakroom: { w: 1.4, h: 0.72, d: 1.4, colour: 0x6f6558, density: 0.4 },
  cafe: { w: 1.4, h: 0.72, d: 1.4, colour: 0x6f6558, density: 0.45 },
  bar: { w: 1.4, h: 0.72, d: 1.4, colour: 0x5b4a3d, density: 0.45 },
  reception: { w: 3.4, h: 1.05, d: 1.1, colour: 0x5d5f66, density: 0.24 },
  lobby: { w: 2.6, h: 0.46, d: 0.8, colour: 0x5d5f66, density: 0.16 },
  clinic: { w: 2.1, h: 0.62, d: 0.9, colour: 0x9aa3a0, density: 0.36 },
  shop: { w: 2.0, h: 1.5, d: 0.9, colour: 0x6d5f4e, density: 0.5 },
  gym: { w: 1.6, h: 1.2, d: 1.1, colour: 0x4a4f55, density: 0.45 },
  apartment: { w: 2.1, h: 0.6, d: 1.3, colour: 0x74624f, density: 0.4 },
  // Corridors, restrooms and stairwells stay clear on purpose: they are the
  // parts of a building you are supposed to be able to move through.
};

function hash(...parts: (string | number)[]): number {
  let h = 0x811c9dc5;
  const text = parts.join(":");
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h >>> 0;
}

function furnish(
  building: Building,
  plan: FloorPlan,
  rooms: Place[],
  thresholds: Array<readonly [number, number]>,
  colliders: THREE.Box3[],
  out: BuiltInteriors,
): void {
  const byId = new Map(rooms.map((room) => [room.id, room]));
  const base = plan.floor * FLOOR_HEIGHT;

  for (let j = 1; j < plan.nz - 1; j += PROP_STRIDE) {
    for (let i = 1; i < plan.nx - 1; i += PROP_STRIDE) {
      const id = plan.owner[j * plan.nx + i]!;
      // Only well inside a room: a prop against a wall reads as part of it, and
      // one straddling a boundary reads as a mistake.
      if (
        plan.owner[j * plan.nx + i - 1] !== id ||
        plan.owner[j * plan.nx + i + 1] !== id ||
        plan.owner[(j - 1) * plan.nx + i] !== id ||
        plan.owner[(j + 1) * plan.nx + i] !== id
      ) {
        continue;
      }
      const room = byId.get(id);
      const prop = room ? FURNITURE[room.kind] : undefined;
      if (!room || !prop) continue;

      const x = plan.x0 + (i + 0.5) * plan.cellX;
      const z = plan.z0 + (j + 0.5) * plan.cellZ;
      // The room's own coordinates are where anything arriving by the place
      // graph is put down — the player included. Never build on the landing.
      if (Math.hypot(room.x - x, room.y - z) < LANDING_CLEARANCE) continue;
      if (thresholds.some(([tx, tz]) => Math.hypot(tx - x, tz - z) < 3)) continue;

      const roll = hash(building.id, plan.floor, i, j);
      if ((roll >>> 8) / 0xffffff > prop.density) continue;
      // Half of them turned, so a floor is not a grid of identical objects.
      const turned = (roll & 1) === 1;
      const w = turned ? prop.d : prop.w;
      const d = turned ? prop.w : prop.d;

      out.solids.push({ x, y: base + prop.h / 2 + 0.12, z, w, h: prop.h, d, colour: prop.colour });
      colliders.push(
        new THREE.Box3(
          new THREE.Vector3(x - w / 2, base, z - d / 2),
          new THREE.Vector3(x + w / 2, base + prop.h + 0.12, z + d / 2),
        ),
      );
    }
  }
}

/** The segment nearest a point. */
function closest(segments: Segment[], x: number, z: number): Segment {
  let best = segments[0]!;
  let bestDistance = Infinity;
  for (const segment of segments) {
    const d = (segment.x - x) ** 2 + (segment.z - z) ** 2;
    if (d < bestDistance) {
      bestDistance = d;
      best = segment;
    }
  }
  return best;
}

/** A segment and, if there is one going the same way, the one beside it. */
function widen(segments: Segment[], seed: Segment, cellX: number, cellZ: number): Segment[] {
  const reach = Math.max(cellX, cellZ) * 1.1;
  const neighbour = segments.find(
    (s) => s !== seed && s.alongX === seed.alongX && Math.hypot(s.x - seed.x, s.z - seed.z) < reach,
  );
  return neighbour ? [seed, neighbour] : [seed];
}

/** A door leaf in the opening, sized just under the frame so it reads as one. */
function makeDoor(root: THREE.Group, segment: Segment, base: number, doorId: string): DoorSlab {
  const span = Math.min(segment.length, DOOR_WIDTH);
  const w = segment.alongX ? span : WALL;
  const d = segment.alongX ? WALL : span;
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(w * 0.96, DOOR_HEIGHT * 0.98, d * 0.96),
    new THREE.MeshLambertMaterial({ color: 0x6a5f52, emissive: EMISSIVE.solid }),
  );
  mesh.position.set(segment.x, base + (DOOR_HEIGHT * 0.98) / 2, segment.z);
  root.add(mesh);
  return {
    doorId,
    box: new THREE.Box3(
      new THREE.Vector3(segment.x - w / 2, base, segment.z - d / 2),
      new THREE.Vector3(segment.x + w / 2, base + DOOR_HEIGHT, segment.z + d / 2),
    ),
    mesh,
  };
}

/**
 * Turn every collected box into two instanced draws.
 *
 * Called once, after the last building. Twelve thousand wall meshes and the
 * client renders at single-figure frames; twelve thousand instances of one box
 * and it does not notice they are there.
 */
export function flushInteriors(root: THREE.Group, out: BuiltInteriors): void {
  const batches: Array<[BoxInstance[], THREE.Material]> = [
    [out.solids, new THREE.MeshLambertMaterial({ emissive: EMISSIVE.solid })],
    [out.slabs, new THREE.MeshLambertMaterial({ emissive: EMISSIVE.slab })],
    [out.strips, new THREE.MeshBasicMaterial({})],
  ];
  for (const [batch, material] of batches) {
    if (batch.length === 0) continue;
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), material, batch.length);
    const dummy = new THREE.Object3D();
    const colour = new THREE.Color();
    for (let i = 0; i < batch.length; i++) {
      const item = batch[i]!;
      dummy.position.set(item.x, item.y, item.z);
      dummy.scale.set(item.w, item.h, item.d);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      mesh.setColorAt(i, colour.setHex(item.colour));
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    // One mesh spanning the whole city is never off-screen, and asking three to
    // work that out every frame costs more than it saves.
    mesh.frustumCulled = false;
    root.add(mesh);
    batch.length = 0;
  }
}

/** Which room a world position is in, or nothing if it is not in a building. */
export function roomAt(plans: FloorPlan[], x: number, y: number, z: number): string | undefined {
  for (const plan of plans) {
    if (x < plan.bounds.min.x || x > plan.bounds.max.x) continue;
    if (z < plan.bounds.min.z || z > plan.bounds.max.z) continue;
    if (y < plan.bounds.min.y - 0.5 || y > plan.bounds.max.y) continue;
    const i = Math.min(plan.nx - 1, Math.max(0, Math.floor((x - plan.x0) / plan.cellX)));
    const j = Math.min(plan.nz - 1, Math.max(0, Math.floor((z - plan.z0) / plan.cellZ)));
    return plan.owner[j * plan.nx + i];
  }
  return undefined;
}
