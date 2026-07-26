/**
 * The street client.
 *
 * A different game to the terminal client, out of the same simulation. There is
 * no map, no floor selector, no verb list and no contract board. You walk, the
 * city profiles itself at you, and occasionally a card says something that makes
 * you stop.
 *
 * The loop, in order:
 *
 *   1. advance the sim on a wall clock, exactly as the 2D client does;
 *   2. move the player continuously and snap them back onto the place graph;
 *   3. profile whoever has come into line of sight, a few at a time, so the
 *      street fills in as you walk rather than all at once;
 *   4. project a card over everyone the sim agrees you can see;
 *   5. raycast the crosshair, and let the panel open on whoever is under it.
 *
 * Nothing here contains a game rule. Every mutation goes through the same
 * `src/` functions the tests drive.
 */

import * as THREE from "three";

import { ledgerLine, refreshCases, resolveCase } from "../../src/case/cases.js";
import type { ResolutionKind } from "../../src/case/types.js";
import { formatTime, dayOf } from "../../src/core/time.js";
import { newGame } from "../../src/game.js";
import { computeReach, profilableNpcs } from "../../src/hack/access.js";
import { passiveScan } from "../../src/profile/profiler.js";
import { breach, refreshProfiles, visibleNpcs } from "../../src/sim/actions.js";
import type { GameState } from "../../src/sim/state.js";
import { step } from "../../src/sim/step.js";
import { CARD_RANGE, CardLayer, LabelLayer } from "./cards.js";
import { Crowd } from "./crowd.js";
import { renderProfilePanel } from "./panel.js";
import { PlayerController } from "./player.js";
import { buildCity, nearestOutdoorPlace } from "./world.js";

/** Wall-clock milliseconds per world-minute. Slow: this is a walk, not a shift. */
const MS_PER_MINUTE = 1400;
/** How often the sim's answer to "who can you see" gets recomputed. */
const VISION_INTERVAL_MS = 320;
/** People profiled per vision pass — staggered so the street fills in. */
const SCANS_PER_PASS = 3;

class Street {
  readonly state: GameState;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private player: PlayerController;
  private crowd: Crowd;
  private cards: CardLayer;
  private labels: LabelLayer;
  private raycaster = new THREE.Raycaster();
  private centre = new THREE.Vector2(0, 0);

  /** Everyone ctOS is reading right now — the card set. */
  private profiled = new Set<string>();
  /** The subset you can also actually see, drawn without the through-wall tint. */
  private optical = new Set<string>();
  private focusId: string | undefined;
  private panelOpen = false;
  private panelDirty = true;
  private lastFrame = performance.now();
  private simAccumulator = 0;
  private visionTimer = 0;

  private el = {
    canvas: document.getElementById("scene") as HTMLCanvasElement,
    cards: document.getElementById("cards")!,
    panel: document.getElementById("panel")!,
    panelBody: document.getElementById("panel-body")!,
    clock: document.getElementById("hud-clock")!,
    ledger: document.getElementById("hud-ledger")!,
    prompt: document.getElementById("hud-prompt")!,
    toast: document.getElementById("toast")!,
    hint: document.getElementById("hint")!,
  };

  constructor() {
    const seed = new URLSearchParams(location.search).get("seed") ?? "dedsec";
    this.state = newGame({ seed });

    this.renderer = new THREE.WebGLRenderer({ canvas: this.el.canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.scene.background = new THREE.Color(0x080d14);
    // Fog is doing real work here: it hides the edge of a city that is only a
    // few districts wide, and it is most of why a box skyline reads as depth.
    // Tuned against the actual extent — the city is ~1.6 km across, and the
    // first pass at this was dense enough to swallow every building in it.
    this.scene.fog = new THREE.FogExp2(0x06090d, 0.0011);

    const city = buildCity(this.state);
    this.scene.add(city.root);

    this.player = new PlayerController(this.state, this.el.canvas);
    this.player.setWorld(city.colliders, this.walkableBounds());
    this.scene.add(this.player.camera);

    this.crowd = new Crowd(this.scene);
    this.cards = new CardLayer(this.el.cards);
    this.labels = new LabelLayer(this.el.cards, city.landmarks);

    // Face the middle of the city rather than the origin, which is a corner of
    // it — spawning with your back to every building was not a good first frame.
    const start = this.state.city.graph.place(this.state.player.placeId);
    const centre = this.walkableBounds().getCenter(new THREE.Vector3());
    this.player.spawnAt(start.x, start.y, centre.x, centre.z);

    this.resize();
    window.addEventListener("resize", () => this.resize());
    this.wireKeys();
    this.wirePanel();

    requestAnimationFrame(this.frame);
  }

  /**
   * Stand somewhere, facing something. Used by the tooling to look at the city
   * from a named corner of it, and by the console for the same reason. The sim
   * only ever cares which place you are nearest, so this is a legal move rather
   * than a cheat: it is the same call the client makes on spawn.
   */
  goTo(x: number, z: number, lookAtX?: number, lookAtZ?: number): string | undefined {
    const centre = this.walkableBounds().getCenter(new THREE.Vector3());
    this.player.spawnAt(x, z, lookAtX ?? centre.x, lookAtZ ?? centre.z);
    this.refreshVision();
    return nearestOutdoorPlace(this.state, x, z)?.id;
  }

  /** Draw counters plus what the overlay is currently showing. */
  stats(): { triangles: number; calls: number; cards: number; profiled: number; optical: number } {
    return {
      triangles: this.renderer.info.render.triangles,
      calls: this.renderer.info.render.calls,
      cards: this.el.cards.querySelectorAll(".ctos-card:not([hidden])").length,
      profiled: this.profiled.size,
      optical: this.optical.size,
    };
  }

  /** The outdoor world, with enough margin to stand at the edge of it. */
  private walkableBounds(): THREE.Box3 {
    const box = new THREE.Box3();
    for (const district of this.state.city.districts.values()) {
      box.expandByPoint(new THREE.Vector3(district.x - 40, 0, district.y - 40));
      box.expandByPoint(new THREE.Vector3(district.x + district.width + 40, 0, district.y + district.height + 40));
    }
    return box;
  }

  private resize(): void {
    const width = window.innerWidth;
    const height = window.innerHeight;
    this.renderer.setSize(width, height, false);
    this.player.camera.aspect = width / height;
    this.player.camera.updateProjectionMatrix();
  }

  /* ------------------------------------------------------------- controls */

  private wireKeys(): void {
    window.addEventListener("keydown", (event) => {
      // The moment somebody starts walking they have stopped reading. Get out
      // of the way rather than making them find the key that dismisses it.
      if (!this.el.hint.hidden && ["KeyW", "KeyA", "KeyS", "KeyD"].includes(event.code)) {
        this.el.hint.hidden = true;
      }
      switch (event.code) {
        case "KeyE":
          if (this.focusId) this.openPanel();
          break;
        case "KeyF":
          this.quickBreach();
          break;
        case "Escape":
          this.closePanel();
          break;
        case "KeyH":
          this.el.hint.hidden = !this.el.hint.hidden;
          break;
        default:
          break;
      }
    });
  }

  private wirePanel(): void {
    this.el.panel.addEventListener("click", (event) => {
      const target = event.target as HTMLElement;

      const breachBtn = target.closest<HTMLElement>("[data-breach]");
      if (breachBtn) {
        this.toast(breach(this.state, breachBtn.dataset["breach"]!));
        refreshProfiles(this.state);
        refreshCases(this.state);
        this.panelDirty = true;
        return;
      }

      const act = target.closest<HTMLElement>("[data-case]");
      if (act) {
        const outcome = resolveCase(
          this.state,
          act.dataset["case"]!,
          act.dataset["resolution"] as ResolutionKind,
        );
        this.toast(outcome);
        this.panelDirty = true;
        // Walking away closes the whole encounter — that is what it means.
        if (act.dataset["resolution"] === "walk_away") this.closePanel();
        return;
      }

      if (target.closest("[data-close]")) this.closePanel();
    });
  }

  private openPanel(): void {
    if (!this.focusId) return;
    this.panelOpen = true;
    this.panelDirty = true;
    this.el.panel.hidden = false;
    // You cannot click a button while the pointer is captured for looking.
    if (document.pointerLockElement) document.exitPointerLock();
  }

  private closePanel(): void {
    this.panelOpen = false;
    this.el.panel.hidden = true;
  }

  /** F: take the obvious next step on whoever you are looking at. */
  private quickBreach(): void {
    const person = this.focusId ? this.state.npcs.get(this.focusId) : undefined;
    if (!person) return;
    const reach = computeReach(this.state);
    const target = [person.phoneNodeId, ...person.secrets.flatMap((s) => s.sourceNodeIds)]
      .filter((id): id is string => Boolean(id))
      .find((id) => !this.state.player.breachedNodeIds.has(id) && reach.has(id));
    if (!target) {
      this.toast({ ok: false, message: "Nothing of theirs is in range from here." });
      return;
    }
    this.toast(breach(this.state, target));
    refreshProfiles(this.state);
    refreshCases(this.state);
    this.panelDirty = true;
  }

  private toast(outcome: { ok: boolean; message: string }): void {
    const el = this.el.toast;
    el.textContent = outcome.message;
    el.classList.toggle("bad", !outcome.ok);
    el.hidden = false;
    window.clearTimeout((el as HTMLElement & { _t?: number })._t);
    (el as HTMLElement & { _t?: number })._t = window.setTimeout(() => {
      el.hidden = true;
    }, 3800);
  }

  /* ----------------------------------------------------------------- loop */

  private frame = (now: number): void => {
    const delta = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;

    // 1. The world runs whether or not you are doing anything.
    this.simAccumulator += (delta * 1000) / MS_PER_MINUTE;
    let ticks = 0;
    while (this.simAccumulator >= 1 && ticks < 30) {
      step(this.state, 1);
      this.simAccumulator -= 1;
      ticks++;
    }

    // 2. You.
    if (!this.panelOpen) this.player.update(delta);

    // 3. Who is in sight, and who is worth profiling next.
    this.visionTimer += delta * 1000;
    if (this.visionTimer >= VISION_INTERVAL_MS) {
      this.visionTimer = 0;
      this.refreshVision();
    }

    // 4. Draw.
    this.crowd.sync(this.state, now);
    if (!this.panelOpen) this.updateFocus();
    this.cards.update(
      this.state,
      this.crowd.all(),
      this.player.camera,
      this.profiled,
      this.optical,
      this.focusId,
      window.innerWidth,
      window.innerHeight,
    );
    this.labels.update(this.player.camera, window.innerWidth, window.innerHeight);
    this.renderer.render(this.scene, this.player.camera);
    this.renderHud();

    requestAnimationFrame(this.frame);
  };

  /**
   * The passive scan, run as a background process rather than a button.
   *
   * This is the ctOS fantasy at its most literal: you do not choose to profile
   * anyone, the city simply tells you about everybody you can see. Rate-limiting
   * it is not a performance measure — it is so that a crowded plaza resolves
   * person by person in front of you instead of arriving as a wall of text.
   */
  private refreshVision(): void {
    const seen = profilableNpcs(this.state);
    this.profiled = new Set(seen.map((n) => n.id));
    this.optical = new Set(visibleNpcs(this.state).map((n) => n.id));

    const position = this.player.camera.position;
    const unscanned = seen
      .filter((n) => !n.revealedFields.has("identity"))
      .map((n) => {
        const member = this.crowd.member(n.id);
        return { npc: n, distance: member ? member.position.distanceTo(position) : Infinity };
      })
      .sort((a, b) => a.distance - b.distance)
      .slice(0, SCANS_PER_PASS);

    for (const { npc } of unscanned) passiveScan(this.state, npc);
    if (unscanned.length > 0) refreshCases(this.state);
  }

  /**
   * What the crosshair is on.
   *
   * No occlusion test, on purpose. You are pointing at a *card*, not a face —
   * ctOS is the interface, and half the interesting people in a city are behind
   * a wall. Restricting it to the profiled set is what keeps that from becoming
   * "click anyone in the district".
   */
  private updateFocus(): void {
    this.raycaster.setFromCamera(this.centre, this.player.camera);
    this.raycaster.far = CARD_RANGE;
    const hits = this.raycaster.intersectObject(this.crowd.bodies, false);
    let next: string | undefined;
    for (const hit of hits) {
      const id = hit.instanceId === undefined ? undefined : this.crowd.npcIdAt(hit.instanceId);
      if (id && this.profiled.has(id)) {
        next = id;
        break;
      }
    }
    if (next !== this.focusId) {
      this.focusId = next;
      this.panelDirty = true;
    }
  }

  private renderHud(): void {
    this.el.clock.textContent = `${formatTime(this.state.time)} · day ${dayOf(this.state.time) + 1}`;
    this.el.ledger.textContent = ledgerLine(this.state.ledger);

    const person = this.focusId ? this.state.npcs.get(this.focusId) : undefined;
    this.el.prompt.hidden = !person || this.panelOpen;
    if (person && !this.panelOpen) {
      this.el.prompt.textContent = person.revealedFields.has("identity")
        ? `E — look closer at ${person.name}`
        : "E — look closer";
    }

    if (this.panelOpen && this.panelDirty && person) {
      this.el.panelBody.innerHTML = renderProfilePanel(this.state, person, computeReach(this.state));
      this.panelDirty = false;
    }
  }
}

const street = new Street();

// The same handle the terminal client exposes (shape declared once, in
// `web/global.d.ts`), for the smoke test and for poking at a live world. It is
// a reference to the real state, not a back door around the rules.
window.dedsec = {
  state: () => street.state,
  goTo: (x, z, lookAtX, lookAtZ) => street.goTo(x, z, lookAtX, lookAtZ),
  // What the renderer actually put through the pipe last frame. A WebGL canvas
  // without `preserveDrawingBuffer` reads back blank once it has been
  // composited, so "did anything draw" cannot be answered by sampling pixels;
  // it can be answered by asking the renderer.
  stats: () => street.stats(),
};
