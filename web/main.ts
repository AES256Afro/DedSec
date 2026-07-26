/**
 * App wiring.
 *
 * The loop is: advance the sim on a wall-clock timer, redraw the map every
 * animation frame, and re-render panels whenever the world could have changed.
 * All world mutation goes through `src/sim/actions.ts` — this file contains no
 * game rules, only the translation from clicks to commands.
 */

import { newGame } from "../src/game.js";
import type { GameState } from "../src/sim/state.js";
import {
  breach,
  deployDrone,
  flyDroneTo,
  npcVerbs,
  nodeVerbs,
  recallDrone,
  release,
  runNodeVerb,
  runNpcVerb,
  walkTo,
} from "../src/sim/actions.js";
import { activateMission, missionRuntimes } from "../src/mission/runtime.js";
import { step } from "../src/sim/step.js";
import { invoke, verb } from "../src/hack/verbs.js";
import { MapRenderer, type MapSelection } from "./render/map.js";
import {
  renderClock,
  renderFeed,
  renderMissions,
  renderNetwork,
  renderNodeInspector,
  renderNpcInspector,
  renderPlaceInspector,
  renderTrace,
  sortOffers,
} from "./ui/panels.js";

const CHANNELS = ["hack", "social", "npc", "security", "emergency", "world", "mission"] as const;

class App {
  state: GameState;
  map: MapRenderer;
  speed = 1;
  /** Wall-clock milliseconds per world-minute at 1×. */
  readonly msPerMinute = 900;
  private accumulator = 0;
  private lastFrame = performance.now();
  private channelFilter = new Set<string>();
  private dirty = true;
  /**
   * The last place the player clicked. Verbs that can send someone somewhere —
   * a forged message, a rerouted parcel, a work order — use this as their
   * destination, so "select the stairwell, then lure him" is a real, legible
   * two-step play rather than a hidden default.
   */
  private targetPlaceId?: string;

  private el = {
    clockTime: document.getElementById("clock-time")!,
    clockDay: document.getElementById("clock-day")!,
    traceFill: document.getElementById("trace-fill")!,
    traceWord: document.getElementById("trace-word")!,
    missions: document.getElementById("mission-list")!,
    feed: document.getElementById("feed")!,
    feedFilters: document.getElementById("feed-filters")!,
    inspector: document.getElementById("inspector")!,
    inspectorTitle: document.getElementById("inspector-title")!,
    network: document.getElementById("network")!,
    reachCount: document.getElementById("reach-count")!,
    floorSelect: document.getElementById("floor-select") as HTMLSelectElement,
    droneBtn: document.getElementById("btn-drone") as HTMLButtonElement,
    legend: document.getElementById("map-legend")!,
    toast: document.getElementById("toast")!,
  };

  constructor() {
    const seed = new URLSearchParams(location.search).get("seed") ?? "dedsec";
    this.state = newGame({ seed });
    this.map = new MapRenderer(document.getElementById("map") as HTMLCanvasElement);
    this.map.resize();
    this.map.fit(this.state);

    this.buildFloorSelect();
    this.buildFilters();
    this.buildLegend();
    this.wireCanvas();
    this.wireGlobalClicks();
    this.wireKeys();
    this.wireSpeed();

    // The tutorial contract is the intended on-ramp; open it immediately so a
    // new player has something to aim at rather than a city and no verbs.
    activateMission(this.state, "pattern_of_life");

    window.addEventListener("resize", () => {
      this.map.resize();
      this.dirty = true;
    });

    requestAnimationFrame(this.frame);
  }

  /* -------------------------------------------------------------- chrome */

  private buildFloorSelect(): void {
    const floors = new Set<number>();
    for (const place of this.state.city.graph.places.values()) floors.add(place.floor);
    this.el.floorSelect.innerHTML = [...floors]
      .sort((a, b) => a - b)
      .map((f) => `<option value="${f}">${f === 0 ? "Ground" : `Level ${f}`}</option>`)
      .join("");
    this.el.floorSelect.addEventListener("change", () => {
      this.map.floor = Number(this.el.floorSelect.value);
      this.dirty = true;
    });
  }

  private buildFilters(): void {
    this.el.feedFilters.innerHTML = CHANNELS.map(
      (c) => `<button data-channel="${c}">${c.slice(0, 3)}</button>`,
    ).join("");
    this.el.feedFilters.addEventListener("click", (event) => {
      const button = (event.target as HTMLElement).closest<HTMLElement>("[data-channel]");
      if (!button) return;
      const channel = button.dataset["channel"]!;
      if (this.channelFilter.has(channel)) this.channelFilter.delete(channel);
      else this.channelFilter.add(channel);
      this.el.feedFilters.querySelectorAll<HTMLElement>("[data-channel]").forEach((b) => {
        b.classList.toggle("is-active", this.channelFilter.has(b.dataset["channel"]!));
      });
      this.dirty = true;
    });
  }

  private buildLegend(): void {
    const rows: Array<[string, string]> = [
      ["var(--accent)", "you · hack range"],
      ["var(--good)", "breached device"],
      ["var(--accent)", "device in reach"],
      ["var(--npc, #8fa3b4)", "person"],
      ["var(--warn)", "suspicious"],
      ["var(--restricted)", "restricted zone"],
    ];
    this.el.legend.innerHTML = rows
      .map(([colour, label]) => `<div class="legend-row"><span class="swatch" style="background:${colour}"></span>${label}</div>`)
      .join("");
  }

  private wireSpeed(): void {
    document.querySelectorAll<HTMLElement>("[data-speed]").forEach((button) => {
      button.addEventListener("click", () => {
        this.speed = Number(button.dataset["speed"]);
        document.querySelectorAll("[data-speed]").forEach((b) => b.classList.remove("is-active"));
        button.classList.add("is-active");
      });
    });
    this.el.droneBtn.addEventListener("click", () => {
      const result = this.state.player.drone.deployed ? recallDrone(this.state) : deployDrone(this.state);
      this.toast(result.message, !result.ok);
      this.dirty = true;
    });
  }

  /* -------------------------------------------------------------- canvas */

  private wireCanvas(): void {
    const canvas = document.getElementById("map") as HTMLCanvasElement;
    let dragging = false;
    let moved = false;
    let lastX = 0;
    let lastY = 0;

    canvas.addEventListener("mousedown", (event) => {
      dragging = true;
      moved = false;
      lastX = event.clientX;
      lastY = event.clientY;
    });
    window.addEventListener("mouseup", () => {
      dragging = false;
    });
    window.addEventListener("mousemove", (event) => {
      if (!dragging) return;
      const dx = event.clientX - lastX;
      const dy = event.clientY - lastY;
      if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
      this.map.pan(dx, dy);
      lastX = event.clientX;
      lastY = event.clientY;
    });
    canvas.addEventListener("wheel", (event) => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      this.map.zoom(event.deltaY < 0 ? 1.12 : 1 / 1.12, event.clientX - rect.left, event.clientY - rect.top);
    });
    canvas.addEventListener("click", (event) => {
      if (moved) return;
      const rect = canvas.getBoundingClientRect();
      const hit = this.map.hitTest(event.clientX - rect.left, event.clientY - rect.top);
      if (!hit) return;
      this.select(hit.selection);
      // A plain click on empty ground is a movement order; on a person or a
      // device it is an inspection. That split keeps the map usable with one
      // button and no modifier keys.
      if (hit.selection.kind === "place" && event.shiftKey) {
        this.toast(walkTo(this.state, hit.selection.id).message);
      }
    });
    canvas.addEventListener("dblclick", (event) => {
      const rect = canvas.getBoundingClientRect();
      const hit = this.map.hitTest(event.clientX - rect.left, event.clientY - rect.top);
      if (hit?.selection.kind === "place") this.toast(walkTo(this.state, hit.selection.id).message);
    });
  }

  private wireKeys(): void {
    window.addEventListener("keydown", (event) => {
      if ((event.target as HTMLElement).tagName === "SELECT") return;
      switch (event.key) {
        case " ":
          event.preventDefault();
          this.speed = this.speed === 0 ? 1 : 0;
          document.querySelectorAll("[data-speed]").forEach((b) => {
            b.classList.toggle("is-active", Number((b as HTMLElement).dataset["speed"]) === this.speed);
          });
          break;
        case "[":
          this.el.floorSelect.selectedIndex = Math.max(0, this.el.floorSelect.selectedIndex - 1);
          this.el.floorSelect.dispatchEvent(new Event("change"));
          break;
        case "]":
          this.el.floorSelect.selectedIndex = Math.min(
            this.el.floorSelect.options.length - 1,
            this.el.floorSelect.selectedIndex + 1,
          );
          this.el.floorSelect.dispatchEvent(new Event("change"));
          break;
        case "d":
          this.el.droneBtn.click();
          break;
        case "s": {
          const scan = verb("scan_area");
          if (scan) this.toast(invoke(this.state, scan, { params: {} }).message);
          this.dirty = true;
          break;
        }
        default:
          break;
      }
    });
  }

  /* ------------------------------------------------------------- actions */

  private wireGlobalClicks(): void {
    document.addEventListener("click", (event) => {
      const target = event.target as HTMLElement;

      const accept = target.closest<HTMLElement>("[data-accept-mission]");
      if (accept) {
        activateMission(this.state, accept.dataset["acceptMission"]!);
        this.dirty = true;
        return;
      }

      const breachBtn = target.closest<HTMLElement>("[data-breach-node]");
      if (breachBtn) {
        const result = breach(this.state, breachBtn.dataset["breachNode"]!);
        this.toast(result.message, !result.ok);
        this.dirty = true;
        return;
      }

      const releaseBtn = target.closest<HTMLElement>("[data-release-node]");
      if (releaseBtn) {
        this.toast(release(this.state, releaseBtn.dataset["releaseNode"]!).message);
        this.dirty = true;
        return;
      }

      const walk = target.closest<HTMLElement>("[data-walk-to]");
      if (walk) {
        this.toast(walkTo(this.state, walk.dataset["walkTo"]!).message);
        this.dirty = true;
        return;
      }

      const fly = target.closest<HTMLElement>("[data-fly-to]");
      if (fly) {
        const result = flyDroneTo(this.state, fly.dataset["flyTo"]!);
        this.toast(result.message, !result.ok);
        this.dirty = true;
        return;
      }

      const selectNode = target.closest<HTMLElement>("[data-select-node]");
      if (selectNode) {
        this.select({ kind: "node", id: selectNode.dataset["selectNode"]! });
        return;
      }

      const selectNpc = target.closest<HTMLElement>("[data-select-npc]");
      if (selectNpc) {
        this.select({ kind: "npc", id: selectNpc.dataset["selectNpc"]! });
        return;
      }

      const runVerb = target.closest<HTMLElement>("[data-run-verb]");
      if (runVerb) {
        this.runVerb(runVerb);
        return;
      }
    });
  }

  /**
   * Verbs unlocked by leverage carry parameters from the secret that unlocked
   * them, so the click has to be resolved against the same sorted offer list
   * the panel rendered rather than by verb id alone.
   */
  private runVerb(button: HTMLElement): void {
    const verbId = button.dataset["runVerb"]!;
    const kind = button.dataset["targetKind"]!;
    const targetId = button.dataset["targetId"]!;
    const index = Number(button.dataset["offerIndex"]);

    const offers = sortOffers(
      kind === "npc" ? npcVerbs(this.state, targetId, this.destinationParams()) : nodeVerbs(this.state, targetId),
    );
    const offer = offers[index];
    const params: Record<string, unknown> = { ...(offer && offer.verb.id === verbId ? offer.params : {}) };
    if (kind === "node" && params["placeId"] === undefined && this.targetPlaceId) {
      params["placeId"] = this.targetPlaceId;
    }

    const outcome =
      kind === "npc"
        ? runNpcVerb(this.state, targetId, verbId, params)
        : runNodeVerb(this.state, targetId, verbId, params);

    this.toast(outcome.message, !outcome.ok);
    this.dirty = true;
  }

  /**
   * The pinned destination, in the shape verbs expect. A leverage hook that
   * carries its own destination still overrides this.
   */
  private destinationParams(): Record<string, unknown> {
    return this.targetPlaceId ? { placeId: this.targetPlaceId } : {};
  }

  /** Same as clicking it on the map; used by tooling and the smoke test. */
  selectFromConsole(selection: MapSelection): void {
    this.select(selection);
  }

  private select(selection: MapSelection): void {
    this.map.selection = selection;
    if (selection.kind === "place") this.targetPlaceId = selection.id;
    // Following a person or a device onto another floor is what you almost
    // always want; making the player hunt for the floor selector is friction
    // with no gameplay in it.
    const place =
      selection.kind === "npc"
        ? this.state.city.graph.places.get(this.state.npcs.get(selection.id)?.placeId ?? "")
        : selection.kind === "node"
          ? this.state.city.graph.places.get(this.state.city.nodes.get(selection.id)?.placeId ?? "")
          : this.state.city.graph.places.get(selection.id);
    if (place && place.indoor && place.floor !== this.map.floor) {
      this.map.floor = place.floor;
      this.el.floorSelect.value = String(place.floor);
    }
    this.dirty = true;
  }

  private toast(message: string, bad = false): void {
    const el = this.el.toast;
    el.textContent = message;
    el.classList.toggle("bad", bad);
    el.hidden = false;
    window.clearTimeout((el as HTMLElement & { _t?: number })._t);
    (el as HTMLElement & { _t?: number })._t = window.setTimeout(() => {
      el.hidden = true;
    }, 3600);
  }

  /* ---------------------------------------------------------------- loop */

  private frame = (now: number): void => {
    const delta = Math.min(250, now - this.lastFrame);
    this.lastFrame = now;

    if (this.speed > 0) {
      this.accumulator += (delta * this.speed) / this.msPerMinute;
      let ticks = 0;
      while (this.accumulator >= 1 && ticks < 64) {
        step(this.state, 1);
        this.accumulator -= 1;
        ticks++;
        this.dirty = true;
      }
    }

    this.map.draw(this.state);
    if (this.dirty) {
      this.renderPanels();
      this.dirty = false;
    }
    requestAnimationFrame(this.frame);
  };

  private renderPanels(): void {
    const clock = renderClock(this.state);
    this.el.clockTime.textContent = clock.time;
    this.el.clockDay.textContent = clock.day;

    const trace = renderTrace(this.state);
    (this.el.traceFill as HTMLElement).style.width = `${trace.percent}%`;
    (this.el.traceFill as HTMLElement).style.background = trace.colour;
    this.el.traceWord.textContent = trace.word;

    this.el.droneBtn.textContent = this.state.player.drone.deployed
      ? `Recall drone (${Math.round(this.state.player.drone.battery * 100)}%)`
      : `Deploy drone (${Math.round(this.state.player.drone.battery * 100)}%)`;

    this.el.missions.innerHTML = renderMissions(missionRuntimes(this.state));
    this.el.feed.innerHTML = renderFeed(this.state.log.all(), this.channelFilter);
    this.el.network.innerHTML = renderNetwork(this.state);
    this.el.reachCount.textContent = `${this.state.player.breachedNodeIds.size} open`;

    const selection = this.map.selection;
    if (!selection) {
      this.el.inspectorTitle.textContent = "Nothing selected";
      this.el.inspector.innerHTML = `<p class="locked">Press <b>S</b> to profile everyone in sight, then click one of them. Double-click the ground to walk there.</p>`;
      return;
    }

    if (selection.kind === "npc") {
      const person = this.state.npcs.get(selection.id);
      if (!person) return;
      this.el.inspectorTitle.textContent = person.revealedFields.has("identity")
        ? `${person.name} · ${person.occupation}`
        : "Unidentified";
      this.el.inspector.innerHTML = renderNpcInspector(
        this.state,
        person,
        npcVerbs(this.state, person.id, this.destinationParams()),
        this.targetPlaceId,
      );
    } else if (selection.kind === "node") {
      const node = this.state.city.nodes.get(selection.id);
      if (!node) return;
      this.el.inspectorTitle.textContent = node.label;
      this.el.inspector.innerHTML = renderNodeInspector(this.state, node, nodeVerbs(this.state, node.id));
    } else {
      const place = this.state.city.graph.places.get(selection.id);
      if (!place) return;
      this.el.inspectorTitle.textContent = place.name;
      this.el.inspector.innerHTML = renderPlaceInspector(this.state, place.id);
    }
  }
}

const app = new App();

// Exposed for the browser smoke test and for poking at a live world from the
// console. Everything here is already reachable through the UI; this is a
// handle on the same objects, not a back door around the rules. The shape is
// declared once in `web/global.d.ts`, since both clients attach to it.
window.dedsec = {
  app,
  state: () => app.state,
  select: (kind, id) => app.selectFromConsole({ kind, id }),
};
