import { test } from "node:test";
import assert from "node:assert/strict";
import { Top15Tracker } from "./alerts.ts";

const list = (n: number, prefix = "S") => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

test("first update seeds silently", () => {
  const t = new Top15Tracker();
  assert.deepEqual(t.update(list(30)), []);
  assert.equal(t.isSeeded, true);
});

test("entry from outside top 15 into top 10 fires once", () => {
  const t = new Top15Tracker();
  const base = list(30);
  t.update(base);
  const jumped = ["S20", ...base.filter((s) => s !== "S20")];
  assert.deepEqual(t.update(jumped), ["S20"]);
  assert.deepEqual(t.update(jumped), []);
});

test("rank 11-15 -> top 10 does not fire (hysteresis)", () => {
  const t = new Top15Tracker();
  const base = list(30);
  t.update(base);
  const moved = ["S13", ...base.filter((s) => s !== "S13")];
  assert.deepEqual(t.update(moved), []);
});

test("must leave top 15 to re-arm", () => {
  const t = new Top15Tracker();
  const base = list(30);
  t.update(base);
  // S0 drops to rank 21 (outside top 15) -> disarmed from registry
  const dropped = [...base.slice(1, 21), "S0", ...base.slice(21)];
  t.update(dropped);
  // S0 returns to #1 -> fires again
  assert.deepEqual(t.update(base), ["S0"]);
  // S0 dips to rank 14 (still inside top 15) and returns -> silent
  const dip = [...base.slice(1, 14), "S0", ...base.slice(14)];
  assert.deepEqual(t.update(dip), []);
  assert.deepEqual(t.update(base), []);
});
