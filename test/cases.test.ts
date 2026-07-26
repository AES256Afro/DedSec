/**
 * The casual loop.
 *
 * Every case has to be findable by playing and closable once found. A case
 * nobody can notice is worse than no case at all — it is content the player is
 * told exists and can never reach — so both halves get asserted here rather
 * than assumed, in the same spirit as `contracts.test.ts`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { CASE_TEMPLATES, caseFlag, casesFor, installCases, ledgerLine, refreshCases, resolveCase } from "../src/case/cases.js";
import type { CaseKind } from "../src/case/types.js";
import { at } from "../src/core/time.js";
import { newGame } from "../src/game.js";
import { breachNode } from "../src/hack/breach.js";
import { profilableNpcs } from "../src/hack/access.js";
import { passiveScan, recomputeLayer } from "../src/profile/profiler.js";
import type { GameState } from "../src/sim/state.js";
import { advance } from "../src/sim/step.js";

function open(state: GameState, caseId: string): void {
  const record = state.cases.find((c) => c.id === caseId)!;
  state.player.hackRange = 100_000;
  for (const id of record.evidenceNodeIds) {
    for (let i = 0; i < 30 && !state.player.breachedNodeIds.has(id); i++) breachNode(state, id);
  }
  for (const person of state.npcs.values()) recomputeLayer(state, person);
  for (const id of [record.subjectNpcId, record.harmNpcId]) {
    const person = id ? state.npcs.get(id) : undefined;
    if (person) passiveScan(state, person);
  }
  refreshCases(state);
}

/* ------------------------------------------------------------- generation */

test("a fresh city comes with a caseload, and both halves of every case exist", () => {
  const state = newGame({ seed: "cases" });
  assert.ok(state.cases.length >= 6, `expected a caseload, got ${state.cases.length}`);

  for (const record of state.cases) {
    assert.ok(state.npcs.has(record.subjectNpcId), `${record.id} names a subject who does not exist`);
    if (record.harmNpcId) {
      assert.ok(state.npcs.has(record.harmNpcId), `${record.id} names a perpetrator who does not exist`);
      assert.notEqual(record.harmNpcId, record.subjectNpcId, `${record.id} has somebody harming themselves`);
    }
    assert.ok(record.headline.length > 40, `${record.id} needs a real headline`);
    assert.ok(record.tell.length > 20, `${record.id} needs an observable tell`);
    assert.ok(record.evidenceNodeIds.length > 0, `${record.id} has no evidence anywhere`);
    assert.ok(
      record.resolutions.some((r) => r.kind === "walk_away"),
      `${record.id} does not let the player walk away, and every case must`,
    );
  }
});

test("nobody is entangled in two cases at once", () => {
  // Two red flags on one person reads as a bug even when it is not, and it
  // makes the pairing — the actual design — impossible to see.
  const state = newGame({ seed: "solo" });
  const seen = new Set<string>();
  for (const record of state.cases) {
    for (const id of [record.subjectNpcId, record.harmNpcId]) {
      if (!id) continue;
      assert.ok(!seen.has(id), `${id} is a party to two cases`);
      seen.add(id);
    }
  }
});

test("a predatory tie is written into the social graph, not bolted on beside it", () => {
  // The point of putting the relationship in `npc.relationships` is that every
  // existing system — the dossier, the verb layer, suspicion propagation —
  // sees it without knowing cases exist.
  const state = newGame({ seed: "graph" });
  const withTie = state.cases.filter((c) => c.harmNpcId && ["shakedown", "supply", "squeeze", "fixation"].includes(c.kind));
  assert.ok(withTie.length > 0, "no seed should produce a caseload with no ties at all");

  const PREDATORY = ["creditor", "dealer", "landlord", "ex"];
  for (const record of withTie) {
    const harm = state.npcs.get(record.harmNpcId!)!;
    // There may well be an ordinary relationship between them too — a creditor
    // who is also a friend is the most plausible version of the thing — so look
    // for the predatory one specifically rather than the first one found.
    const tie = harm.relationships.find((r) => r.otherId === record.subjectNpcId && PREDATORY.includes(r.kind));
    assert.ok(tie, `${record.id}: ${harm.name} has no predatory tie to the person they are harming`);
    assert.ok(tie!.covert, `${record.id}: a predatory tie should be concealed`);
  }
});

test("the caseload is deterministic for a seed and different across seeds", () => {
  const fingerprint = (s: GameState) => s.cases.map((c) => `${c.kind}:${c.subjectNpcId}:${c.harmNpcId ?? "-"}`).join("|");
  assert.equal(fingerprint(newGame({ seed: "same" })), fingerprint(newGame({ seed: "same" })));
  assert.notEqual(fingerprint(newGame({ seed: "same" })), fingerprint(newGame({ seed: "other" })));
});

test("every template can actually place, given enough cities", () => {
  // A template that never fires is dead content. This is the only assertion
  // that catches one whose preconditions the population generator never meets —
  // `coercion` was exactly that until the manager/report link was un-inverted.
  const seen = new Set<CaseKind>();
  for (const seed of ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"]) {
    for (const record of newGame({ seed }).cases) seen.add(record.kind);
  }
  for (const template of CASE_TEMPLATES) {
    assert.ok(seen.has(template.kind), `no seed in twelve ever produced a "${template.kind}" case`);
  }
});

/* ----------------------------------------------------------------- notice */

test("a case surfaces by walking past, then opens by reading a phone", () => {
  const state = newGame({ seed: "notice" });
  const record = state.cases[0]!;
  assert.equal(record.status, "unseen", "you have not met anybody yet");

  // Scanning one party is enough to see the shape of it — that is the whole
  // reason to keep walking.
  passiveScan(state, state.npcs.get(record.subjectNpcId)!);
  refreshCases(state);
  assert.equal(record.status, "flagged");
  assert.equal(caseFlag(state, record.subjectNpcId), record.harmNpcId ? "need" : "need");
  if (record.harmNpcId) assert.equal(caseFlag(state, record.harmNpcId), "harm");

  // But not to know what it is.
  assert.equal(
    resolveCase(state, record.id, record.resolutions[0]!.kind === "walk_away" ? "help" : record.resolutions[0]!.kind).ok,
    false,
    "you should not be able to act on a case you have only glimpsed",
  );

  open(state, record.id);
  assert.equal(record.status, "open");
});

test("releasing a node does not un-know a case", () => {
  const state = newGame({ seed: "sticky" });
  const record = state.cases[0]!;
  open(state, record.id);
  for (const id of record.evidenceNodeIds) state.player.breachedNodeIds.delete(id);
  refreshCases(state);
  assert.equal(record.status, "open", "what you have read, you have read");
});

test("walking around is enough to find people — the profiler does not need line of sight", () => {
  // ctOS reads handsets, not faces. Two-thirds of the city is indoors during
  // office hours, and a street client that could only profile what it could see
  // would be a street client with nobody on the street.
  const state = newGame({ seed: "walk", startAt: at(0, 11, 0) });
  const inRange = profilableNpcs(state);
  assert.ok(inRange.length >= 5, `only ${inRange.length} people readable from the spawn point`);
  assert.ok(
    inRange.some((n) => state.city.graph.place(n.placeId).indoor),
    "at least one of them should be indoors, or this is just line of sight again",
  );
});

/* ------------------------------------------------------------- resolution */

test("every case in a fresh city can be closed, whichever way the player leans", () => {
  for (const kind of ["help", "expose", "warn"] as const) {
    const state = newGame({ seed: `close_${kind}` });
    let acted = 0;

    for (const record of [...state.cases]) {
      open(state, record.id);
      assert.equal(record.status, "open", `${record.id} (${record.kind}) could not be opened`);
      const offered = record.resolutions.find((r) => r.kind === kind);
      if (!offered) continue; // `undertow` has nobody to expose, by design
      const outcome = resolveCase(state, record.id, kind);
      assert.ok(outcome.ok, `${record.id} (${record.kind}) refused "${kind}": ${outcome.message}`);
      assert.equal(record.status, "resolved");
      acted++;
    }

    assert.ok(acted > 0, `no case in the city offered "${kind}"`);
    const ledger = state.ledger;
    const counted = kind === "help" ? ledger.helped : kind === "expose" ? ledger.exposed : ledger.warned;
    assert.equal(counted, acted, `the ledger lost ${acted - counted} of them`);
  }
});

test("helping severs the thing that was doing the harm", () => {
  const state = newGame({ seed: "sever" });
  const record = state.cases.find((c) => c.harmNpcId && c.resolutions.some((r) => r.kind === "help"))!;
  open(state, record.id);

  const harm = state.npcs.get(record.harmNpcId!)!;
  const subject = state.npcs.get(record.subjectNpcId)!;
  subject.stress = 0.8;

  assert.ok(harm.relationships.some((r) => r.otherId === subject.id));
  assert.ok(resolveCase(state, record.id, "help").ok);
  assert.ok(subject.stress < 0.8, "the point of helping is that it lands on them");
  assert.equal(
    harm.relationships.some((r) => r.otherId === subject.id && ["creditor", "dealer", "landlord", "ex"].includes(r.kind)),
    false,
    "a case you fixed should not regenerate the same pressure tomorrow",
  );
});

test("exposing takes the person doing it off the floor", () => {
  const state = newGame({ seed: "expose" });
  const record = state.cases.find((c) => c.harmNpcId && c.resolutions.some((r) => r.kind === "expose"))!;
  open(state, record.id);
  const harm = state.npcs.get(record.harmNpcId!)!;

  assert.ok(resolveCase(state, record.id, "expose").ok);
  assert.equal(harm.condition, "off_site");
  assert.ok(state.log.happened("case.exposed", harm.id), "the city has to visibly act, or nothing happened");
});

test("walking away is always available and never punished", () => {
  const state = newGame({ seed: "pass" });
  const record = state.cases[0]!;
  // Deliberately without opening it: you are allowed to decide it is not yours
  // before you know what it is.
  const outcome = resolveCase(state, record.id, "walk_away");
  assert.ok(outcome.ok);
  assert.equal(record.status, "resolved");
  assert.equal(state.ledger.walkedPast, 1);
  assert.equal(state.trace.evidence, 0, "declining to act cannot possibly be evidence of anything");
});

test("a resolved case stops flagging anyone", () => {
  const state = newGame({ seed: "quiet" });
  const record = state.cases.find((c) => c.harmNpcId)!;
  open(state, record.id);
  assert.equal(caseFlag(state, record.harmNpcId!), "harm");

  resolveCase(state, record.id, "expose");
  advance(state, 5);
  assert.equal(caseFlag(state, record.harmNpcId!), undefined);
  assert.deepEqual(casesFor(state, record.harmNpcId!), []);
});

/* -------------------------------------------------------------- the ledger */

test("the ledger reads as a record of a walk, not a score", () => {
  const state = newGame({ seed: "ledger" });
  assert.match(ledgerLine(state.ledger), /^\d+ profiled$/);

  open(state, state.cases[0]!.id);
  resolveCase(state, state.cases[0]!.id, "help");
  const line = ledgerLine(state.ledger);
  assert.match(line, /1 helped/);
  assert.doesNotMatch(line, /%|score|\//, "no percentages, no denominators, nothing to complete");
});
