/**
 * People, drawn.
 *
 * Three instanced meshes carry the whole population: a body, a head, and a
 * marker that floats over anyone the caseload has flagged. Instancing is not
 * about the seventy-odd people who exist today — it is so that the answer to
 * "can the city be bigger" is yes without touching this file.
 *
 * Two things are worth knowing about how people are positioned:
 *
 *   · **transit is interpolated.** The sim moves a person along an edge with a
 *     `t` from 0 to 1. Reading that directly is what turns a graph walk into
 *     somebody crossing a plaza;
 *   · **a place is a spot, but people are not a stack.** Everyone standing in
 *     the same place gets a fixed offset derived from their id, so six people
 *     in a plaza look like six people rather than one very solid person.
 *
 * The crowd carries almost no information by itself, and that is deliberate:
 * a flag marker over the people the caseload has something on, a tint on
 * whoever is under the crosshair, and nothing else. Everything you can read is
 * on the card, and the card only exists for the person you are aiming at.
 */

import * as THREE from "three";

import { caseFlag } from "../../src/case/cases.js";
import type { Npc } from "../../src/npc/types.js";
import type { GameState } from "../../src/sim/state.js";
import { FLOOR_HEIGHT } from "./world.js";

/**
 * A person, at roughly a person's size.
 *
 * These numbers matter more than they look. The camera's eye is at 1.68 m, so a
 * figure that tops out below that is one the crosshair passes clean over — and
 * with the head excluded from picking, aiming horizontally at somebody hit
 * nothing at all. Body plus head now comes to about 1.75 m, and both are
 * pickable.
 */
const BODY_HEIGHT = 1.45;
const HEAD_RADIUS = 0.16;
const CAPACITY = 512;

/**
 * People wear clothes, not status.
 *
 * Painting the whole figure in its flag colour turned a pavement into a row of
 * traffic cones and made the crowd unreadable as a crowd. The flag is carried
 * by the marker over their head, which is enough to spot across a plaza; the
 * body just says "a person", in one of a dozen muted things a person might have
 * put on.
 *
 * The one exception is the target tint, which is not information about them —
 * it is the client confirming which of six people on a plaza the card is about.
 */
const CLOTHING = [
  0x44505c, 0x5b5147, 0x6d6459, 0x3f4a55, 0x574a52, 0x4c5b4e,
  0x6b5f5a, 0x39434e, 0x5f5b4c, 0x4e4a58, 0x6a5a4f, 0x475458,
].map((hex) => new THREE.Color(hex));

const COLOURS = {
  skin: new THREE.Color(0xb8a898),
  target: new THREE.Color(0x35e0c8),
  harm: new THREE.Color(0xff5b5b),
  need: new THREE.Color(0xffc046),
};

function hash(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193) >>> 0;
  return h >>> 0;
}

/** A stable per-person jitter, so a crowd reads as a crowd. */
function scatter(id: string): { dx: number; dz: number } {
  const h = hash(id);
  const angle = ((h >>> 8) / 0xffffff) * Math.PI * 2;
  const radius = 1.5 + ((h & 0xff) / 0xff) * 5.5;
  return { dx: Math.cos(angle) * radius, dz: Math.sin(angle) * radius };
}

/** What this person happens to be wearing. Same person, same coat, always. */
function wardrobe(id: string): number {
  return (hash(id) >>> 3) % CLOTHING.length;
}

export interface CrowdMember {
  npc: Npc;
  position: THREE.Vector3;
  flag: "harm" | "need" | undefined;
  scanned: boolean;
}

export class Crowd {
  readonly bodies: THREE.InstancedMesh;
  readonly heads: THREE.InstancedMesh;
  private markers: THREE.InstancedMesh;
  /** Instance index → npc id, rebuilt every sync so picking stays honest. */
  private index: string[] = [];
  private members = new Map<string, CrowdMember>();
  private dummy = new THREE.Object3D();
  private hidden = new THREE.Vector3(0, -1000, 0);

  constructor(scene: THREE.Scene) {
    this.bodies = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.44, BODY_HEIGHT, 0.28),
      new THREE.MeshLambertMaterial({ vertexColors: false }),
      CAPACITY,
    );
    this.heads = new THREE.InstancedMesh(
      new THREE.SphereGeometry(HEAD_RADIUS, 10, 8),
      new THREE.MeshLambertMaterial({ color: COLOURS.skin }),
      CAPACITY,
    );
    this.markers = new THREE.InstancedMesh(
      new THREE.OctahedronGeometry(0.19),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.95 }),
      CAPACITY,
    );
    for (const mesh of [this.bodies, this.heads, this.markers]) {
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      scene.add(mesh);
    }
    // Markers are decoration; heads are not. A head is the part of somebody at
    // eye level, so leaving it out of the raycast is leaving out most of the
    // times you were actually aiming at them.
    this.markers.raycast = () => {};
  }

  /** Everyone the crowd currently knows about, in instance order. */
  all(): CrowdMember[] {
    return this.index.map((id) => this.members.get(id)!).filter(Boolean);
  }

  member(npcId: string): CrowdMember | undefined {
    return this.members.get(npcId);
  }

  /** The meshes a crosshair may legitimately land on, in pick order. */
  targets(): THREE.InstancedMesh[] {
    return [this.bodies, this.heads];
  }

  /**
   * Turn an instance index from a raycast back into a person.
   *
   * Bodies and heads share one index, so either mesh answers with the same id.
   */
  npcIdAt(instanceId: number): string | undefined {
    return this.index[instanceId];
  }

  sync(state: GameState, time: number, focusId?: string): void {
    const graph = state.city.graph;
    this.index = [];
    this.members.clear();

    let i = 0;
    for (const person of state.npcs.values()) {
      if (i >= CAPACITY) break;
      const position = this.positionOf(state, person);
      if (!position) continue;

      const flag = caseFlag(state, person.id);
      const scanned = person.revealedFields.has("identity");
      // Whoever is under the crosshair lights up, so the card is never in doubt
      // about which of six people on a plaza it belongs to. Everyone else is
      // simply dressed.
      const colour = person.id === focusId ? COLOURS.target : CLOTHING[wardrobe(person.id)]!;

      this.dummy.position.copy(position);
      this.dummy.position.y += BODY_HEIGHT / 2;
      this.dummy.rotation.set(0, this.facing(graph, person), 0);
      this.dummy.scale.setScalar(1);
      this.dummy.updateMatrix();
      this.bodies.setMatrixAt(i, this.dummy.matrix);
      this.bodies.setColorAt(i, colour);

      this.dummy.position.y = position.y + BODY_HEIGHT + HEAD_RADIUS * 0.8;
      this.dummy.updateMatrix();
      this.heads.setMatrixAt(i, this.dummy.matrix);

      if (flag) {
        // A slow bob, so a flag catches the eye across a plaza without needing
        // to be any bigger or any louder than it is.
        this.dummy.position.y = position.y + BODY_HEIGHT + 0.72 + Math.sin(time * 0.0024 + i) * 0.09;
        this.dummy.rotation.set(0, time * 0.0011, 0);
        this.dummy.updateMatrix();
        this.markers.setMatrixAt(i, this.dummy.matrix);
        this.markers.setColorAt(i, flag === "harm" ? COLOURS.harm : COLOURS.need);
      } else {
        this.dummy.position.copy(this.hidden);
        this.dummy.updateMatrix();
        this.markers.setMatrixAt(i, this.dummy.matrix);
      }

      this.index[i] = person.id;
      this.members.set(person.id, { npc: person, position, flag, scanned });
      i++;
    }

    // Park every unused slot below the world rather than shrinking the buffer.
    this.dummy.position.copy(this.hidden);
    this.dummy.rotation.set(0, 0, 0);
    this.dummy.updateMatrix();
    for (let j = i; j < CAPACITY; j++) {
      this.bodies.setMatrixAt(j, this.dummy.matrix);
      this.heads.setMatrixAt(j, this.dummy.matrix);
      this.markers.setMatrixAt(j, this.dummy.matrix);
    }

    for (const mesh of [this.bodies, this.heads, this.markers]) mesh.instanceMatrix.needsUpdate = true;
    if (this.bodies.instanceColor) this.bodies.instanceColor.needsUpdate = true;
    if (this.markers.instanceColor) this.markers.instanceColor.needsUpdate = true;
  }

  private positionOf(state: GameState, person: Npc): THREE.Vector3 | undefined {
    const graph = state.city.graph;
    const offset = scatter(person.id);

    if (person.transit) {
      const from = graph.places.get(person.transit.fromPlaceId);
      const to = graph.places.get(person.transit.toPlaceId);
      if (from && to) {
        const t = Math.max(0, Math.min(1, person.transit.t));
        return new THREE.Vector3(
          from.x + (to.x - from.x) * t,
          (from.floor + (to.floor - from.floor) * t) * FLOOR_HEIGHT,
          from.y + (to.y - from.y) * t,
        );
      }
    }

    const place = graph.places.get(person.placeId);
    if (!place) return undefined;
    // Indoors, a room is small; do not scatter people through the wall.
    const spread = place.indoor ? 0.35 : 1;
    return new THREE.Vector3(
      place.x + offset.dx * spread,
      place.floor * FLOOR_HEIGHT,
      place.y + offset.dz * spread,
    );
  }

  /** Face where you are going; face the way you were left if you are not. */
  private facing(graph: GameState["city"]["graph"], person: Npc): number {
    if (!person.transit) return 0;
    const from = graph.places.get(person.transit.fromPlaceId);
    const to = graph.places.get(person.transit.toPlaceId);
    if (!from || !to) return 0;
    return Math.atan2(to.x - from.x, to.y - from.y);
  }
}
