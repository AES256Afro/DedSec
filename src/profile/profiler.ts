/**
 * The profiler.
 *
 * Four layers, each with a different price of admission:
 *
 *   L0  Passive scan — free, in line of sight. Name, job, income, one quirk.
 *   L1  Device breach — you have their phone. Messages, contacts, calendar,
 *       apps, interests, and any secret that lives on the handset.
 *   L2  Cross-source link — you have the phone *and* a second, independent
 *       source (home hub, employer records, clinic). Finances, medical,
 *       relationships they hide. This is the layer that pays.
 *   L3  Pattern analysis — corroborate a secret across two people's data.
 *       Career-ending material, and the leverage that comes with it.
 *
 * Layers are not a menu you buy through. A secret exposes itself only when the
 * player has actually breached the nodes carrying its evidence, so the dossier
 * is a readout of work done, never a purchase.
 */

import type { Instant } from "../core/time.js";
import { formatOffset } from "../core/time.js";
import { blockAt, upcoming } from "../npc/schedule.js";
import type { LeverageHook, Npc, NpcId, Secret } from "../npc/types.js";
import type { NodeId } from "../world/types.js";
import type { GameState } from "../sim/state.js";

export type ProfileLayer = 0 | 1 | 2 | 3;

export interface DossierField {
  id: string;
  label: string;
  value: string;
  layer: ProfileLayer;
  /** Rendered with emphasis — this is the actionable stuff. */
  notable?: boolean;
}

export interface DossierSection {
  title: string;
  layer: ProfileLayer;
  fields: DossierField[];
  /** Shown in place of the fields when the layer is not unlocked. */
  lockedHint: string;
}

export interface Dossier {
  npcId: NpcId;
  name: string;
  layer: ProfileLayer;
  sections: DossierSection[];
  secrets: Secret[];
  /** Every hook from every revealed secret, deduplicated. */
  leverage: LeverageHook[];
  /** What the player must do to reach the next layer. */
  nextStep: string;
}

/** Which nodes count as an independent second source for this person. */
export function evidenceNodesFor(npc: Npc): NodeId[] {
  const set = new Set<NodeId>();
  for (const secret of npc.secrets) for (const id of secret.sourceNodeIds) set.add(id);
  for (const id of npc.deviceIds) set.add(id);
  return [...set];
}

/**
 * Recompute the layer a player has genuinely earned on this person.
 * Called after every breach; never set directly.
 */
export function recomputeLayer(state: GameState, npc: Npc): ProfileLayer {
  const breached = state.player.breachedNodeIds;
  const phoneBreached = npc.phoneNodeId ? breached.has(npc.phoneNodeId) : false;

  // Any node not the phone that carries this person's evidence.
  const secondarySources = evidenceNodesFor(npc).filter((id) => id !== npc.phoneNodeId);
  const secondaryBreached = secondarySources.filter((id) => breached.has(id));

  // L3 needs corroboration from someone else's data as well.
  const cross = npc.secrets
    .filter((s) => s.layer === 3)
    .some((s) =>
      s.involves.some((otherId) => {
        const other = state.npcs.get(otherId);
        if (!other) return false;
        return other.phoneNodeId ? breached.has(other.phoneNodeId) : false;
      }),
    );

  let layer: ProfileLayer = 0;
  if (phoneBreached) layer = 1;
  if (phoneBreached && secondaryBreached.length >= 1) layer = 2;
  if (phoneBreached && secondaryBreached.length >= 2 && cross) layer = 3;

  npc.profileLayer = layer;
  // If you have been through someone's handset you know who they are, whether
  // or not you ever pointed a camera at them.
  if (layer >= 1) npc.revealedFields.add("identity");
  for (const secret of npc.secrets) {
    // A secret is legible when its layer is unlocked *and* one of the nodes
    // carrying its evidence has actually been opened.
    const hasSource = secret.sourceNodeIds.some((id) => breached.has(id));
    secret.revealed = layer >= secret.layer && hasSource;
  }
  return layer;
}

/** Passive scan: what a camera and a public-records lookup can tell you. */
export function passiveScan(state: GameState, npc: Npc): void {
  if (npc.revealedFields.has("identity")) return;
  npc.revealedFields.add("identity");
  state.log.emit(state.time, {
    channel: "hack",
    kind: "profile.scan",
    text: `Profiled ${npc.name} — ${npc.occupation}.`,
    subjects: [npc.id],
  });
}

function money(n: number): string {
  return `$${n.toLocaleString("en-US")}`;
}

function relationshipLines(state: GameState, npc: Npc, includeCovert: boolean): DossierField[] {
  return npc.relationships
    .filter((r) => includeCovert || !r.covert)
    .slice(0, 8)
    .map((r, i) => {
      const other = state.npcs.get(r.otherId);
      return {
        id: `rel_${i}`,
        label: r.kind.replace(/_/g, " "),
        value: `${other?.name ?? "unknown"} · trust ${(r.trust * 100).toFixed(0)}%${r.covert ? " · concealed" : ""}`,
        layer: (r.covert ? 2 : 1) as ProfileLayer,
        notable: r.covert || r.trust > 0.8,
      };
    });
}

function scheduleLines(state: GameState, npc: Npc, time: Instant): DossierField[] {
  return upcoming(npc, time, 5).map((entry, i) => ({
    id: `sched_${i}`,
    label: formatOffset(time, entry.at) === "now" ? "now" : formatOffset(time, entry.at),
    value: `${entry.block.label} · ${state.city.graph.place(entry.block.placeId).name}${entry.block.post ? " (post)" : ""}`,
    layer: 1 as ProfileLayer,
    notable: entry.block.post,
  }));
}

function accountLines(npc: Npc): DossierField[] {
  const reusedPassword = npc.accounts.find((a) => a.reused)?.password;
  const fields: DossierField[] = npc.accounts.slice(0, 6).map((a, i) => ({
    id: `acct_${i}`,
    label: a.service,
    value: `${a.handle}${a.password ? ` · ${a.password}` : ""}${a.grantsNodeId ? " · workplace SSO" : ""}`,
    layer: 2 as ProfileLayer,
    notable: Boolean(a.grantsNodeId),
  }));
  if (reusedPassword) {
    fields.unshift({
      id: "acct_reuse",
      label: "credential reuse",
      value: `Same password across ${npc.accounts.filter((a) => a.reused).length} services — "${reusedPassword}"`,
      layer: 2,
      notable: true,
    });
  }
  return fields;
}

export function buildDossier(state: GameState, npc: Npc): Dossier {
  const layer = npc.profileLayer;
  const time = state.time;
  const block = blockAt(npc, time);
  const revealedSecrets = npc.secrets.filter((s) => s.revealed);

  const sections: DossierSection[] = [
    {
      title: "Identity",
      layer: 0,
      lockedHint: "Get line of sight and run a passive scan.",
      fields: [
        { id: "name", label: "name", value: npc.name, layer: 0 },
        { id: "pronouns", label: "pronouns", value: npc.pronouns, layer: 0 },
        { id: "age", label: "age", value: String(npc.age), layer: 0 },
        { id: "job", label: "occupation", value: npc.occupation, layer: 0 },
        { id: "income", label: "income", value: money(npc.income), layer: 0 },
        {
          id: "clearance",
          label: "badge clearance",
          value: npc.clearance,
          layer: 0,
          notable: npc.clearance === "restricted",
        },
        { id: "quirk", label: "flagged", value: npc.quirk, layer: 0, notable: true },
        {
          id: "doing",
          label: "right now",
          value: block ? `${block.label} · ${state.city.graph.place(npc.placeId).name}` : "unscheduled",
          layer: 0,
        },
      ],
    },
    {
      title: "Device · phone",
      layer: 1,
      lockedHint: "Breach their handset. You need to be inside radio range of it.",
      fields:
        layer >= 1
          ? [
              {
                id: "interests",
                label: "interests",
                value: npc.interests.join(", "),
                layer: 1,
                notable: true,
              },
              ...relationshipLines(state, npc, false),
              ...scheduleLines(state, npc, time),
            ]
          : [],
    },
    {
      title: "Cross-source · finances, health, private life",
      layer: 2,
      lockedHint:
        "Link the handset to a second independent source — their home network, their employer's records, or the clinic.",
      fields:
        layer >= 2
          ? [
              ...accountLines(npc),
              ...relationshipLines(state, npc, true).filter((f) => f.value.includes("concealed")),
              {
                id: "stress",
                label: "assessed stress",
                value: `${(npc.stress * 100).toFixed(0)}%`,
                layer: 2,
              },
            ]
          : [],
    },
    {
      title: "Pattern analysis",
      layer: 3,
      lockedHint: "Corroborate against a second person's data — breach someone this secret implicates.",
      fields:
        layer >= 3
          ? [
              {
                id: "traits",
                label: "psychological read",
                value: describeTraits(npc),
                layer: 3,
                notable: true,
              },
            ]
          : [],
    },
  ];

  const leverage: LeverageHook[] = [];
  const seen = new Set<string>();
  for (const secret of revealedSecrets) {
    for (const hook of secret.hooks) {
      const key = `${hook.verb}:${JSON.stringify(hook.params ?? {})}`;
      if (seen.has(key)) continue;
      seen.add(key);
      leverage.push(hook);
    }
  }

  return {
    npcId: npc.id,
    name: npc.name,
    layer,
    sections,
    secrets: revealedSecrets,
    leverage,
    nextStep: nextStepFor(state, npc),
  };
}

function nextStepFor(state: GameState, npc: Npc): string {
  const breached = state.player.breachedNodeIds;
  if (!npc.phoneNodeId) return "No handset on this person — find another source.";
  if (!breached.has(npc.phoneNodeId)) return "Breach their phone to reach layer 1.";
  const secondary = evidenceNodesFor(npc).filter((id) => id !== npc.phoneNodeId && !breached.has(id));
  if (npc.profileLayer < 2) {
    const names = secondary
      .slice(0, 3)
      .map((id) => state.city.nodes.get(id)?.label ?? id)
      .join(", ");
    return `Breach a second source to reach layer 2: ${names || "no known secondary source"}.`;
  }
  if (npc.profileLayer < 3) {
    const others = npc.secrets
      .filter((s) => s.layer === 3)
      .flatMap((s) => s.involves)
      .map((id) => state.npcs.get(id)?.name)
      .filter(Boolean);
    return others.length > 0
      ? `Corroborate through ${others.join(" or ")} to reach layer 3.`
      : "Nothing further on this person.";
  }
  return "Fully profiled.";
}

/** Turn the trait vector into the sentence a manipulator would actually write. */
export function describeTraits(npc: Npc): string {
  const t = npc.traits;
  const notes: string[] = [];
  const high = (v: number) => v > 0.66;
  const low = (v: number) => v < 0.34;

  if (high(t.diligence)) notes.push("verifies before acting");
  if (low(t.diligence)) notes.push("cuts corners under time pressure");
  if (high(t.curiosity)) notes.push("cannot leave a thing unopened");
  if (high(t.gullibility)) notes.push("defers to asserted authority");
  if (low(t.gullibility)) notes.push("asks who you are and means it");
  if (high(t.vanity)) notes.push("responds to recognition");
  if (high(t.greed)) notes.push("moves for money");
  if (high(t.anxiety)) notes.push("escalates fast, tells someone");
  if (low(t.anxiety)) notes.push("hard to rattle");
  if (high(t.sociability)) notes.push("talks — anything you do to them spreads");
  if (high(t.techLiteracy)) notes.push("will notice a tampered device");
  if (low(t.techLiteracy)) notes.push("blind to device-level tampering");

  return notes.length > 0 ? notes.join("; ") : "unremarkable across the board";
}

/** The single best lever available on this person right now, for the UI hint. */
export function bestLeverage(npc: Npc): LeverageHook | undefined {
  const revealed = npc.secrets.filter((s) => s.revealed).sort((a, b) => b.weight - a.weight);
  return revealed[0]?.hooks[0];
}
