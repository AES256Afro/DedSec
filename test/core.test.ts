import assert from "node:assert/strict";
import { test } from "node:test";

import { Rng, hashString } from "../src/core/rng.js";
import { MINUTES_PER_DAY, at, formatTime, nextWindowStart, windowContains, windowLength } from "../src/core/time.js";
import { EventLog } from "../src/core/events.js";

test("the same seed produces the same stream", () => {
  const a = new Rng("foundry");
  const b = new Rng("foundry");
  const c = new Rng("marina");
  const drawA = Array.from({ length: 64 }, () => a.nextUint32());
  const drawB = Array.from({ length: 64 }, () => b.nextUint32());
  const drawC = Array.from({ length: 64 }, () => c.nextUint32());
  assert.deepEqual(drawA, drawB);
  assert.notDeepEqual(drawA, drawC);
});

test("rng draws stay inside their declared bounds", () => {
  const rng = new Rng(7);
  for (let i = 0; i < 5000; i++) {
    const n = rng.next();
    assert.ok(n >= 0 && n < 1);
    const k = rng.int(3, 9);
    assert.ok(k >= 3 && k <= 9 && Number.isInteger(k));
    const b = rng.bell(-2, 2);
    assert.ok(b >= -2 && b <= 2);
  }
});

test("weighted picks respect zero weights", () => {
  const rng = new Rng("weights");
  const items = ["a", "b", "c"];
  for (let i = 0; i < 500; i++) {
    const pick = rng.weighted(items, (x) => (x === "b" ? 0 : 1));
    assert.notEqual(pick, "b");
  }
});

test("sample never returns duplicates or overruns the pool", () => {
  const rng = new Rng("sample");
  const pool = [1, 2, 3, 4, 5];
  const picked = rng.sample(pool, 12);
  assert.equal(picked.length, 5);
  assert.equal(new Set(picked).size, 5);
});

test("forked streams diverge but stay deterministic", () => {
  const makeForks = () => {
    const parent = new Rng("city");
    return [parent.fork("a").nextUint32(), parent.fork("b").nextUint32()];
  };
  const first = makeForks();
  assert.deepEqual(first, makeForks());
  assert.notEqual(first[0], first[1]);
});

test("hashString is stable and order-sensitive", () => {
  assert.equal(hashString("nodalis"), hashString("nodalis"));
  assert.notEqual(hashString("nodalis"), hashString("silanod"));
});

test("day windows handle the midnight wrap", () => {
  const nightShift = { startMinute: 20 * 60, endMinute: 4 * 60 };
  assert.ok(windowContains(nightShift, at(0, 22, 30)));
  assert.ok(windowContains(nightShift, at(1, 2, 0)));
  assert.ok(!windowContains(nightShift, at(1, 12, 0)));
  assert.equal(windowLength(nightShift), 8 * 60);

  const dayShift = { startMinute: 9 * 60, endMinute: 17 * 60 };
  assert.ok(windowContains(dayShift, at(3, 12, 0)));
  assert.ok(!windowContains(dayShift, at(3, 8, 59)));
  assert.equal(windowLength(dayShift), 8 * 60);
});

test("nextWindowStart never returns a time in the past", () => {
  const w = { startMinute: 9 * 60, endMinute: 17 * 60 };
  const now = at(2, 14, 0);
  const next = nextWindowStart(w, now);
  assert.ok(next >= now);
  assert.equal(next, at(3, 9, 0));
  assert.equal(nextWindowStart(w, at(2, 8, 0)), at(2, 9, 0));
});

test("time formatting is wall-clock, not elapsed", () => {
  assert.equal(formatTime(at(0, 8, 5)), "08:05");
  assert.equal(formatTime(at(9, 8, 5)), "08:05");
  assert.equal(formatTime(MINUTES_PER_DAY - 1), "23:59");
});

test("the event log keeps order, caps growth, and answers history questions", () => {
  const log = new EventLog(50);
  for (let i = 0; i < 120; i++) {
    log.emit(i, { channel: "world", kind: i === 3 ? "world.special" : "world.tick", text: `t${i}`, subjects: ["x"] });
  }
  assert.equal(log.all().length, 50);
  assert.equal(log.recent(3)[0]!.text, "t119");
  assert.ok(log.happened("world.tick", "x", 100));
  assert.ok(!log.happened("world.special"), "trimmed events fall out of history");
  assert.equal(log.since(115).length, 5);
});

test("subscribers see events as they are emitted", () => {
  const log = new EventLog();
  const seen: string[] = [];
  const unsubscribe = log.subscribe((e) => seen.push(e.kind));
  log.emit(0, { channel: "hack", kind: "one", text: "" });
  unsubscribe();
  log.emit(1, { channel: "hack", kind: "two", text: "" });
  assert.deepEqual(seen, ["one"]);
});
