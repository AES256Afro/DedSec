/**
 * Population generation.
 *
 * Builds a city full of people whose lives already interlock before the player
 * arrives: staff rosters drawn from each building's blueprint, households in
 * the residential block, affairs and debts that reach across organisations, and
 * routines derived from the job rather than sprinkled on afterwards.
 *
 * Everything here is seeded. Same seed, same city, same tangle of secrets.
 */

import { Rng } from "../core/rng.js";
import { MINUTES_PER_DAY } from "../core/time.js";
import { BUILDINGS } from "../world/blueprint.js";
import { addNode, type City } from "../world/generator.js";
import type { NodeId, Place, PlaceId, SecurityZone } from "../world/types.js";
import { archetype, type Archetype } from "./archetypes.js";
import { FAMILY_NAMES, GENERIC_QUIRKS, GIVEN_NAMES, INTEREST_POOL, PRONOUN_SETS, SERVICES } from "./names.js";
import { generateSecrets, resetSecretCounter } from "./secrets.js";
import type { Account, Npc, NpcId, Relationship, RoutineBlock, Traits } from "./types.js";

export interface Population {
  npcs: Map<NpcId, Npc>;
  /** org id -> staff ids, in roster order. */
  rosters: Map<string, NpcId[]>;
}

const PASSWORD_WORDS = ["orchid", "granite", "kestrel", "tundra", "brassica", "vellum", "quasar", "mistral"];

function makeTraits(rng: Rng, bias: Partial<Traits>): Traits {
  const roll = (key: keyof Traits): number => {
    const centre = bias[key] ?? 0.5;
    const value = centre + rng.bell(-0.28, 0.28);
    return Math.max(0.03, Math.min(0.97, value));
  };
  return {
    diligence: roll("diligence"),
    curiosity: roll("curiosity"),
    gullibility: roll("gullibility"),
    vanity: roll("vanity"),
    greed: roll("greed"),
    anxiety: roll("anxiety"),
    sociability: roll("sociability"),
    techLiteracy: roll("techLiteracy"),
  };
}

function uniqueName(rng: Rng, used: Set<string>): string {
  for (let attempt = 0; attempt < 200; attempt++) {
    const name = `${rng.pick(GIVEN_NAMES)} ${rng.pick(FAMILY_NAMES)}`;
    if (!used.has(name)) {
      used.add(name);
      return name;
    }
  }
  const fallback = `${rng.pick(GIVEN_NAMES)} ${rng.pick(FAMILY_NAMES)}-${used.size}`;
  used.add(fallback);
  return fallback;
}

function makeAccounts(rng: Rng, npcId: NpcId, techLiteracy: number): Account[] {
  const count = rng.int(3, 5);
  const services = rng.sample(SERVICES, count);
  // Low tech-literacy means one password everywhere — the single most useful
  // thing a passive profile can tell you.
  const reuseAll = rng.chance(1 - techLiteracy * 0.85);
  const shared = `${rng.pick(PASSWORD_WORDS)}${rng.int(10, 99)}`;
  return services.map((service, i) => ({
    id: `acct_${npcId}_${i}`,
    service,
    handle: `${service.slice(0, 3).toLowerCase()}.${npcId.replace("npc_", "u")}`,
    password: reuseAll ? shared : `${rng.pick(PASSWORD_WORDS)}${rng.int(100, 999)}`,
    reused: reuseAll,
  }));
}

/**
 * Build a day from the archetype's shift plus the universal blocks everyone
 * has: sleep, commute, meals, an evening. Wrap-around night shifts are handled
 * by the window type, so a bartender's day is one continuous description.
 */
function makeRoutine(
  rng: Rng,
  npcId: NpcId,
  arch: Archetype,
  homePlaceId: PlaceId,
  workPlaceId: PlaceId | undefined,
  leisurePlaceIds: PlaceId[],
): RoutineBlock[] {
  const jitter = rng.int(-25, 25);
  const [shiftStart, shiftEnd] = arch.shift;
  const start = (shiftStart + jitter + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const end = (shiftEnd + jitter + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const blocks: RoutineBlock[] = [];
  const push = (b: Omit<RoutineBlock, "id">) =>
    blocks.push({ ...b, id: `rt_${npcId}_${blocks.length}` });

  const commute = rng.int(25, 55);
  const sleepStart = (end + rng.int(120, 260)) % MINUTES_PER_DAY;
  const sleepEnd = (start - commute - rng.int(50, 90) + MINUTES_PER_DAY) % MINUTES_PER_DAY;

  push({
    label: "Asleep",
    window: { startMinute: sleepStart, endMinute: sleepEnd },
    placeId: homePlaceId,
    activity: "sleep",
    post: false,
  });
  push({
    label: "Getting ready",
    window: { startMinute: sleepEnd, endMinute: (start - commute + MINUTES_PER_DAY) % MINUTES_PER_DAY },
    placeId: homePlaceId,
    activity: "idle",
    post: false,
  });

  if (workPlaceId) {
    push({
      label: "Commute",
      window: { startMinute: (start - commute + MINUTES_PER_DAY) % MINUTES_PER_DAY, endMinute: start },
      placeId: workPlaceId,
      activity: "commute",
      post: false,
    });

    // Lunch splits the shift, which is where most of the useful gaps live.
    const lunchStart = (start + Math.floor(((end - start + MINUTES_PER_DAY) % MINUTES_PER_DAY) / 2)) % MINUTES_PER_DAY;
    const lunchLength = rng.int(30, 50);
    push({
      label: arch.post ? `On station · ${arch.title}` : `At work · ${arch.title}`,
      window: { startMinute: start, endMinute: lunchStart },
      placeId: workPlaceId,
      activity: arch.patrols ? "patrol" : arch.post ? "post" : "work",
      post: arch.post,
    });
    push({
      label: "Meal break",
      window: { startMinute: lunchStart, endMinute: (lunchStart + lunchLength) % MINUTES_PER_DAY },
      placeId: leisurePlaceIds.length > 0 && rng.chance(0.45) ? rng.pick(leisurePlaceIds) : workPlaceId,
      activity: "meal",
      post: false,
    });
    push({
      label: arch.post ? `On station · ${arch.title}` : `At work · ${arch.title}`,
      window: { startMinute: (lunchStart + lunchLength) % MINUTES_PER_DAY, endMinute: end },
      placeId: workPlaceId,
      activity: arch.patrols ? "patrol" : arch.post ? "post" : "work",
      post: arch.post,
    });
  } else {
    // No job to go to. The day still has to be accounted for, or this person
    // simply stops existing between breakfast and the evening.
    const readyEnd = (start - commute + MINUTES_PER_DAY) % MINUTES_PER_DAY;
    const midday = (readyEnd + Math.floor(((end - readyEnd + MINUTES_PER_DAY) % MINUTES_PER_DAY) / 2)) % MINUTES_PER_DAY;
    const morningPlace = leisurePlaceIds.length > 0 ? rng.pick(leisurePlaceIds) : homePlaceId;
    const afternoonPlace = leisurePlaceIds.length > 0 ? rng.pick(leisurePlaceIds) : homePlaceId;
    push({
      label: rng.pick(["Out and about", "Running errands", "Killing time"]),
      window: { startMinute: readyEnd, endMinute: midday },
      placeId: morningPlace,
      activity: "errand",
      post: false,
    });
    push({
      label: rng.pick(["Out and about", "Sitting somewhere", "Meeting someone"]),
      window: { startMinute: midday, endMinute: end },
      placeId: afternoonPlace,
      activity: "leisure",
      post: false,
    });
  }

  const eveningPlace = leisurePlaceIds.length > 0 ? rng.pick(leisurePlaceIds) : homePlaceId;
  // Draw the handover once — drawing it twice leaves an unscheduled hole in the
  // evening, and a person with no block is a person who does not go anywhere.
  //
  // A third of the city has a proper night out. Without this everybody was
  // indoors by half nine and the city after dark — which is when it looks best
  // and when the bar contract is set — had nobody in it at all.
  const nightOut = rng.chance(0.34);
  const eveningEnd = (end + (nightOut ? rng.int(240, 460) : rng.int(70, 180))) % MINUTES_PER_DAY;
  push({
    label: rng.pick(["Out", "Errands", "Meeting a friend", "Unwinding"]),
    window: { startMinute: end, endMinute: eveningEnd },
    placeId: eveningPlace,
    activity: "leisure",
    post: false,
  });
  push({
    label: "At home",
    window: { startMinute: eveningEnd, endMinute: sleepStart },
    placeId: homePlaceId,
    activity: "idle",
    post: false,
  });

  return blocks;
}

function pickWorkPlace(city: City, buildingId: string, arch: Archetype, rng: Rng): Place | undefined {
  const options = city.graph
    .placesInBuilding(buildingId)
    .filter((p) => arch.workPlaceKinds.includes(p.kind));
  if (options.length === 0) {
    const fallback = city.graph.placesInBuilding(buildingId).filter((p) => p.zone !== "restricted");
    return fallback.length > 0 ? rng.pick(fallback) : undefined;
  }
  return rng.pick(options);
}

export function generatePopulation(city: City, seed: number | string): Population {
  const rng = new Rng(`${seed}:pop`);
  resetSecretCounter();
  const npcs = new Map<NpcId, Npc>();
  const rosters = new Map<string, NpcId[]>();
  const usedNames = new Set<string>();
  let counter = 0;

  const apartments = [...city.graph.places.values()].filter((p) => p.kind === "apartment");
  // Where people go when they are not at home or at work. Plazas and parks are
  // in here deliberately: a city whose streets are pure corridors gives the
  // player nobody to profile from a bench, which is most of the fantasy.
  const hangouts = [...city.graph.places.values()].filter((p) =>
    ["cafe", "bar", "park", "shop", "plaza"].includes(p.kind),
  );
  const outdoors = [...city.graph.places.values()].filter((p) => !p.indoor);
  const leisurePlaces = hangouts;
  // People with nowhere to be spend far more of the day out on the street.
  const idlePlaces = [...hangouts, ...outdoors, ...outdoors];

  const create = (arch: Archetype, orgId: string | undefined, buildingId: string | undefined): Npc => {
    const id = `npc_${++counter}`;
    const personal = rng.fork(id);
    const traits = makeTraits(personal, arch.traitBias);
    const home = apartments.length > 0 ? personal.pick(apartments) : personal.pick(leisurePlaces);
    const work = buildingId ? pickWorkPlace(city, buildingId, arch, personal) : undefined;

    const npc: Npc = {
      id,
      name: uniqueName(personal, usedNames),
      age: personal.int(21, 64),
      pronouns: personal.pick(PRONOUN_SETS),
      archetypeId: arch.id,
      occupation: arch.title,
      clearance: arch.clearance as SecurityZone,
      income: Math.round(personal.float(arch.income[0], arch.income[1]) / 500) * 500,
      quirk: personal.pick([...arch.quirks, ...GENERIC_QUIRKS]),
      traits,
      homePlaceId: home.id,
      deviceIds: [],
      accounts: [],
      relationships: [],
      secrets: [],
      routine: [],
      interests: personal.sample(INTEREST_POOL, personal.int(2, 4)),
      placeId: home.id,
      activity: "idle",
      condition: "normal",
      busyUntil: 0,
      impulses: [],
      suspicion: 0,
      stress: personal.float(0.05, 0.25),
      memory: [],
      carrying: [],
      profileLayer: 0,
      revealedFields: new Set<string>(),
      tagged: false,
      ...(orgId ? { orgId } : {}),
      ...(work ? { workPlaceId: work.id } : {}),
    };

    // Personal devices. The phone is the universal L1 surface; a laptop at home
    // is one of the second sources an L2 link can use.
    const phone = addNode(city, {
      kind: "phone",
      label: `${npc.name}'s phone`,
      placeId: npc.placeId,
      subnetId: "sn_public",
      hardening: 0.15 + traits.techLiteracy * 0.5,
      ownerId: npc.id,
      portable: true,
      state: { locked: true, unreadCount: personal.int(0, 12) },
    });
    npc.phoneNodeId = phone.id;
    npc.deviceIds.push(phone.id);
    npc.carrying.push(phone.id);

    const homeHub = addNode(city, {
      kind: "router",
      label: `${npc.name}'s home network`,
      placeId: home.id,
      subnetId: "sn_public",
      hardening: 0.1 + traits.techLiteracy * 0.4,
      ownerId: npc.id,
    });
    npc.deviceIds.push(homeHub.id);

    const laptop = addNode(city, {
      kind: "laptop",
      label: `${npc.name}'s laptop`,
      placeId: home.id,
      subnetId: "sn_public",
      hardening: 0.12 + traits.techLiteracy * 0.45,
      ownerId: npc.id,
      portable: true,
    });
    npc.deviceIds.push(laptop.id);

    npc.accounts = makeAccounts(personal, npc.id, traits.techLiteracy);
    npc.routine = makeRoutine(
      personal,
      npc.id,
      arch,
      home.id,
      work?.id,
      (work ? leisurePlaces : idlePlaces).map((p) => p.id),
    );

    npcs.set(npc.id, npc);
    if (orgId) {
      const roster = rosters.get(orgId) ?? [];
      roster.push(npc.id);
      rosters.set(orgId, roster);
    }
    return npc;
  };

  // Staff, building by building.
  for (const spec of BUILDINGS) {
    for (const slot of spec.staffing) {
      const arch = archetype(slot.archetypeId);
      for (let i = 0; i < slot.count; i++) create(arch, spec.orgId, spec.id);
    }
  }

  // Unaffiliated residents to fill the streets out.
  //
  // Thirty was enough for a map with dots on it and nowhere near enough for a
  // street you walk down: two-thirds of the city is indoors during office
  // hours, so a population of seventy put four people on the pavement. These
  // are the ones with somewhere to be that is not work — the ones who make a
  // plaza look like a plaza.
  const residentArch = archetype("resident");
  const residentCount = 150;
  for (let i = 0; i < residentCount; i++) create(residentArch, undefined, undefined);

  wireRelationships(npcs, rosters, rng);
  wireSecrets(city, npcs, rng);
  grantWorkCredentials(city, npcs, rng);

  return { npcs, rosters };
}

/**
 * Social graph. Coworker links come from the roster; personal links are drawn
 * across the whole population so the manipulation surface is not confined to
 * one building. A bouncer's cousin working three districts away is exactly the
 * lever the design wants available.
 */
function wireRelationships(npcs: Map<NpcId, Npc>, rosters: Map<string, NpcId[]>, rng: Rng): void {
  const all = [...npcs.values()];

  const link = (a: Npc, b: Npc, kind: Relationship["kind"], trust: number, covert = false) => {
    if (a.id === b.id) return;
    if (a.relationships.some((r) => r.otherId === b.id && r.kind === kind)) return;
    a.relationships.push({ otherId: b.id, kind, trust, covert });
  };

  const reciprocal: Partial<Record<Relationship["kind"], Relationship["kind"]>> = {
    spouse: "spouse",
    partner: "partner",
    affair: "affair",
    ex: "ex",
    sibling: "sibling",
    cousin: "cousin",
    friend: "friend",
    coworker: "coworker",
    rival: "rival",
    manager: "report",
    report: "manager",
    parent: "child",
    child: "parent",
  };

  const pair = (a: Npc, b: Npc, kind: Relationship["kind"], trust: number, covert = false) => {
    link(a, b, kind, trust, covert);
    const back = reciprocal[kind];
    if (back) link(b, a, back, trust * rng.float(0.85, 1.05), covert);
  };

  // Workplace structure.
  for (const [, roster] of rosters) {
    const staff = roster.map((id) => npcs.get(id)!).filter(Boolean);
    const managers = staff.filter((n) => n.archetypeId === "manager" || n.archetypeId === "exec");
    for (const person of staff) {
      for (const other of rng.sample(staff, Math.min(4, staff.length))) {
        pair(person, other, "coworker", rng.float(0.35, 0.65));
      }
      if (managers.length > 0 && !managers.includes(person)) {
        // A relationship's `kind` names the *other* party's role — the dossier
        // renders it as "manager · Ines Abara". Linking from the manager's side
        // therefore reads exactly backwards, and did: every dossier in the game
        // listed a target's boss as their report.
        pair(person, rng.pick(managers), "manager", rng.float(0.5, 0.8));
      }
    }
    // A rivalry or two per org makes betrayal-shaped plays possible.
    if (staff.length >= 4 && rng.chance(0.8)) {
      const [a, b] = rng.sample(staff, 2);
      if (a && b) pair(a, b, "rival", rng.float(0.05, 0.2));
    }
  }

  // Personal ties across the whole city.
  for (const person of all) {
    if (rng.chance(0.45)) {
      const partner = rng.pick(all.filter((n) => n.id !== person.id && n.age >= 21));
      pair(person, partner, rng.chance(0.6) ? "spouse" : "partner", rng.float(0.75, 0.95));
    }
    if (rng.chance(0.3)) {
      const relative = rng.pick(all.filter((n) => n.id !== person.id));
      pair(person, relative, rng.pick(["sibling", "cousin"] as const), rng.float(0.6, 0.9));
    }
    const friends = rng.sample(
      all.filter((n) => n.id !== person.id),
      rng.int(1, 3),
    );
    for (const friend of friends) pair(person, friend, "friend", rng.float(0.4, 0.75));
  }

  // Affairs are drawn from people who already have a partner — that is what
  // gives the secret its weight and its blast radius.
  const attached = all.filter((n) => n.relationships.some((r) => r.kind === "spouse" || r.kind === "partner"));
  const affairCount = Math.max(2, Math.floor(attached.length * 0.16));
  for (let i = 0; i < affairCount; i++) {
    const a = rng.pick(attached);
    const options = all.filter(
      (n) =>
        n.id !== a.id &&
        !a.relationships.some((r) => r.otherId === n.id && (r.kind === "spouse" || r.kind === "partner")),
    );
    if (options.length === 0) continue;
    pair(a, rng.pick(options), "affair", rng.float(0.65, 0.9), true);
  }
}

function wireSecrets(city: City, npcs: Map<NpcId, Npc>, rng: Rng): void {
  const all = [...npcs.values()];
  for (const npc of all) {
    const arch = archetype(npc.archetypeId);
    // Evidence that is *not* the phone: their own home hub, their employer's
    // records, or the clinic. Layer 2 needs at least one of these.
    const evidence: NodeId[] = npc.deviceIds.filter((id) => id !== npc.phoneNodeId);
    const orgRecordNodes = npc.orgId
      ? [...city.nodes.values()]
          .filter((n) => n.ownerId === npc.orgId && n.capabilities.includes("records"))
          .map((n) => n.id)
      : [];
    const clinicNodes = [...city.nodes.values()]
      .filter((n) => n.ownerId === "org_meridian" && n.capabilities.includes("records"))
      .map((n) => n.id);

    const affairPartners = npc.relationships.filter((r) => r.kind === "affair");
    const count = rng.int(1, 3);
    const secrets = generateSecrets(
      {
        self: npc,
        candidates: affairPartners.length > 0
          ? affairPartners.map((r) => npcs.get(r.otherId)!).filter(Boolean)
          : all.filter((n) => n.id !== npc.id),
        archetypeBias: arch.secretBias,
        rng,
        evidenceNodeIds: [...evidence, ...rng.sample(orgRecordNodes, 2), ...rng.sample(clinicNodes, 1)],
      },
      count,
    );
    npc.secrets = secrets;
  }
}

/**
 * Work credentials. An account that `grantsNodeId` a workplace terminal is the
 * bridge between "I read your phone" and "I am now logged in as you".
 */
function grantWorkCredentials(city: City, npcs: Map<NpcId, Npc>, rng: Rng): void {
  for (const npc of npcs.values()) {
    if (!npc.orgId || !npc.workPlaceId) continue;
    const terminals = [...city.nodes.values()].filter(
      (n) => n.kind === "terminal" && n.ownerId === npc.orgId,
    );
    if (terminals.length === 0) continue;
    const granted = rng.sample(terminals, npc.clearance === "restricted" ? 2 : 1);
    for (const terminal of granted) {
      npc.accounts.push({
        id: `acct_${npc.id}_work_${terminal.id}`,
        service: "ShiftKey SSO",
        handle: `${npc.name.split(" ")[0]!.toLowerCase()}.${npc.name.split(" ")[1]!.toLowerCase()}`,
        password: rng.chance(0.4)
          ? npc.accounts.find((a) => a.reused)?.password ?? `${rng.pick(PASSWORD_WORDS)}${rng.int(10, 99)}`
          : `${rng.pick(PASSWORD_WORDS)}${rng.int(1000, 9999)}`,
        reused: false,
        grantsNodeId: terminal.id,
      });
    }
  }
}
