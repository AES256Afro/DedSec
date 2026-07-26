/**
 * The ctOS popup.
 *
 * One card, over whoever you are looking at.
 *
 * The first version put a card over everybody ctOS could read, on the grounds
 * that the city genuinely does know all of it. That is true and it was still
 * wrong: information the game is always showing you is wallpaper, nobody reads
 * nine cards at once, and there was nothing you could *do* with any of them
 * without first pressing a key to open something else.
 *
 * So the crowd is anonymous until you aim at it. Put the crosshair on somebody
 * and the readout resolves, with what you can do about them attached to it. The
 * only thing the unaimed-at crowd carries is a flag marker over the people the
 * caseload has something on, which is what keeps them findable across a plaza
 * without sweeping the pavement person by person.
 *
 * These are DOM elements, not sprites. Watch Dogs draws them the same way and
 * for the same reason: text in a 3D scene either fights the renderer or goes
 * illegible at distance, and everything the profiler already knows how to render
 * is HTML. The 3D layer supplies one number — where they are on screen.
 */

import * as THREE from "three";

import { caseFlag, casesFor } from "../../src/case/cases.js";
import type { CaseRecord } from "../../src/case/types.js";
import type { GameState } from "../../src/sim/state.js";
import type { CrowdMember } from "./crowd.js";

/** Past this, a person is scenery. Matched to the profiler's own reach. */
export const CARD_RANGE = 150;
/** How long the card lingers after you look away, in seconds. */
const LINGER = 0.45;

/** What the card is offering, in the order the number keys map to. */
export interface CardAction {
  key: string;
  label: string;
  detail: string;
  kind: string;
}

export class CardLayer {
  private el: HTMLElement;
  private signature = "";
  private fading = 0;
  private projected = new THREE.Vector3();
  /** The actions the card is currently showing, so the keys can fire them. */
  private offered: CardAction[] = [];

  constructor(container: HTMLElement) {
    this.el = document.createElement("div");
    this.el.className = "ctos-card";
    this.el.hidden = true;
    container.appendChild(this.el);
  }

  actions(): CardAction[] {
    return this.offered;
  }

  /**
   * @param member   the person under the crosshair, or nothing.
   * @param optical  whether you can physically see them, or only ctOS can.
   */
  update(
    state: GameState,
    member: CrowdMember | undefined,
    camera: THREE.PerspectiveCamera,
    optical: boolean,
    width: number,
    height: number,
    delta: number,
  ): void {
    if (!member) {
      // Linger briefly rather than blinking out the instant the crosshair
      // drifts. A card that vanishes on a twitch is unreadable in a crowd.
      this.fading += delta;
      if (this.fading > LINGER) {
        this.el.hidden = true;
        this.signature = "";
        this.offered = [];
      } else {
        this.el.style.opacity = String(1 - this.fading / LINGER);
      }
      return;
    }
    this.fading = 0;

    const distance = camera.position.distanceTo(member.position);
    this.projected.copy(member.position);
    this.projected.y += 2.15; // float it just above the head
    this.projected.project(camera);
    if (this.projected.z > 1 || distance > CARD_RANGE) {
      this.el.hidden = true;
      return;
    }

    const x = (this.projected.x * 0.5 + 0.5) * width;
    const y = (-this.projected.y * 0.5 + 0.5) * height;

    const actions = availableActions(state, member);
    const signature = this.signatureOf(state, member, optical, actions);
    if (this.signature !== signature) {
      this.el.hidden = false;
      this.el.innerHTML = this.render(state, member, optical, actions);
      this.signature = signature;
      this.offered = actions;
    }

    // Keep the whole card on screen: near the edges it slides in rather than
    // hanging half off, and it never climbs into the HUD.
    const w = this.el.offsetWidth || 260;
    const h = this.el.offsetHeight || 120;
    const left = Math.min(Math.max(x, w / 2 + 12), width - w / 2 - 12);
    const top = Math.min(Math.max(y, h + 60), height - 16);

    this.el.style.transform = `translate(-50%, -100%) translate(${left.toFixed(1)}px, ${top.toFixed(1)}px)`;
    this.el.style.opacity = "1";
    this.el.hidden = false;
  }

  private signatureOf(state: GameState, member: CrowdMember, optical: boolean, actions: CardAction[]): string {
    const npc = member.npc;
    return [
      npc.id,
      npc.profileLayer,
      member.flag ?? "-",
      member.scanned ? "s" : "-",
      optical ? "o" : "-",
      actions.map((a) => a.kind + a.label).join(","),
      casesFor(state, npc.id)
        .map((c) => c.status)
        .join(""),
    ].join("|");
  }

  private render(state: GameState, member: CrowdMember, optical: boolean, actions: CardAction[]): string {
    const npc = member.npc;
    const flag = caseFlag(state, npc.id);
    const classes = ["ctos-card__inner", "is-target"];
    if (flag) classes.push(`is-${flag}`);
    if (!optical) classes.push("is-remote");

    if (!member.scanned) {
      return `<div class="${classes.join(" ")}">
        <div class="ctos-row"><span class="ctos-name is-unknown">READING…</span></div>
        <div class="ctos-scanbar"><i></i></div>
      </div>`;
    }

    const chip = flag === "harm" ? `<span class="ctos-chip is-harm">FLAGGED</span>`
      : flag === "need" ? `<span class="ctos-chip is-need">AT RISK</span>`
      : "";
    const layer = npc.profileLayer > 0 ? `<span class="ctos-layer">L${npc.profileLayer}</span>` : "";

    // The tell — never the verdict. The player draws the conclusion.
    const record = casesFor(state, npc.id).find((c) => c.status !== "unseen");
    const tell = record
      ? `<div class="ctos-tell">${escapeHtml(record.status === "open" ? record.headline : record.tell)}</div>`
      : "";

    const menu = actions.length
      ? `<div class="ctos-actions">${actions
          .map(
            (a) => `<div class="ctos-action is-${a.kind}">
              <kbd>${a.key}</kbd><b>${escapeHtml(a.label)}</b><span>${escapeHtml(a.detail)}</span>
            </div>`,
          )
          .join("")}</div>`
      : "";

    return `<div class="${classes.join(" ")}">
      <div class="ctos-row"><span class="ctos-name">${escapeHtml(npc.name)}</span>${chip}${layer}</div>
      <div class="ctos-role">${escapeHtml(npc.occupation)}</div>
      <div class="ctos-money">$${npc.income.toLocaleString("en-US")}</div>
      <div class="ctos-quirk">${escapeHtml(npc.quirk)}</div>
      ${tell}
      ${menu}
    </div>`;
  }
}

/**
 * What this person is currently offering.
 *
 * Deliberately short. The card is a thing you read while standing in a street,
 * not a menu — anything longer than about four lines belongs in the panel `E`
 * opens. Reading a device always comes first because it is what turns a flag
 * into a situation.
 */
export function availableActions(state: GameState, member: CrowdMember): CardAction[] {
  const out: CardAction[] = [];
  const npc = member.npc;
  if (!member.scanned) return out;

  if (npc.profileLayer < 2) {
    const unread = [npc.phoneNodeId, ...npc.secrets.flatMap((s) => s.sourceNodeIds)].some(
      (id) => id && !state.player.breachedNodeIds.has(id),
    );
    if (unread) {
      out.push({
        key: "F",
        kind: "read",
        label: npc.profileLayer === 0 ? "Read their phone" : "Find a second source",
        detail: npc.profileLayer === 0 ? "Name, contacts, pattern of life." : "The layer that pays.",
      });
    }
  }

  const open = casesFor(state, npc.id).filter((c): c is CaseRecord => c.status === "open");
  for (const record of open) {
    record.resolutions.forEach((resolution, i) => {
      if (out.length >= 5) return;
      out.push({
        key: String(i + 1),
        kind: resolution.kind,
        label: resolution.label,
        detail: resolution.detail,
      });
    });
  }

  return out;
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
