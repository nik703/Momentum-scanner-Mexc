import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateTop10Entries, seedKnownTop15 } from "./alerts.ts";

const list = (n: number) => Array.from({ length: n }, (_, i) => `S${i + 1}`); // S1 = rank 1
const moveTo = (arr: string[], sym: string, rank: number) => {
  const rest = arr.filter((s) => s !== sym);
  rest.splice(rank - 1, 0, sym);
  return rest;
};

test("seeding takes ranks 1-15 silently", () => {
  const known = new Set<string>();
  seedKnownTop15(known, list(30));
  assert.equal(known.size, 15);
  assert.ok(known.has("S15") && !known.has("S16"));
});

test("entry into top 10 from outside top 15 fires once", () => {
  const known = new Set<string>();
  const base = list(30);
  seedKnownTop15(known, base);
  const jumped = moveTo(base, "S20", 3);
  assert.deepEqual(evaluateTop10Entries(known, jumped), ["S20"]);
  assert.deepEqual(evaluateTop10Entries(known, jumped), []);
});

test("move from ranks 11-15 into top 10 is silent", () => {
  const known = new Set<string>();
  const base = list(30);
  seedKnownTop15(known, base);
  assert.deepEqual(evaluateTop10Entries(known, moveTo(base, "S13", 2)), []);
});

test("oscillating between rank 9 and 13 never re-fires", () => {
  const known = new Set<string>();
  const base = list(30);
  seedKnownTop15(known, base);
  let cur = moveTo(base, "S25", 9);
  assert.deepEqual(evaluateTop10Entries(known, cur), ["S25"]);
  for (let i = 0; i < 5; i++) {
    cur = moveTo(cur, "S25", 13);
    assert.deepEqual(evaluateTop10Entries(known, cur), []);
    cur = moveTo(cur, "S25", 9);
    assert.deepEqual(evaluateTop10Entries(known, cur), []);
  }
});

test("evicted only when rank > 15 or filtered out, then re-arms", () => {
  const known = new Set<string>();
  const base = list(30);
  seedKnownTop15(known, base);
  // S1 drops to rank 16 -> evicted
  evaluateTop10Entries(known, moveTo(base, "S1", 16));
  assert.equal(known.has("S1"), false);
  assert.deepEqual(evaluateTop10Entries(known, base), ["S1"]);
  // S2 filtered out entirely -> evicted -> re-fires on return
  evaluateTop10Entries(known, base.filter((s) => s !== "S2"));
  assert.equal(known.has("S2"), false);
  assert.deepEqual(evaluateTop10Entries(known, base), ["S2"]);
});
