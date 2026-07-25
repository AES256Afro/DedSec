/**
 * The map.
 *
 * A floor slice of the city: districts, building footprints, the walkable
 * graph, every ctOS device, and every person the player has any business
 * seeing. Streets are always drawn even when a building floor is selected,
 * because losing the outside world while you are four storeys up makes the
 * city feel like a menu rather than a place.
 */

import { computeReach } from "../../src/hack/access.js";
import { describeNpc } from "../../src/npc/behavior.js";
import type { Npc } from "../../src/npc/types.js";
import type { GameState } from "../../src/sim/state.js";
import type { NetworkNode, Place } from "../../src/world/types.js";

export interface Camera {
  x: number;
  y: number;
  scale: number;
}

export interface MapSelection {
  kind: "place" | "npc" | "node";
  id: string;
}

export interface HitResult {
  selection: MapSelection;
  label: string;
}

const COLOURS = {
  district: "#0b1016",
  districtLine: "#161f28",
  building: "#111a22",
  buildingLine: "#1f2b36",
  edge: "#1b2731",
  place: "#26343f",
  placePublic: "#2e4250",
  restricted: "#b06cf0",
  staff: "#35e0c8",
  player: "#35e0c8",
  drone: "#7fe07f",
  npc: "#8fa3b4",
  npcProfiled: "#d7e2ec",
  npcSuspicious: "#f2b134",
  npcDown: "#ff5c5c",
  node: "#3c5566",
  nodeReach: "#35e0c8",
  nodeBreached: "#7fe07f",
  selection: "#ffffff",
};

export class MapRenderer {
  private ctx: CanvasRenderingContext2D;
  camera: Camera = { x: 0, y: 0, scale: 0.62 };
  floor = 0;
  selection?: MapSelection;
  hovered?: MapSelection;
  /** Populated each frame so hit-testing uses exactly what was drawn. */
  private hitboxes: Array<{ x: number; y: number; r: number; hit: HitResult }> = [];

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2d canvas context unavailable");
    this.ctx = ctx;
  }

  resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** Frame the whole city on first load. */
  fit(state: GameState): void {
    const rect = this.canvas.getBoundingClientRect();
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const d of state.city.districts.values()) {
      minX = Math.min(minX, d.x);
      minY = Math.min(minY, d.y);
      maxX = Math.max(maxX, d.x + d.width);
      maxY = Math.max(maxY, d.y + d.height);
    }
    const scale = Math.min(rect.width / (maxX - minX + 120), rect.height / (maxY - minY + 120));
    this.camera.scale = scale;
    this.camera.x = (minX + maxX) / 2;
    this.camera.y = (minY + maxY) / 2;
  }

  private toScreen(x: number, y: number): [number, number] {
    const rect = this.canvas.getBoundingClientRect();
    return [
      (x - this.camera.x) * this.camera.scale + rect.width / 2,
      (y - this.camera.y) * this.camera.scale + rect.height / 2,
    ];
  }

  toWorld(sx: number, sy: number): [number, number] {
    const rect = this.canvas.getBoundingClientRect();
    return [
      (sx - rect.width / 2) / this.camera.scale + this.camera.x,
      (sy - rect.height / 2) / this.camera.scale + this.camera.y,
    ];
  }

  pan(dx: number, dy: number): void {
    this.camera.x -= dx / this.camera.scale;
    this.camera.y -= dy / this.camera.scale;
  }

  zoom(factor: number, aroundX: number, aroundY: number): void {
    const [wx, wy] = this.toWorld(aroundX, aroundY);
    this.camera.scale = Math.max(0.18, Math.min(3.2, this.camera.scale * factor));
    const [nx, ny] = this.toWorld(aroundX, aroundY);
    this.camera.x += wx - nx;
    this.camera.y += wy - ny;
  }

  hitTest(sx: number, sy: number): HitResult | undefined {
    let best: { d: number; hit: HitResult } | undefined;
    for (const box of this.hitboxes) {
      const d = Math.hypot(box.x - sx, box.y - sy);
      if (d <= box.r && (!best || d < best.d)) best = { d, hit: box.hit };
    }
    return best?.hit;
  }

  /** Places drawn on the current slice: this floor, plus all outdoor streets. */
  private visiblePlaces(state: GameState): Place[] {
    return [...state.city.graph.places.values()].filter(
      (p) => p.floor === this.floor || !p.indoor,
    );
  }

  draw(state: GameState): void {
    const ctx = this.ctx;
    const rect = this.canvas.getBoundingClientRect();
    this.hitboxes = [];

    ctx.clearRect(0, 0, rect.width, rect.height);
    ctx.fillStyle = "#05070a";
    ctx.fillRect(0, 0, rect.width, rect.height);

    this.drawDistricts(state);
    this.drawBuildings(state);
    this.drawEdges(state);
    this.drawPlaces(state);
    this.drawNodes(state);
    this.drawNpcs(state);
    this.drawPlayer(state);
  }

  private drawDistricts(state: GameState): void {
    const ctx = this.ctx;
    for (const d of state.city.districts.values()) {
      const [x, y] = this.toScreen(d.x, d.y);
      const w = d.width * this.camera.scale;
      const h = d.height * this.camera.scale;
      ctx.fillStyle = COLOURS.district;
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = COLOURS.districtLine;
      ctx.lineWidth = 1;
      ctx.strokeRect(x, y, w, h);
      ctx.fillStyle = "#243240";
      ctx.font = "10px ui-monospace, monospace";
      ctx.fillText(d.name.toUpperCase(), x + 8, y + 16);
    }
  }

  private drawBuildings(state: GameState): void {
    const ctx = this.ctx;
    for (const b of state.city.buildings.values()) {
      const [x, y] = this.toScreen(b.x - 14, b.y - 14);
      const w = (b.width + 28) * this.camera.scale;
      const h = (b.depth + 28) * this.camera.scale;
      const onThisFloor = this.floor < b.floors;
      ctx.fillStyle = onThisFloor ? COLOURS.building : "#0a0f14";
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = onThisFloor ? COLOURS.buildingLine : "#141c24";
      ctx.strokeRect(x, y, w, h);
      if (this.camera.scale > 0.4) {
        ctx.fillStyle = onThisFloor ? "#4a5f70" : "#2a3742";
        ctx.font = "10px ui-monospace, monospace";
        ctx.fillText(`${b.name}${b.floors > 1 ? ` · ${b.floors}F` : ""}`, x + 5, y - 4);
      }
    }
  }

  private drawEdges(state: GameState): void {
    const ctx = this.ctx;
    const graph = state.city.graph;
    ctx.lineWidth = 1;
    for (const edge of graph.edges.values()) {
      const a = graph.places.get(edge.a);
      const b = graph.places.get(edge.b);
      if (!a || !b) continue;
      const visible =
        (a.floor === this.floor || !a.indoor) && (b.floor === this.floor || !b.indoor);
      if (!visible) continue;
      const [ax, ay] = this.toScreen(a.x, a.y);
      const [bx, by] = this.toScreen(b.x, b.y);
      const door = edge.doorId ? graph.doors.get(edge.doorId) : undefined;
      if (door && door.locked && !door.failOpen) {
        ctx.strokeStyle = "#4a2b2b";
        ctx.setLineDash([3, 3]);
      } else {
        ctx.strokeStyle = COLOURS.edge;
        ctx.setLineDash([]);
      }
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  private drawPlaces(state: GameState): void {
    const ctx = this.ctx;
    for (const place of this.visiblePlaces(state)) {
      const [x, y] = this.toScreen(place.x, place.y);
      const r = Math.max(3, Math.min(14, place.radius * this.camera.scale * 0.35));
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = place.indoor ? COLOURS.place : COLOURS.placePublic;
      ctx.fill();
      if (place.zone === "restricted") {
        ctx.strokeStyle = COLOURS.restricted;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      if (this.selection?.kind === "place" && this.selection.id === place.id) {
        ctx.strokeStyle = COLOURS.selection;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(x, y, r + 4, 0, Math.PI * 2);
        ctx.stroke();
      }
      if (this.camera.scale > 0.55) {
        ctx.fillStyle = "#3d4d5a";
        ctx.font = "9px ui-monospace, monospace";
        ctx.fillText(place.name, x + r + 3, y + 3);
      }
      this.hitboxes.push({
        x,
        y,
        r: r + 5,
        hit: { selection: { kind: "place", id: place.id }, label: place.name },
      });
    }
  }

  private drawNodes(state: GameState): void {
    const ctx = this.ctx;
    const reach = computeReach(state);
    // Devices stack up in a room, so fan them around their place.
    const byPlace = new Map<string, NetworkNode[]>();
    for (const node of state.city.nodes.values()) {
      const place = state.city.graph.places.get(node.placeId);
      if (!place || (place.floor !== this.floor && place.indoor)) continue;
      byPlace.set(node.placeId, [...(byPlace.get(node.placeId) ?? []), node]);
    }

    for (const [placeId, nodes] of byPlace) {
      const place = state.city.graph.places.get(placeId)!;
      const shown = nodes.slice(0, 14);
      shown.forEach((node, i) => {
        const angle = (i / Math.max(1, shown.length)) * Math.PI * 2;
        const spread = 20 + Math.min(14, shown.length) * 0.8;
        const [x, y] = this.toScreen(
          place.x + Math.cos(angle) * spread,
          place.y + Math.sin(angle) * spread,
        );
        const inReach = reach.has(node.id);
        const size = node.breached ? 4 : 3;
        ctx.fillStyle = node.breached
          ? COLOURS.nodeBreached
          : inReach
            ? COLOURS.nodeReach
            : COLOURS.node;
        ctx.globalAlpha = node.breached || inReach ? 1 : 0.5;
        ctx.fillRect(x - size / 2, y - size / 2, size, size);
        ctx.globalAlpha = 1;

        if (this.selection?.kind === "node" && this.selection.id === node.id) {
          ctx.strokeStyle = COLOURS.selection;
          ctx.lineWidth = 1;
          ctx.strokeRect(x - size / 2 - 3, y - size / 2 - 3, size + 6, size + 6);
        }
        this.hitboxes.push({
          x,
          y,
          r: 7,
          hit: { selection: { kind: "node", id: node.id }, label: node.label },
        });
      });
    }
  }

  private npcColour(person: Npc): string {
    if (person.condition === "incapacitated" || person.condition === "hospitalised") return COLOURS.npcDown;
    if (person.suspicion > 0.4) return COLOURS.npcSuspicious;
    if (person.profileLayer > 0) return COLOURS.npcProfiled;
    return COLOURS.npc;
  }

  /** Interpolated position, so people visibly walk rather than teleport. */
  private npcPosition(state: GameState, person: Npc): [number, number] | undefined {
    const graph = state.city.graph;
    if (person.transit) {
      const from = graph.places.get(person.transit.fromPlaceId);
      const to = graph.places.get(person.transit.toPlaceId);
      if (!from || !to) return undefined;
      const t = Math.max(0, Math.min(1, person.transit.t));
      const floor = t < 0.5 ? from.floor : to.floor;
      const indoor = t < 0.5 ? from.indoor : to.indoor;
      if (floor !== this.floor && indoor) return undefined;
      return [from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t];
    }
    const place = graph.places.get(person.placeId);
    if (!place || (place.floor !== this.floor && place.indoor)) return undefined;
    return [place.x, place.y];
  }

  private drawNpcs(state: GameState): void {
    const ctx = this.ctx;
    // Deterministic jitter so people in one room do not sit on top of each other.
    let index = 0;
    for (const person of state.npcs.values()) {
      index++;
      const world = this.npcPosition(state, person);
      if (!world) continue;
      const jx = Math.cos(index * 2.399) * 9;
      const jy = Math.sin(index * 2.399) * 9;
      const [x, y] = this.toScreen(world[0] + jx, world[1] + jy);

      ctx.beginPath();
      ctx.arc(x, y, person.profileLayer > 0 ? 4 : 3, 0, Math.PI * 2);
      ctx.fillStyle = this.npcColour(person);
      ctx.fill();

      if (person.tagged) {
        ctx.strokeStyle = COLOURS.restricted;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(x, y, 7, 0, Math.PI * 2);
        ctx.stroke();
      }
      if (person.activeImpulse) {
        ctx.strokeStyle = COLOURS.staff;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(x, y, 9, 0, Math.PI * 2);
        ctx.stroke();
      }
      if (this.selection?.kind === "npc" && this.selection.id === person.id) {
        ctx.strokeStyle = COLOURS.selection;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(x, y, 11, 0, Math.PI * 2);
        ctx.stroke();
      }

      if (person.revealedFields.has("identity") && this.camera.scale > 0.45) {
        ctx.fillStyle = "#93a6b6";
        ctx.font = "9px ui-monospace, monospace";
        ctx.fillText(person.name, x + 7, y - 4);
        if (this.camera.scale > 0.8) {
          ctx.fillStyle = "#4d5b68";
          ctx.fillText(describeNpc(person, state.city.graph, state.time).slice(0, 40), x + 7, y + 6);
        }
      }

      this.hitboxes.push({
        x,
        y,
        r: 9,
        hit: { selection: { kind: "npc", id: person.id }, label: person.name },
      });
    }
  }

  private drawPlayer(state: GameState): void {
    const ctx = this.ctx;
    const graph = state.city.graph;
    const player = state.player;

    const place = graph.places.get(player.placeId);
    if (place && (place.floor === this.floor || !place.indoor)) {
      let wx = place.x;
      let wy = place.y;
      if (player.transit) {
        const from = graph.places.get(player.transit.fromPlaceId);
        const to = graph.places.get(player.transit.toPlaceId);
        if (from && to) {
          wx = from.x + (to.x - from.x) * player.transit.t;
          wy = from.y + (to.y - from.y) * player.transit.t;
        }
      }
      const [x, y] = this.toScreen(wx, wy);
      // Hack radius, so range is a thing you can see rather than guess.
      ctx.strokeStyle = "rgba(53, 224, 200, 0.16)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(x, y, player.hackRange * this.camera.scale, 0, Math.PI * 2);
      ctx.stroke();

      ctx.fillStyle = COLOURS.player;
      ctx.beginPath();
      ctx.moveTo(x, y - 7);
      ctx.lineTo(x + 6, y + 5);
      ctx.lineTo(x - 6, y + 5);
      ctx.closePath();
      ctx.fill();
    }

    if (player.drone.deployed) {
      const dronePlace = graph.places.get(player.drone.placeId);
      if (dronePlace && (dronePlace.floor === this.floor || !dronePlace.indoor)) {
        const [x, y] = this.toScreen(dronePlace.x, dronePlace.y);
        ctx.strokeStyle = "rgba(127, 224, 127, 0.16)";
        ctx.beginPath();
        ctx.arc(x, y, player.drone.range * this.camera.scale, 0, Math.PI * 2);
        ctx.stroke();
        ctx.strokeStyle = COLOURS.drone;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(x, y, 5, 0, Math.PI * 2);
        ctx.moveTo(x - 8, y);
        ctx.lineTo(x + 8, y);
        ctx.moveTo(x, y - 8);
        ctx.lineTo(x, y + 8);
        ctx.stroke();
      }
    }
  }
}
