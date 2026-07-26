/**
 * Panel rendering.
 *
 * All of these are pure functions from world state to HTML. Nothing here knows
 * how to change the world; the app wires the buttons up afterwards using the
 * `data-` attributes these emit. That keeps the whole UI re-renderable on every
 * frame without hunting down stale listeners.
 */

import { formatDateTime, formatTime } from "../../src/core/time.js";
import type { WorldEvent } from "../../src/core/events.js";
import { computeReach, type Reachable } from "../../src/hack/access.js";
import { estimateBreach } from "../../src/hack/access.js";
import { investigationRemaining, traceDescription } from "../../src/hack/trace.js";
import type { OfferedVerb, VerbForecast } from "../../src/hack/verbs.js";
import { describeNpc } from "../../src/npc/behavior.js";
import type { Npc } from "../../src/npc/types.js";
import { buildDossier } from "../../src/profile/profiler.js";
import { missionProgress, type MissionRuntime } from "../../src/mission/runtime.js";
import type { GameState } from "../../src/sim/state.js";
import type { NetworkNode } from "../../src/world/types.js";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/* --------------------------------------------------------------- missions */

export function renderMissions(runtimes: MissionRuntime[]): string {
  const visible = runtimes.filter((r) => r.status !== "locked");
  if (visible.length === 0) return `<p class="faint">No contracts on the board yet.</p>`;

  return visible
    .map((runtime) => {
      const { mission } = runtime;
      const progress = missionProgress(runtime);
      const classes = ["mission", runtime.status === "active" ? "is-active" : "", runtime.status === "complete" ? "is-complete" : ""]
        .filter(Boolean)
        .join(" ");

      const objectives =
        runtime.status === "available"
          ? ""
          : `<ul class="objectives">${mission.objectives
              .map((o) => {
                const done = runtime.completed.has(o.id);
                return `<li class="${done ? "done" : ""}"><span>${done ? "✓" : "○"}</span><span>${escapeHtml(o.label)}${
                  !done && o.hint ? `<span class="hint">${escapeHtml(o.hint)}</span>` : ""
                }</span></li>`;
              })
              .join("")}</ul>`;

      const report =
        runtime.status === "complete" && runtime.report
          ? `<p class="brief">Assessed <strong>${escapeHtml(runtime.report.grade)}</strong> — ${runtime.report.score}/100.<br>${runtime.report.findings
              .map(escapeHtml)
              .join("<br>")}</p>
             ${runtime.awarded.length > 0 ? `<p class="constraint">${runtime.awarded.map((id) => escapeHtml(mission.accolades.find((a) => a.id === id)?.label ?? id)).join(" · ")}</p>` : ""}`
          : "";

      const action =
        runtime.status === "available"
          ? `<button data-accept-mission="${mission.id}">Accept contract</button>`
          : runtime.status === "active"
            ? `<span class="muted">${progress.done}/${progress.total} objectives</span>`
            : `<span class="muted">complete</span>`;

      return `<article class="${classes}">
        <div class="client">${escapeHtml(mission.client)}</div>
        <h3>${escapeHtml(mission.title)}</h3>
        <p class="brief">${escapeHtml(mission.brief)}</p>
        <p class="constraint">${escapeHtml(mission.constraint)}</p>
        ${objectives}
        ${report}
        <div style="margin-top:7px">${action}</div>
      </article>`;
    })
    .join("");
}

/* ------------------------------------------------------------------- feed */

export function renderFeed(events: readonly WorldEvent[], channels: Set<string>): string {
  const filtered = events.filter((e) => channels.size === 0 || channels.has(e.channel));
  return filtered
    .slice(-160)
    .reverse()
    .map(
      (e) =>
        `<li class="tone-${e.tone}"><span class="t">${formatTime(e.at)}</span>${escapeHtml(e.text)}</li>`,
    )
    .join("");
}

/* --------------------------------------------------------------- dossier */

export function renderNpcInspector(
  state: GameState,
  person: Npc,
  verbs: OfferedVerb[],
  targetPlaceId?: string,
): string {
  const dossier = buildDossier(state, person);
  const pips = [0, 1, 2, 3]
    .map((n) => `<span class="pip ${dossier.layer >= n && n > 0 ? "on" : ""}"></span>`)
    .join("");

  const sections = dossier.sections
    .map((section) => {
      const unlocked = dossier.layer >= section.layer;
      const body = unlocked
        ? section.fields.length > 0
          ? `<dl class="kv">${section.fields
              .map(
                (f) =>
                  `<dt>${escapeHtml(f.label)}</dt><dd class="${f.notable ? "notable" : ""}">${escapeHtml(f.value)}</dd>`,
              )
              .join("")}</dl>`
          : `<p class="locked">Nothing on file at this layer.</p>`
        : `<p class="locked">${escapeHtml(section.lockedHint)}</p>`;
      return `<div class="section-title"><span>${escapeHtml(section.title)}</span><span class="faint">L${section.layer}</span></div>${body}`;
    })
    .join("");

  const secrets =
    dossier.secrets.length > 0
      ? dossier.secrets
          .map(
            (s) =>
              `<div class="secret"><div class="kind">${escapeHtml(s.kind.replace(/_/g, " "))} · weight ${(s.weight * 100).toFixed(0)}%</div>${escapeHtml(s.summary)}</div>`,
          )
          .join("")
      : `<p class="locked">No secrets surfaced yet.</p>`;

  return `
    <div class="kv">
      <dt>status</dt><dd>${escapeHtml(describeNpc(person, state.city.graph, state.time))}</dd>
      <dt>location</dt><dd>${escapeHtml(state.city.graph.place(person.placeId).name)}</dd>
      <dt>suspicion</dt><dd class="${person.suspicion > 0.4 ? "notable" : ""}">${(person.suspicion * 100).toFixed(0)}%</dd>
      <dt>profile</dt><dd><span class="layer-pips">${pips}</span> layer ${dossier.layer}</dd>
    </div>
    <p class="locked">${escapeHtml(dossier.nextStep)}</p>
    ${sections}
    <div class="section-title"><span>Secrets</span></div>
    ${secrets}
    <div class="section-title"><span>Plays</span><span class="faint">${verbs.filter((v) => v.availability.ok).length} available</span></div>
    ${renderDestinationHint(state, targetPlaceId)}
    ${renderVerbList(verbs, "npc", person.id)}
  `;
}

/**
 * Anything that sends a person somewhere needs a somewhere. Say plainly where
 * that currently is, so a lure that goes nowhere is an obvious mistake rather
 * than a mystery.
 */
function renderDestinationHint(state: GameState, targetPlaceId?: string): string {
  const place = targetPlaceId ? state.city.graph.places.get(targetPlaceId) : undefined;
  return place
    ? `<p class="locked">Plays that move someone will send them to <strong>${escapeHtml(place.name)}</strong>. Click another place to change it.</p>`
    : `<p class="locked">Click a place on the map first to choose where a lure should send them; otherwise they will just stop and stare.</p>`;
}

/* ------------------------------------------------------------------ nodes */

export function renderNodeInspector(state: GameState, node: NetworkNode, verbs: OfferedVerb[]): string {
  const reach = computeReach(state);
  const entry = reach.get(node.id);
  const subnet = state.city.subnets.get(node.subnetId);
  const owner = node.ownerId ? state.npcs.get(node.ownerId) : undefined;
  const orgName = node.ownerId ? state.city.orgs.get(node.ownerId)?.name : undefined;

  const breachBlock = node.breached
    ? `<p class="locked">Breached. <button data-release-node="${node.id}">Release access</button></p>`
    : entry
      ? renderBreachEstimate(state, node, entry)
      : `<p class="locked">Out of range. Move closer, fly the drone over it, or chain through a relay you already hold.</p>`;

  return `
    <div class="kv">
      <dt>device</dt><dd>${escapeHtml(node.kind.replace(/_/g, " "))}</dd>
      <dt>where</dt><dd>${escapeHtml(state.city.graph.place(node.placeId).name)}</dd>
      <dt>owner</dt><dd>${escapeHtml(owner?.name ?? orgName ?? "unassigned")}</dd>
      <dt>subnet</dt><dd>${escapeHtml(subnet?.name ?? node.subnetId)}${subnet?.exposed ? ` <span class="tag breached">exposed</span>` : ""}</dd>
      <dt>hardening</dt><dd>${(node.hardening * 100).toFixed(0)}%</dd>
      <dt>can do</dt><dd>${node.capabilities.map((c) => `<span class="tag">${escapeHtml(c)}</span>`).join(" ")}</dd>
      <dt>reach</dt><dd>${entry ? escapeHtml(entry.source.label) : "none"}</dd>
    </div>
    ${breachBlock}
    <div class="section-title"><span>Plays</span><span class="faint">${verbs.filter((v) => v.availability.ok).length} available</span></div>
    ${renderVerbList(verbs, "node", node.id)}
  `;
}

function renderBreachEstimate(state: GameState, node: NetworkNode, entry: Reachable): string {
  const estimate = estimateBreach(state, node, entry);
  return `
    <div class="kv">
      <dt>breach odds</dt><dd class="${estimate.successChance > 0.7 ? "notable" : ""}">${(estimate.successChance * 100).toFixed(0)}%</dd>
      <dt>takes</dt><dd>${estimate.minutes.toFixed(1)} min</dd>
      <dt>trace</dt><dd>+${(estimate.trace * 100).toFixed(0)}%</dd>
      ${estimate.notes.length > 0 ? `<dt>notes</dt><dd>${escapeHtml(estimate.notes.join("; "))}</dd>` : ""}
    </div>
    <button data-breach-node="${node.id}">Breach ${escapeHtml(node.label)}</button>
  `;
}

/* ------------------------------------------------------------------ verbs */

function renderVerbList(verbs: OfferedVerb[], targetKind: "node" | "npc", targetId: string): string {
  if (verbs.length === 0) return `<p class="locked">Nothing applies here.</p>`;
  // Available first, then leverage-unlocked, then the rest — the ordering is
  // the hint: if something new appeared, it is because you learned something.
  const sorted = [...verbs].sort((a, b) => {
    if (a.availability.ok !== b.availability.ok) return a.availability.ok ? -1 : 1;
    if (Boolean(a.leverageLabel) !== Boolean(b.leverageLabel)) return a.leverageLabel ? -1 : 1;
    return a.verb.label.localeCompare(b.verb.label);
  });

  return sorted
    .map((offered, index) => {
      const { verb, availability, leverageLabel } = offered;
      const cost = `${verb.minutes.toFixed(1)}m · trace +${(verb.trace * 100).toFixed(0)}%`;
      return `<button class="verb ${leverageLabel ? "leverage" : ""}"
          data-run-verb="${verb.id}"
          data-target-kind="${targetKind}"
          data-target-id="${targetId}"
          data-offer-index="${index}"
          ${availability.ok ? "" : "disabled"}>
        <span class="row"><span class="name">${escapeHtml(verb.label)}</span><span class="cost">${cost}</span></span>
        ${leverageLabel ? `<span class="lever">↳ ${escapeHtml(leverageLabel)}</span>` : ""}
        <span class="why">${escapeHtml(availability.ok ? verb.blurb : (availability.reason ?? "Unavailable."))}</span>
        ${offered.forecast ? renderForecast(offered.forecast) : ""}
      </button>`;
    })
    .join("");
}

/**
 * The odds, and why they are what they are.
 *
 * Three bands rather than one number, because "they hesitate and go and check"
 * is a genuinely different outcome from "they see through you", and the second
 * one costs suspicion you will feel for the rest of the day.
 */
function renderForecast(forecast: VerbForecast): string {
  const act = forecast.belief;
  const doubt = Math.max(0, Math.min(1 - act, forecast.doubtBand));
  const refuse = Math.max(0, 1 - act - doubt);
  const band = act > 0.6 ? "good" : act > 0.35 ? "warn" : "bad";

  return `<span class="odds">
    <span class="odds-bar">
      <span class="odds-act" style="width:${(act * 100).toFixed(1)}%"></span>
      <span class="odds-doubt" style="width:${(doubt * 100).toFixed(1)}%"></span>
      <span class="odds-refuse" style="width:${(refuse * 100).toFixed(1)}%"></span>
    </span>
    <span class="odds-row odds-${band}">
      acts ${(act * 100).toFixed(0)}% · checks first ${(doubt * 100).toFixed(0)}% · sees through it ${(refuse * 100).toFixed(0)}%
    </span>
    <span class="odds-notes">${forecast.notes.map((n) => escapeHtml(n)).join(" · ")}</span>
    ${
      refuse > 0.25
        ? `<span class="odds-cost">Failing costs them +${(forecast.suspicionOnRefusal * 100).toFixed(0)}% suspicion, and they will tell people.</span>`
        : ""
    }
  </span>`;
}

/** The app needs the same sorted order to map a click back to its offer. */
export function sortOffers(verbs: OfferedVerb[]): OfferedVerb[] {
  return [...verbs].sort((a, b) => {
    if (a.availability.ok !== b.availability.ok) return a.availability.ok ? -1 : 1;
    if (Boolean(a.leverageLabel) !== Boolean(b.leverageLabel)) return a.leverageLabel ? -1 : 1;
    return a.verb.label.localeCompare(b.verb.label);
  });
}

/* ------------------------------------------------------------------ place */

export function renderPlaceInspector(state: GameState, placeId: string): string {
  const place = state.city.graph.place(placeId);
  const here = [...state.npcs.values()].filter((n) => n.placeId === placeId);
  const devices = [...state.city.nodes.values()].filter((n) => n.placeId === placeId);
  const building = place.buildingId ? state.city.buildings.get(place.buildingId) : undefined;

  return `
    <div class="kv">
      <dt>kind</dt><dd>${escapeHtml(place.kind)}</dd>
      <dt>zone</dt><dd class="${place.zone === "restricted" ? "notable" : ""}">${escapeHtml(place.zone)}</dd>
      <dt>building</dt><dd>${escapeHtml(building?.name ?? "outdoors")}</dd>
      <dt>floor</dt><dd>${place.floor}</dd>
      <dt>occupants</dt><dd>${here.length}</dd>
      <dt>devices</dt><dd>${devices.length}</dd>
    </div>
    <button data-walk-to="${place.id}">Walk here</button>
    <button data-fly-to="${place.id}">Send drone</button>
    <div class="section-title"><span>Who is here</span></div>
    ${
      here.length === 0
        ? `<p class="locked">Empty.</p>`
        : here
            .map(
              (p) =>
                `<div class="node-row" data-select-npc="${p.id}"><span>${escapeHtml(
                  p.revealedFields.has("identity") ? p.name : "unidentified",
                )}</span><span class="via">${escapeHtml(describeNpc(p, state.city.graph, state.time).slice(0, 34))}</span></div>`,
            )
            .join("")
    }
  `;
}

/* ---------------------------------------------------------------- network */

export function renderNetwork(state: GameState): string {
  const reach = computeReach(state);
  const entries = [...reach.values()].sort((a, b) => {
    if (a.node.breached !== b.node.breached) return a.node.breached ? -1 : 1;
    return a.distance - b.distance;
  });
  if (entries.length === 0) return `<p class="locked">Nothing in radio range.</p>`;

  return entries
    .slice(0, 120)
    .map(
      (entry) =>
        `<div class="node-row ${entry.node.breached ? "is-breached" : ""}" data-select-node="${entry.node.id}">
          <span>${escapeHtml(entry.node.label)}</span>
          <span class="via">${entry.node.breached ? "open" : escapeHtml(entry.source.label)}</span>
        </div>`,
    )
    .join("");
}

/* ------------------------------------------------------------------ chrome */

export function renderTrace(state: GameState): { percent: number; word: string; colour: string } {
  const level = state.trace.level;
  const word = state.trace.investigating
    ? `INVESTIGATION · ${Math.ceil(investigationRemaining(state))}m`
    : traceDescription(level);
  const colour = level > 0.8 ? "var(--bad)" : level > 0.5 ? "var(--warn)" : "var(--accent)";
  return { percent: level * 100, word, colour };
}

export function renderClock(state: GameState): { time: string; day: string } {
  const label = formatDateTime(state.time);
  const [day, time] = label.split(" ");
  return { time: time ?? "--:--", day: `Day ${(day ?? "D1").slice(1)}` };
}
