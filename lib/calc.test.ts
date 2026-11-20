import { test } from "node:test";
import assert from "node:assert/strict";
import { computeTf, rollCandles, liveDeltaTurnover, CANDLE_MS, type SymbolState } from "./calc.ts";

function mk(len: number, amount = 100): SymbolState {
  const t0 = 1_700_000_100_000 - (1_700_000_100_000 % CANDLE_MS);
  return {
    symbol: "X_USDT",
    price: 110,
    amount24: 1000,
    volume24: 10,
    t: Array.from({ length: len }, (_, i) => t0 + i * CANDLE_MS),
    o: Array.from({ length: len }, (_, i) => 100 + i),
    c: Array.from({ length: len }, (_, i) => 101 + i),
    a: Array.from({ length: len }, () => amount),
    anchorAmount24: 1000,
    anchorVolume24: 10,
    liveDelta: 0,
  };
}

test("15M uses candle[last-2] open and 9-candle baseline / 3", () => {
  const st = mk(24);
  st.a[23] = 400; st.a[22] = 100; st.a[21] = 100; // current 15m = 600
  st.liveDelta = 0;
  const m = computeTf(st, "15M");
  assert.equal(m.move, ((110 - st.o[21]) / st.o[21]) * 100);
  assert.equal(m.turnover, 600);
  // baseline = 9 * 100 / 3 = 300 -> +100%
  assert.equal(m.volChange, 100);
});

test("30M / 1H windows and live delta", () => {
  const st = mk(24);
  st.liveDelta = 600;
  const m30 = computeTf(st, "30M");
  assert.equal(m30.turnover, 1200);
  assert.equal(m30.volChange, 100);
  assert.equal(m30.move, ((110 - st.o[18]) / st.o[18]) * 100);
  const h1 = computeTf(st, "1H");
  assert.equal(h1.turnover, 1800);
  assert.equal(h1.volChange, 50);
  assert.equal(h1.move, ((110 - st.o[12]) / st.o[12]) * 100);
});

test("short history returns null volChange / move", () => {
  assert.equal(computeTf(mk(12), "1H").volChange, null);
  assert.equal(computeTf(mk(2), "15M").move, null);
});

test("liveDelta clamps and falls back to volume24 * price", () => {
  const st = { anchorAmount24: 1000, anchorVolume24: 10 };
  assert.equal(liveDeltaTurnover(st, { amount24: 900, lastPrice: 1 }), 0);
  assert.equal(liveDeltaTurnover(st, { amount24: 1500, lastPrice: 1 }), 500);
  assert.equal(liveDeltaTurnover(st, { volume24: 12, lastPrice: 5 }), 10);
});

test("rollover settles delta, appends candle, keeps 24", () => {
  const st = mk(24);
  st.liveDelta = 50;
  st.amount24 = 1050;
  const last = st.t[23];
  assert.equal(rollCandles(st, last + CANDLE_MS - 1), false);
  assert.equal(rollCandles(st, last + CANDLE_MS + 5), true);
  assert.equal(st.t.length, 24);
  assert.equal(st.a[22], 150);
  assert.equal(st.a[23], 0);
  assert.equal(st.o[23], 110);
  assert.equal(st.liveDelta, 0);
  assert.equal(st.anchorAmount24, 1050);
});
