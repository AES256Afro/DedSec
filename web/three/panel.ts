/**
 * The panel you get when you actually stop and look at somebody.
 *
 * The terminal client renders every verb the game can offer against a person.
 * This one deliberately does not. The street loop asks three questions and no
 * others — who is this, what is happening to them, and do I do something — so
 * the panel is: the dossier as far as you have earned it, the case if there is
 * one, and the small set of things you could do about it.
 *
 * Everything cut from here is still in the terminal client. This is a different
 * reading of the same world, not a reduced one.
 */

import { casesFor } from "../../src/case/cases.js";
import type { CaseRecord } from "../../src/case/types.js";
import { estimateBreach } from "../../src/hack/access.js";
import type { Reachable } from "../../src/hack/access.js";
import type { Npc } from "../../src/npc/types.js";
import { buildDossier } from "../../src/profile/profiler.js";
import type { GameState } from "../../src/sim/state.js";
import { escapeHtml } from "./cards.js";

const FLAG_LABEL: Record<string, string> = {
  shakedown: "Lending",
  supply: "Supply",
  squeeze: "Tenancy",
  coercion: "Coercion",
  skimming: "Fraud",
  fixation: "Surveillance",
  undertow: "No one to blame",
};

export function renderProfilePanel(
  state: GameState,
  npc: Npc,
  reach: Map<string, Reachable>,
): string {
  const dossier = buildDossier(state, npc);
  const cases = casesFor(state, npc.id);
  const parts: string[] = [];

  parts.push(`<header class="pp-head">
    <div>
      <h2>${escapeHtml(npc.name)}</h2>
      <p>${escapeHtml(npc.occupation)} · ${npc.pronouns} · $${npc.income.toLocaleString("en-US")}</p>
    </div>
    <span class="pp-layer">L${npc.profileLayer}</span>
  </header>`);

  parts.push(`<p class="pp-quirk">${escapeHtml(npc.quirk)}</p>`);

  /* -------------------------------------------------------- the next step */

  parts.push(renderAccess(state, npc, reach, dossier.nextStep));

  /* ------------------------------------------------------------ the cases */

  for (const record of cases) parts.push(renderCase(state, record, npc));

  /* ---------------------------------------------------------- what we know */

  if (dossier.secrets.length > 0) {
    parts.push(`<section class="pp-block">
      <h3>What their devices say</h3>
      <ul class="pp-secrets">
        ${dossier.secrets.map((s) => `<li>${escapeHtml(s.summary)}</li>`).join("")}
      </ul>
    </section>`);
  }

  if (npc.profileLayer >= 1) {
    const ties = npc.relationships.slice(0, 5).map((r) => {
      const other = state.npcs.get(r.otherId);
      return `<li><span>${escapeHtml(r.kind.replace(/_/g, " "))}</span>${escapeHtml(other?.name ?? "unknown")}</li>`;
    });
    if (ties.length > 0) {
      parts.push(`<section class="pp-block"><h3>Who they are to people</h3><ul class="pp-ties">${ties.join("")}</ul></section>`);
    }
  }

  return parts.join("");
}

function renderAccess(
  state: GameState,
  npc: Npc,
  reach: Map<string, Reachable>,
  nextStep: string,
): string {
  if (npc.profileLayer >= 2) {
    return `<p class="pp-note is-good">Fully read. Nothing on this person is hidden from you.</p>`;
  }

  // Offer the *specific* device that advances them, not a device list. The
  // street loop should never make the player go shopping in a network view.
  const wanted = npc.profileLayer === 0 ? npc.phoneNodeId : undefined;
  const targets = wanted
    ? [wanted]
    : [...new Set(npc.secrets.flatMap((s) => s.sourceNodeIds))].filter(
        (id) => id !== npc.phoneNodeId && !state.player.breachedNodeIds.has(id),
      );

  const offers: string[] = [];
  for (const nodeId of targets.slice(0, 3)) {
    const entry = reach.get(nodeId);
    const node = state.city.nodes.get(nodeId);
    if (!node) continue;
    if (!entry) {
      offers.push(
        `<li class="is-far"><b>${escapeHtml(node.label)}</b><span>out of range — it is somewhere else in the city</span></li>`,
      );
      continue;
    }
    const estimate = estimateBreach(state, node, entry);
    offers.push(`<li>
      <button data-breach="${node.id}"><b>${escapeHtml(node.label)}</b><span>${Math.round(estimate.successChance * 100)}% clean · ${estimate.minutes.toFixed(1)} min</span></button>
    </li>`);
  }

  return `<section class="pp-block">
    <h3>${npc.profileLayer === 0 ? "Read their phone" : "Find a second source"}</h3>
    <p class="pp-note">${escapeHtml(nextStep)}</p>
    ${offers.length > 0 ? `<ul class="pp-offers">${offers.join("")}</ul>` : ""}
  </section>`;
}

function renderCase(state: GameState, record: CaseRecord, viewing: Npc): string {
  const subject = state.npcs.get(record.subjectNpcId);
  const harm = record.harmNpcId ? state.npcs.get(record.harmNpcId) : undefined;
  const role = record.harmNpcId === viewing.id ? "harm" : "need";
  const other = role === "harm" ? subject : harm;

  if (record.status === "flagged") {
    return `<section class="pp-case is-${role}">
      <h3><span class="pp-kind">${escapeHtml(FLAG_LABEL[record.kind] ?? "Flagged")}</span></h3>
      <p class="pp-tell">${escapeHtml(record.tell)}</p>
      <p class="pp-note">You can see the shape of it, not the substance. Read a phone.</p>
    </section>`;
  }

  const buttons = record.resolutions
    .map(
      (r) => `<button class="pp-act is-${r.kind}" data-case="${record.id}" data-resolution="${r.kind}">
        <b>${escapeHtml(r.label)}</b><span>${escapeHtml(r.detail)}</span>
      </button>`,
    )
    .join("");

  return `<section class="pp-case is-${role}">
    <h3><span class="pp-kind">${escapeHtml(FLAG_LABEL[record.kind] ?? "Flagged")}</span>${
      other ? `<span class="pp-other">with ${escapeHtml(other.name)}</span>` : ""
    }</h3>
    <p class="pp-headline">${escapeHtml(record.headline)}</p>
    <div class="pp-acts">${buttons}</div>
  </section>`;
}
