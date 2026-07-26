/**
 * The ctOS popup.
 *
 * These are DOM elements, not sprites. Watch Dogs draws them the same way and
 * for the same reason: text in a 3D scene either fights the renderer or gets
 * illegible at distance, and everything the profiler already knows how to
 * render is HTML. So the 3D layer supplies one number per person — where they
 * are on screen — and the card is just a div that gets told where to sit.
 *
 * The consequence is that the profiling UI built for the 2D client carries
 * across unchanged, which is most of why this port was a week's work and not a
 * rewrite.
 */

import * as THREE from "three";

import { caseFlag, casesFor } from "../../src/case/cases.js";
import type { GameState } from "../../src/sim/state.js";
import type { CrowdMember } from "./crowd.js";

/** Past this, a person is scenery. Matched to the profiler's own reach. */
export const CARD_RANGE = 150;
/** More than this on screen at once and it stops being readable. */
const MAX_CARDS = 9;

interface Slot {
  el: HTMLElement;
  signature: string;
  /** Measured once per content change; re-reading it every frame forces layout. */
  width: number;
  height: number;
}

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export class CardLayer {
  private slots: Slot[] = [];
  private projected = new THREE.Vector3();

  constructor(private readonly container: HTMLElement) {}

  /**
   * @param profiled ids ctOS is currently reading. Includes people behind
   *                 walls — that is the fantasy, and it is what keeps a street
   *                 populated when two-thirds of the city is indoors.
   * @param optical  the subset you can also physically see. Everyone else gets
   *                 the through-wall treatment, so the overlay never pretends
   *                 you are looking at someone you are not.
   * @param focusId  the person under the crosshair, drawn larger and in front.
   */
  update(
    state: GameState,
    members: CrowdMember[],
    camera: THREE.PerspectiveCamera,
    profiled: Set<string>,
    optical: Set<string>,
    focusId: string | undefined,
    width: number,
    height: number,
  ): void {
    const candidates: Array<{ member: CrowdMember; x: number; y: number; distance: number }> = [];

    for (const member of members) {
      if (!profiled.has(member.npc.id)) continue;
      const distance = camera.position.distanceTo(member.position);
      if (distance > CARD_RANGE || distance < 1.2) continue;

      this.projected.copy(member.position);
      this.projected.y += 2.15; // float it just above the head
      this.projected.project(camera);
      if (this.projected.z > 1) continue; // behind the camera

      const x = (this.projected.x * 0.5 + 0.5) * width;
      const y = (-this.projected.y * 0.5 + 0.5) * height;
      if (x < -160 || x > width + 160 || y < -120 || y > height + 120) continue;

      candidates.push({ member, x, y, distance });
    }

    // Nearest wins, except that the focused person always gets a card.
    candidates.sort((a, b) => {
      if (a.member.npc.id === focusId) return -1;
      if (b.member.npc.id === focusId) return 1;
      return a.distance - b.distance;
    });
    const shown = candidates.slice(0, MAX_CARDS);

    const placed: Box[] = [];
    for (let i = 0; i < shown.length; i++) {
      const { member, x, y, distance } = shown[i]!;
      const slot = this.slot(i);
      const focused = member.npc.id === focusId;
      const remote = !optical.has(member.npc.id);
      const signature = this.signatureOf(state, member, focused, remote);
      if (slot.signature !== signature) {
        slot.el.innerHTML = this.render(state, member, focused, remote);
        slot.signature = signature;
        slot.width = slot.el.offsetWidth;
        slot.height = slot.el.offsetHeight;
      }
      // Cards shrink with distance but never below legibility, and they fade
      // rather than pop so a busy street does not flicker.
      const scale = focused ? 1 : Math.max(0.72, 1 - (distance / CARD_RANGE) * 0.45);

      // Five people standing on the same plaza put five cards in the same
      // hundred pixels. Nearest keeps its spot and everyone behind it stacks
      // upward, which is both readable and a correct depth cue.
      const lifted = this.lift(placed, x, y, slot.width * scale, slot.height * scale);

      slot.el.style.transform = `translate(-50%, -100%) translate(${x.toFixed(1)}px, ${lifted.toFixed(1)}px) scale(${scale.toFixed(3)})`;
      slot.el.style.opacity = String(focused ? 1 : Math.max(0.4, 1 - (distance / CARD_RANGE) * 0.7));
      slot.el.style.zIndex = String(focused ? 50 : 10 + Math.round(CARD_RANGE - distance));
      slot.el.hidden = false;
    }

    for (let i = shown.length; i < this.slots.length; i++) this.slots[i]!.el.hidden = true;
  }

  /** Slide a card up until it clears everything already on screen. */
  private lift(placed: Box[], x: number, y: number, width: number, height: number): number {
    let top = y;
    for (let attempt = 0; attempt < 12; attempt++) {
      const box: Box = { x0: x - width / 2, y0: top - height, x1: x + width / 2, y1: top };
      const hit = placed.find((p) => box.x0 < p.x1 && box.x1 > p.x0 && box.y0 < p.y1 && box.y1 > p.y0);
      if (!hit) {
        placed.push(box);
        return top;
      }
      top = hit.y0 - 6;
    }
    return top;
  }

  private slot(i: number): Slot {
    let slot = this.slots[i];
    if (!slot) {
      const el = document.createElement("div");
      el.className = "ctos-card";
      this.container.appendChild(el);
      slot = { el, signature: "", width: 200, height: 78 };
      this.slots[i] = slot;
    }
    return slot;
  }

  /** Everything the card's *content* depends on. Cheap to compare, so we do. */
  private signatureOf(state: GameState, member: CrowdMember, focused: boolean, remote: boolean): string {
    const npc = member.npc;
    return [
      npc.id,
      npc.profileLayer,
      member.flag ?? "-",
      member.scanned ? "s" : "-",
      focused ? "f" : "-",
      remote ? "r" : "-",
      casesFor(state, npc.id)
        .map((c) => c.status)
        .join(""),
    ].join("|");
  }

  private render(state: GameState, member: CrowdMember, focused: boolean, remote: boolean): string {
    const npc = member.npc;
    const flag = caseFlag(state, npc.id);
    const classes = ["ctos-card__inner"];
    if (flag) classes.push(`is-${flag}`);
    if (focused) classes.push("is-focused");
    if (remote) classes.push("is-remote");

    if (!member.scanned) {
      return `<div class="${classes.join(" ")}">
        <div class="ctos-row"><span class="ctos-name is-unknown">UNIDENTIFIED</span></div>
        <div class="ctos-scanbar"><i></i></div>
      </div>`;
    }

    const chip = flag === "harm" ? `<span class="ctos-chip is-harm">FLAGGED</span>`
      : flag === "need" ? `<span class="ctos-chip is-need">AT RISK</span>`
      : "";
    const layer = npc.profileLayer > 0 ? `<span class="ctos-layer">L${npc.profileLayer}</span>` : "";

    // The tell — never the verdict. The player draws the conclusion.
    const tell = casesFor(state, npc.id).find((c) => c.status !== "unseen");
    const tellLine = tell
      ? `<div class="ctos-tell">${escapeHtml(tell.status === "open" ? tell.headline : tell.tell)}</div>`
      : "";

    return `<div class="${classes.join(" ")}">
      <div class="ctos-row"><span class="ctos-name">${escapeHtml(npc.name)}</span>${chip}${layer}</div>
      <div class="ctos-role">${escapeHtml(npc.occupation)}</div>
      <div class="ctos-money">$${npc.income.toLocaleString("en-US")}</div>
      <div class="ctos-quirk">${escapeHtml(npc.quirk)}</div>
      ${tellLine}
    </div>`;
  }
}

/**
 * Building names, floating over the buildings.
 *
 * Only the eight the simulation actually models get one. That is the whole
 * point: everything with a label has rooms, people and a network behind it, and
 * everything without one is street wall. It is a navigation aid and an honesty
 * marker at the same time.
 */
export class LabelLayer {
  private slots: HTMLElement[] = [];
  private projected = new THREE.Vector3();

  constructor(
    private readonly container: HTMLElement,
    private readonly landmarks: Array<{ name: string; position: THREE.Vector3 }>,
  ) {}

  update(camera: THREE.PerspectiveCamera, width: number, height: number): void {
    let slot = 0;
    for (const landmark of this.landmarks) {
      const distance = camera.position.distanceTo(landmark.position);
      if (distance > 900) continue;

      this.projected.copy(landmark.position).project(camera);
      if (this.projected.z > 1) continue;
      const x = (this.projected.x * 0.5 + 0.5) * width;
      const y = (-this.projected.y * 0.5 + 0.5) * height;
      if (x < 0 || x > width || y < 0 || y > height) continue;

      const el = this.slot(slot++);
      if (el.textContent !== landmark.name) el.textContent = landmark.name;
      el.style.transform = `translate(-50%, -100%) translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
      el.style.opacity = String(Math.max(0.22, 1 - distance / 900));
      el.hidden = false;
    }
    for (let i = slot; i < this.slots.length; i++) this.slots[i]!.hidden = true;
  }

  private slot(i: number): HTMLElement {
    let el = this.slots[i];
    if (!el) {
      el = document.createElement("div");
      el.className = "ctos-label";
      this.container.appendChild(el);
      this.slots[i] = el;
    }
    return el;
  }
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}
