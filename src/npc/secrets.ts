/**
 * Secrets and the leverage they unlock.
 *
 * This is the pivot the whole game turns on: a secret is never just a line of
 * text you read in a dossier. Every secret carries `hooks` — concrete hack
 * verbs that only become available once you have surfaced the fact. Learning
 * that the security chief has a shellfish allergy is what *creates the button*
 * that tampers with his lunch order. No fact, no button.
 */

import { Rng } from "../core/rng.js";
import type { NodeId } from "../world/types.js";
import type { LeverageHook, Npc, NpcId, Secret, SecretKind } from "./types.js";

interface SecretTemplate {
  kind: SecretKind;
  layer: 1 | 2 | 3;
  weight: [number, number];
  /** Needs a named other person to make sense. */
  needsOther?: boolean;
  summary: (ctx: { self: Npc; other?: Npc; rng: Rng; detail: string }) => string;
  detail: (rng: Rng) => string;
  hooks: (ctx: { self: Npc; other?: Npc; detail: string }) => LeverageHook[];
  /** Baseline likelihood before archetype bias. */
  base: number;
}

const ALLERGENS = ["shellfish", "peanut", "sesame", "kiwi"];
const CREDITORS = ["Halloway Recovery", "Sunbelt Collections", "a private lender", "his brother"];
const SUBSTANCES = ["a prescription he no longer has a prescription for", "an eight-a-day energy drink habit", "an off-books sleep medication"];

export const SECRET_TEMPLATES: SecretTemplate[] = [
  {
    kind: "allergy",
    layer: 2,
    weight: [0.5, 0.8],
    base: 0.1,
    detail: (rng) => rng.pick(ALLERGENS),
    summary: ({ self, detail }) =>
      `${self.name} has a severe ${detail} allergy — flagged as anaphylactic on their clinic record.`,
    hooks: ({ detail }) => [
      {
        verb: "tamper_food_order",
        label: `Amend a food order to include ${detail}`,
        params: { allergen: detail },
      },
      {
        verb: "forge_clinic_reminder",
        label: "Forge an allergy-clinic appointment reminder",
        params: { allergen: detail },
      },
    ],
  },
  {
    kind: "obsession",
    layer: 1,
    weight: [0.25, 0.5],
    base: 0.22,
    detail: (rng) =>
      rng.pick([
        "a 1983 analogue synthesizer",
        "a first-run arcade board",
        "a discontinued mechanical switch set",
        "an out-of-print field guide",
      ]),
    summary: ({ self, detail }) =>
      `${self.name} has been losing auction after auction on ${detail}. Six failed bids this month.`,
    hooks: ({ detail }) => [
      {
        verb: "forge_auction_win",
        label: `Fake a "the winner defaulted" message about ${detail}`,
        params: { item: detail },
      },
    ],
  },
  {
    kind: "affair",
    layer: 2,
    needsOther: true,
    weight: [0.6, 0.9],
    base: 0.12,
    detail: () => "",
    summary: ({ self, other }) =>
      `${self.name} is seeing ${other?.name ?? "someone"} and has been careful about it — deleted threads, a second messaging app.`,
    hooks: ({ other }) => [
      {
        verb: "forge_message",
        label: `Send a message as ${other?.name ?? "the other party"}`,
        params: { asNpcId: other?.id },
      },
      {
        verb: "expose_to_partner",
        label: "Route the evidence to their partner",
        params: { withNpcId: other?.id },
      },
    ],
  },
  {
    kind: "debt",
    layer: 2,
    weight: [0.4, 0.75],
    base: 0.2,
    detail: (rng) => rng.pick(CREDITORS),
    summary: ({ self, detail, rng }) =>
      `${self.name} is ${rng.int(9, 60)}k in arrears; ${detail} has started calling their work number.`,
    hooks: () => [
      { verb: "forge_creditor_call", label: "Spoof a debt-collection call" },
      { verb: "dangle_payout", label: "Dangle a payout to pull them off-site" },
    ],
  },
  {
    kind: "moonlighting",
    layer: 1,
    weight: [0.3, 0.6],
    base: 0.18,
    detail: (rng) =>
      rng.pick(["a second bar shift", "freelance work for a competitor", "a rideshare rota", "an evening tutoring job"]),
    summary: ({ self, detail }) =>
      `${self.name} is working ${detail} that their contract does not permit. They are interviewing elsewhere.`,
    hooks: () => [
      { verb: "forge_interview_invite", label: "Forge an interview invitation for right now" },
    ],
  },
  {
    kind: "gambling",
    layer: 2,
    weight: [0.45, 0.75],
    base: 0.1,
    detail: (rng) => rng.pick(["in-play football markets", "a private card game above the laundrette", "horse futures"]),
    summary: ({ self, detail }) =>
      `${self.name} is deep into ${detail}. Balance checked eleven times yesterday.`,
    hooks: () => [
      { verb: "forge_bet_alert", label: "Fake a live-bet alert on their phone" },
      { verb: "dangle_payout", label: "Dangle a payout to pull them off-site" },
    ],
  },
  {
    kind: "on_thin_ice",
    layer: 2,
    weight: [0.35, 0.6],
    base: 0.12,
    detail: () => "",
    summary: ({ self }) =>
      `${self.name} is on a documented performance plan. One more incident and they are out.`,
    hooks: () => [
      { verb: "plant_bait_file", label: "Plant a bait file they cannot resist opening" },
      { verb: "forge_summons", label: "Forge a summons to a manager's office" },
    ],
  },
  {
    kind: "family_crisis",
    layer: 2,
    weight: [0.5, 0.8],
    base: 0.14,
    detail: (rng) => rng.pick(["a parent in hospital", "a custody hearing", "a sibling's eviction"]),
    summary: ({ self, detail }) => `${self.name} is dealing with ${detail} and has told nobody at work.`,
    hooks: () => [
      { verb: "forge_family_emergency", label: "Forge an urgent family message" },
    ],
  },
  {
    kind: "whistleblower",
    layer: 3,
    weight: [0.7, 0.95],
    base: 0.07,
    detail: (rng) => rng.pick(["safety test results", "an undisclosed data breach", "falsified compliance filings"]),
    summary: ({ self, detail }) =>
      `${self.name} has been quietly copying ${detail} to personal storage. They are building a case.`,
    hooks: () => [
      { verb: "offer_channel", label: "Offer them a secure channel — and a reason to walk out" },
    ],
  },
  {
    kind: "embezzlement",
    layer: 3,
    weight: [0.75, 1],
    base: 0.06,
    detail: (rng) => rng.pick(["a shell vendor", "duplicated expense claims", "a padded consulting retainer"]),
    summary: ({ self, detail }) => `${self.name} has been skimming through ${detail} for at least two quarters.`,
    hooks: () => [
      { verb: "blackmail_leverage", label: "Apply direct leverage" },
      { verb: "forge_audit_notice", label: "Forge an audit notice to make them bolt" },
    ],
  },
  {
    kind: "substance",
    layer: 2,
    weight: [0.45, 0.7],
    base: 0.1,
    detail: (rng) => rng.pick(SUBSTANCES),
    summary: ({ self, detail }) => `${self.name} is relying on ${detail} to get through shifts.`,
    hooks: () => [{ verb: "forge_pharmacy_alert", label: "Fake a pharmacy collection alert" }],
  },
  {
    kind: "medical",
    layer: 2,
    weight: [0.4, 0.7],
    base: 0.12,
    detail: (rng) => rng.pick(["an untreated arrhythmia", "recurrent migraines", "a fused disc they hide from HR"]),
    summary: ({ self, detail }) => `${self.name}'s clinic record shows ${detail}, undisclosed to their employer.`,
    hooks: () => [{ verb: "forge_clinic_reminder", label: "Forge a clinic callback they will not ignore" }],
  },
  {
    kind: "record",
    layer: 3,
    weight: [0.6, 0.85],
    base: 0.06,
    detail: (rng) => rng.pick(["a spent conviction", "a sealed juvenile file", "an outstanding bench warrant in another county"]),
    summary: ({ self, detail }) => `${self.name} has ${detail} that never came up in vetting.`,
    hooks: () => [{ verb: "blackmail_leverage", label: "Apply direct leverage" }],
  },
  {
    kind: "immigration",
    layer: 3,
    weight: [0.5, 0.8],
    base: 0.05,
    detail: () => "",
    summary: ({ self }) => `${self.name}'s right-to-work paperwork is in an appeal window they cannot afford to lose.`,
    hooks: () => [{ verb: "forge_summons", label: "Forge an appointment they dare not miss" }],
  },
];

export interface SecretContext {
  self: Npc;
  candidates: Npc[];
  archetypeBias: Partial<Record<SecretKind, number>>;
  rng: Rng;
  /** Node ids that could plausibly carry the evidence for this person. */
  evidenceNodeIds: NodeId[];
}

let secretCounter = 0;

export function resetSecretCounter(): void {
  secretCounter = 0;
}

export function generateSecrets(ctx: SecretContext, count: number): Secret[] {
  const { rng, self, archetypeBias } = ctx;
  const out: Secret[] = [];
  const used = new Set<SecretKind>();

  for (let i = 0; i < count; i++) {
    const pool = SECRET_TEMPLATES.filter((t) => !used.has(t.kind));
    if (pool.length === 0) break;
    const template = rng.weighted(pool, (t) => t.base * (archetypeBias[t.kind] ?? 1));

    let other: Npc | undefined;
    if (template.needsOther) {
      const options = ctx.candidates.filter((c) => c.id !== self.id);
      if (options.length === 0) continue;
      other = rng.pick(options);
    }

    used.add(template.kind);
    const detail = template.detail(rng);
    const secret: Secret = {
      id: `sec_${++secretCounter}`,
      kind: template.kind,
      layer: template.layer,
      summary: template.summary({ self, other, rng, detail }),
      involves: other ? [other.id] : [],
      weight: rng.float(template.weight[0], template.weight[1]),
      hooks: template.hooks({ self, other, detail }),
      sourceNodeIds: pickSources(ctx, template.layer),
      revealed: false,
    };
    out.push(secret);
  }
  return out;
}

/**
 * Which devices hold the evidence. Layer 1 lives on the phone; layer 2 needs a
 * second, non-phone source (home hub, clinic records, employer terminal), which
 * is what forces the player to *link* two breaches rather than pocket-dial the
 * whole life story off one device.
 */
function pickSources(ctx: SecretContext, layer: number): NodeId[] {
  const { self, evidenceNodeIds, rng } = ctx;
  const phone = self.phoneNodeId ? [self.phoneNodeId] : [];
  if (layer === 1) return phone;
  const extras = rng.sample(evidenceNodeIds, layer === 2 ? 1 : 2);
  return [...phone, ...extras];
}

/** Everyone the secret would embarrass if it surfaced. */
export function blastRadius(secret: Secret, self: NpcId): NpcId[] {
  return [self, ...secret.involves];
}
