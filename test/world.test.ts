import assert from "node:assert/strict";
import { test } from "node:test";

import { newGame } from "../src/game.js";
import { generateCity } from "../src/world/generator.js";
import { TARGET_LAB_KEY } from "../src/world/blueprint.js";
import { ZONE_RANK } from "../src/world/types.js";

test("the city generates the same way twice from one seed", () => {
  const a = generateCity("foundry");
  const b = generateCity("foundry");
  assert.equal(a.graph.places.size, b.graph.places.size);
  assert.equal(a.nodes.size, b.nodes.size);
  assert.deepEqual([...a.nodes.keys()].sort(), [...b.nodes.keys()].sort());
});

test("every place is reachable from the street when nothing is locked", () => {
  const city = generateCity("reachability");
  const start = city.streetPlaceIds.get("s_foundry_mid")!;
  const reachable = city.graph.reachable(start, 10_000);
  const orphans = [...city.graph.places.values()].filter((p) => !reachable.has(p.id));
  assert.deepEqual(
    orphans.map((p) => p.id),
    [],
    "no room should be sealed off from the rest of the world",
  );
});

test("restricted rooms are actually gated", () => {
  const city = generateCity("gating");
  const lab = city.graph.place(city.roomPlaceIds.get(TARGET_LAB_KEY)!);
  assert.equal(lab.zone, "restricted");

  const guardedEdges = city.graph.edgesFrom(lab.id).filter((e) => e.doorId);
  assert.ok(guardedEdges.length > 0, "the prototype lab must sit behind a door");
  for (const edge of guardedEdges) {
    const door = city.graph.doors.get(edge.doorId!)!;
    assert.ok(door.locked, "lab doors start locked");
    assert.ok(ZONE_RANK[door.clearance] >= ZONE_RANK["staff"]);
  }
});

test("no outdoor place sits inside a building footprint", () => {
  const city = generateCity("layout");
  const outdoor = [...city.graph.places.values()].filter((p) => !p.indoor);
  const overlaps: string[] = [];
  for (const place of outdoor) {
    for (const b of city.buildings.values()) {
      const inside =
        place.x > b.x - 14 &&
        place.x < b.x + b.width + 14 &&
        place.y > b.y - 14 &&
        place.y < b.y + b.depth + 14;
      if (inside) overlaps.push(`${place.name} is drawn inside ${b.name}`);
    }
  }
  assert.deepEqual(overlaps, [], "streets and plazas must not be plotted on top of buildings");
});

test("buildings do not overlap each other", () => {
  const city = generateCity("footprints");
  const list = [...city.buildings.values()];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i]!;
      const b = list[j]!;
      const overlap =
        a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.depth && a.y + a.depth > b.y;
      assert.ok(!overlap, `${a.name} overlaps ${b.name}`);
    }
  }
});

test("every network node lives in a real place and a real subnet", () => {
  const city = generateCity("nodes");
  for (const node of city.nodes.values()) {
    assert.ok(city.graph.places.has(node.placeId), `${node.label} has a dangling place`);
    assert.ok(city.subnets.has(node.subnetId), `${node.label} has a dangling subnet`);
    assert.ok(node.capabilities.length > 0, `${node.label} can do nothing at all`);
  }
});

test("each building has exactly one gateway, and it is behind the tightest door available", () => {
  const city = generateCity("gateways");
  for (const building of city.buildings.values()) {
    const routers = [...city.nodes.values()].filter(
      (n) => n.kind === "router" && city.graph.places.get(n.placeId)?.buildingId === building.id,
    );
    assert.equal(routers.length, 1, `${building.name} should have one gateway`);
    const room = city.graph.place(routers[0]!.placeId);
    const best = Math.max(
      ...city.graph.placesInBuilding(building.id).map((p) => ZONE_RANK[p.zone]),
    );
    assert.equal(ZONE_RANK[room.zone], best, `${building.name} gateway should be in its most protected room`);
  }
});

test("pathfinding respects locked doors and finds a way when they open", () => {
  const state = newGame({ seed: "pathing" });
  const graph = state.city.graph;
  const street = state.city.streetPlaceIds.get("s_foundry_plaza")!;
  const lab = state.city.roomPlaceIds.get(TARGET_LAB_KEY)!;

  const blocked = graph.findPath(street, lab, (_e, door) => !door || !door.locked);
  assert.equal(blocked, undefined, "you should not be able to stroll into the lab");

  const open = graph.findPath(street, lab);
  assert.ok(open, "with every door open there is a route");
  assert.ok(open!.steps.length > 3, "and it genuinely goes through the building");
});

test("a path's cost equals the sum of its steps", () => {
  const city = generateCity("cost");
  const a = city.streetPlaceIds.get("s_foundry_w")!;
  const b = city.streetPlaceIds.get("s_terrace_s")!;
  const path = city.graph.findPath(a, b);
  assert.ok(path);
  const summed = path!.steps.reduce((total, s) => total + s.minutes, 0);
  assert.ok(Math.abs(summed - path!.minutes) < 1e-9);
});

test("sightlines are symmetric where the generator declares them", () => {
  const city = generateCity("sight");
  const lobby = city.roomPlaceIds.get("n0_lobby");
  const plaza = city.streetPlaceIds.get("s_foundry_plaza");
  assert.ok(lobby && plaza);
  assert.ok(city.graph.canSee(lobby!, plaza!, 500));
  assert.ok(city.graph.canSee(plaza!, lobby!, 500));
});

test("you cannot see between floors", () => {
  const city = generateCity("floors");
  const ground = city.roomPlaceIds.get("n0_lobby")!;
  const lab = city.roomPlaceIds.get(TARGET_LAB_KEY)!;
  assert.ok(!city.graph.canSee(ground, lab, 10_000));
});
