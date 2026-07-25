/**
 * Navigation over the place graph.
 *
 * A* with a euclidean heuristic scaled to walking speed. Doors are edge
 * predicates rather than obstacles baked into the graph, so the same graph
 * answers "where can this NPC go" and "where could this NPC go if I unlocked
 * everything" — which is exactly the question the planner UI asks.
 */

import type { Door, DoorId, Edge, EdgeId, Place, PlaceId } from "./types.js";

/** Metres per world-minute for an unhurried adult; used by the A* heuristic. */
export const WALK_SPEED = 70;

export interface PathStep {
  from: PlaceId;
  to: PlaceId;
  edgeId: EdgeId;
  minutes: number;
}

export interface Path {
  steps: PathStep[];
  minutes: number;
}

/** Decides whether a mover may use an edge right now. */
export type EdgeFilter = (edge: Edge, door: Door | undefined) => boolean;

export class CityGraph {
  readonly places = new Map<PlaceId, Place>();
  readonly edges = new Map<EdgeId, Edge>();
  readonly doors = new Map<DoorId, Door>();
  private adjacency = new Map<PlaceId, EdgeId[]>();

  addPlace(place: Place): Place {
    this.places.set(place.id, place);
    if (!this.adjacency.has(place.id)) this.adjacency.set(place.id, []);
    return place;
  }

  addDoor(door: Door): Door {
    this.doors.set(door.id, door);
    return door;
  }

  addEdge(edge: Edge): Edge {
    this.edges.set(edge.id, edge);
    this.adjacency.get(edge.a)?.push(edge.id) ?? this.adjacency.set(edge.a, [edge.id]);
    this.adjacency.get(edge.b)?.push(edge.id) ?? this.adjacency.set(edge.b, [edge.id]);
    return edge;
  }

  /** Connect two places, deriving traversal time from the distance between them. */
  connect(
    a: PlaceId,
    b: PlaceId,
    options: { doorId?: DoorId; vertical?: boolean; minutes?: number } = {},
  ): Edge {
    const pa = this.place(a);
    const pb = this.place(b);
    const flat = Math.hypot(pa.x - pb.x, pa.y - pb.y);
    const climb = Math.abs(pa.floor - pb.floor) * 120;
    const minutes = options.minutes ?? Math.max(0.15, (flat + climb) / WALK_SPEED);
    return this.addEdge({
      id: `e:${a}~${b}`,
      a,
      b,
      minutes,
      vertical: options.vertical ?? pa.floor !== pb.floor,
      ...(options.doorId ? { doorId: options.doorId } : {}),
    });
  }

  place(id: PlaceId): Place {
    const p = this.places.get(id);
    if (!p) throw new Error(`Unknown place: ${id}`);
    return p;
  }

  maybePlace(id: PlaceId | undefined): Place | undefined {
    return id ? this.places.get(id) : undefined;
  }

  edgesFrom(id: PlaceId): Edge[] {
    return (this.adjacency.get(id) ?? []).map((eid) => this.edges.get(eid)!).filter(Boolean);
  }

  neighbourOf(edge: Edge, from: PlaceId): PlaceId {
    return edge.a === from ? edge.b : edge.a;
  }

  edgeBetween(a: PlaceId, b: PlaceId): Edge | undefined {
    return this.edgesFrom(a).find((e) => this.neighbourOf(e, a) === b);
  }

  distance(a: PlaceId, b: PlaceId): number {
    const pa = this.place(a);
    const pb = this.place(b);
    // Floors are far apart in traversal terms even when they overlap in plan.
    return Math.hypot(pa.x - pb.x, pa.y - pb.y) + Math.abs(pa.floor - pb.floor) * 100;
  }

  /**
   * Can someone at `a` see `b`? Same floor, and either the same place, an
   * explicit sightline, or both outdoors and within range with no building
   * between them (approximated by the outdoor flag).
   */
  canSee(a: PlaceId, b: PlaceId, range: number): boolean {
    if (a === b) return true;
    const pa = this.place(a);
    const pb = this.place(b);
    if (pa.floor !== pb.floor) return false;
    const distance = Math.hypot(pa.x - pb.x, pa.y - pb.y);
    // A declared sightline is a designer saying "there is glass here". Those
    // get a longer leash than open ground, because they are the difference
    // between watching a lobby from the plaza and having to walk into it.
    if (pa.sightlines.includes(b) || pb.sightlines.includes(a)) return distance <= range * 2.5;
    if (distance > range) return false;
    return !pa.indoor && !pb.indoor;
  }

  /** Standard A*. Returns undefined when no permitted route exists. */
  findPath(from: PlaceId, to: PlaceId, allow: EdgeFilter = () => true): Path | undefined {
    if (from === to) return { steps: [], minutes: 0 };
    if (!this.places.has(from) || !this.places.has(to)) return undefined;

    const open = new Set<PlaceId>([from]);
    const cameFrom = new Map<PlaceId, { place: PlaceId; edge: Edge }>();
    const gScore = new Map<PlaceId, number>([[from, 0]]);
    const fScore = new Map<PlaceId, number>([[from, this.distance(from, to) / WALK_SPEED]]);

    while (open.size > 0) {
      let current: PlaceId | undefined;
      let best = Infinity;
      for (const id of open) {
        const f = fScore.get(id) ?? Infinity;
        if (f < best) {
          best = f;
          current = id;
        }
      }
      if (current === undefined) break;
      if (current === to) return this.reconstruct(cameFrom, current);

      open.delete(current);
      const g = gScore.get(current) ?? Infinity;

      for (const edge of this.edgesFrom(current)) {
        const door = edge.doorId ? this.doors.get(edge.doorId) : undefined;
        if (!allow(edge, door)) continue;
        const next = this.neighbourOf(edge, current);
        const tentative = g + edge.minutes;
        if (tentative < (gScore.get(next) ?? Infinity)) {
          cameFrom.set(next, { place: current, edge });
          gScore.set(next, tentative);
          fScore.set(next, tentative + this.distance(next, to) / WALK_SPEED);
          open.add(next);
        }
      }
    }
    return undefined;
  }

  private reconstruct(
    cameFrom: Map<PlaceId, { place: PlaceId; edge: Edge }>,
    end: PlaceId,
  ): Path {
    const steps: PathStep[] = [];
    let cursor = end;
    let minutes = 0;
    while (cameFrom.has(cursor)) {
      const link = cameFrom.get(cursor)!;
      steps.unshift({
        from: link.place,
        to: cursor,
        edgeId: link.edge.id,
        minutes: link.edge.minutes,
      });
      minutes += link.edge.minutes;
      cursor = link.place;
    }
    return { steps, minutes };
  }

  /** Every place reachable within `minutes`, keyed by arrival cost (Dijkstra). */
  reachable(from: PlaceId, minutes: number, allow: EdgeFilter = () => true): Map<PlaceId, number> {
    const dist = new Map<PlaceId, number>([[from, 0]]);
    const queue: PlaceId[] = [from];
    while (queue.length > 0) {
      // Small graphs; a linear scan beats the constant factor of a real heap.
      let bestIndex = 0;
      for (let i = 1; i < queue.length; i++) {
        if ((dist.get(queue[i]!) ?? Infinity) < (dist.get(queue[bestIndex]!) ?? Infinity)) {
          bestIndex = i;
        }
      }
      const current = queue.splice(bestIndex, 1)[0]!;
      const g = dist.get(current) ?? Infinity;
      if (g > minutes) continue;
      for (const edge of this.edgesFrom(current)) {
        const door = edge.doorId ? this.doors.get(edge.doorId) : undefined;
        if (!allow(edge, door)) continue;
        const next = this.neighbourOf(edge, current);
        const tentative = g + edge.minutes;
        if (tentative <= minutes && tentative < (dist.get(next) ?? Infinity)) {
          dist.set(next, tentative);
          queue.push(next);
        }
      }
    }
    return dist;
  }

  placesInBuilding(buildingId: string): Place[] {
    return [...this.places.values()].filter((p) => p.buildingId === buildingId);
  }

  placesWithin(x: number, y: number, floor: number, radius: number): Place[] {
    return [...this.places.values()].filter(
      (p) => p.floor === floor && Math.hypot(p.x - x, p.y - y) <= radius,
    );
  }
}
