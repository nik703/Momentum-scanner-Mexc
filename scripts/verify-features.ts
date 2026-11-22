/**
 * Engine and parser verification: `npm run verify` (runs `tsx scripts/verify-features.ts`).
 * Checks the bias engine, the cross-exchange liquidation parsers, symbol normalization
 * and 1S candle bucketing against realistic payloads. Exits non-zero on any failure.
 * Not imported by the app, so it never ends up in the client bundle.
 */
import assert from "node:assert/strict";
import { LeaderboardAlertEngine } from "../lib/alerts.ts";
import { nextPingSlot } from "../lib/audio.ts";
import {
  anchorFor,
  candleX,
  clampBars,
  computeViewport,
  fitWatermarkPx,
  indexAtX,
  resolveOffset,
  zoomBars,
} from "../lib/chartViewport.ts";
import { calculateBiasScore, type BiasResult } from "../lib/biasScore.ts";
import { mergeMin1, parseDealPush, parseKlinePush, SecondCandleBuilder } from "../lib/candles.ts";
import {
  instrumentBase,
  okxNotionalUsd,
  parseBinanceForceOrder,
  parseBybitLiquidation,
  parseOkxInstruments,
  parseOkxLiquidation,
  selectLivePings,
  totalsSince,
  type LiqEvent,
} from "../lib/liquidations.ts";
import { baseAsset, normalizeSymbol } from "../lib/symbol.ts";
import type { Candle } from "../lib/types.ts";

let passed = 0;
const failures: string[] = [];
function check(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message.split("\n").join("\n      ") : String(e)}`);
  }
}
const finiteResult = (r: BiasResult) => {
  for (const [k, v] of Object.entries(r)) {
    if (typeof v === "number") assert.ok(Number.isFinite(v), `${k} is not finite: ${v}`);
  }
};

/* ------------------------------------------------------------------ */
/* Synthetic Min1 series                                               */
/* ------------------------------------------------------------------ */
const T0 = Date.UTC(2026, 10, 21, 12, 0);
function series(opts: { n?: number; start?: number; drift: number; baseVol: number; recentVol: number; wick?: number }): Candle[] {
  const n = opts.n ?? 60;
  const out: Candle[] = [];
  let p = opts.start ?? 100;
  for (let i = 0; i < n; i++) {
    const recent = i >= n - 15;
    const o = p;
    const c = recent ? p * (1 + opts.drift) : p * (1 + (i % 2 ? 0.0004 : -0.0004));
    const w = opts.wick ?? 0.0002;
    out.push({
      t: T0 + i * 60_000,
      o,
      c,
      h: Math.max(o, c) * (1 + w),
      l: Math.min(o, c) * (1 - w),
      v: 1000,
      a: recent ? opts.recentVol : opts.baseVol,
    });
    p = c;
  }
  return out;
}

console.log("\n[1] calculateBiasScore");

check("strong bullish lands in +35..+50", () => {
  const r = calculateBiasScore({
    candles: series({ drift: 0.002, baseVol: 50_000, recentVol: 150_000 }),
    longLiqUsd15m: 10_000,
    shortLiqUsd15m: 400_000,
  });
  finiteResult(r);
  console.log(`      -> ${JSON.stringify(r)}`);
  assert.ok(r.total >= 35 && r.total <= 50, `total ${r.total}`);
  assert.equal(r.label, "BULLISH");
  assert.ok(r.price > 0 && r.price <= 20 && r.volume > 0 && r.volume <= 15 && r.liquidation > 0 && r.liquidation <= 15);
});

check("strong bearish lands in -50..-35", () => {
  const r = calculateBiasScore({
    candles: series({ drift: -0.002, baseVol: 50_000, recentVol: 150_000 }),
    longLiqUsd15m: 400_000,
    shortLiqUsd15m: 10_000,
  });
  finiteResult(r);
  console.log(`      -> ${JSON.stringify(r)}`);
  assert.ok(r.total <= -35 && r.total >= -50, `total ${r.total}`);
  assert.equal(r.label, "BEARISH");
});

check("perfectly flat market is exactly 0.0 NEUTRAL (zero-range CLV guard)", () => {
  const flat: Candle[] = Array.from({ length: 60 }, (_, i) => ({ t: T0 + i * 60_000, o: 5, h: 5, l: 5, c: 5, v: 10, a: 1_000 }));
  const r = calculateBiasScore({ candles: flat, longLiqUsd15m: 0, shortLiqUsd15m: 0 });
  finiteResult(r);
  assert.deepEqual([r.total, r.price, r.volume, r.liquidation, r.label], [0, 0, 0, 0, "NEUTRAL"]);
  assert.ok(!Object.is(r.total, -0), "total must not be -0 (would render as -0.0)");
});

check("empty input is 0.0 with no NaN/Infinity", () => {
  const r = calculateBiasScore({ candles: [], longLiqUsd15m: 0, shortLiqUsd15m: 0 });
  finiteResult(r);
  assert.equal(r.total, 0);
  assert.equal(r.sampleSize, 0);
});

check("zero-volume candles: volume component 0, still finite", () => {
  const c = series({ drift: 0.001, baseVol: 0, recentVol: 0 });
  const r = calculateBiasScore({ candles: c, longLiqUsd15m: 0, shortLiqUsd15m: 0 });
  finiteResult(r);
  assert.equal(r.volume, 0);
});

check("zero baseline volume with live volume: surge capped, finite", () => {
  const r = calculateBiasScore({ candles: series({ drift: 0.001, baseVol: 0, recentVol: 10_000 }), longLiqUsd15m: 0, shortLiqUsd15m: 0 });
  finiteResult(r);
  assert.ok(r.volume <= 15);
});

check("garbage inputs (NaN/Infinity/negative) never leak NaN", () => {
  const bad: Candle[] = [
    { t: T0, o: Number.NaN, h: 1, l: 1, c: 1, v: 1, a: 1 },
    { t: T0 + 60_000, o: 1, h: Number.POSITIVE_INFINITY, l: 1, c: 1, v: 1, a: 1 },
    { t: T0 + 120_000, o: 0, h: 0, l: 0, c: 0, v: 0, a: 0 },
    { t: T0 + 180_000, o: 2, h: 2.1, l: 1.9, c: 2.05, v: 5, a: Number.NaN },
  ];
  const r = calculateBiasScore({ candles: bad, longLiqUsd15m: Number.NaN, shortLiqUsd15m: Number.POSITIVE_INFINITY });
  finiteResult(r);
});

check("short history (5 candles, no baseline) works", () => {
  const r = calculateBiasScore({ candles: series({ n: 5, drift: 0.003, baseVol: 1, recentVol: 1 }), longLiqUsd15m: 0, shortLiqUsd15m: 0 });
  finiteResult(r);
  assert.equal(r.sampleSize, 5);
  assert.ok(r.total > 0);
});

check("dust liquidations are damped by the $25k floor", () => {
  const r = calculateBiasScore({ candles: [], longLiqUsd15m: 0, shortLiqUsd15m: 2_500 });
  assert.equal(r.liquidation, 1.5); // 2.5k / 25k × 15
});

check("component clamps hold at the extremes", () => {
  const r = calculateBiasScore({
    candles: series({ drift: 0.05, baseVol: 1, recentVol: 1e9 }),
    longLiqUsd15m: 0,
    shortLiqUsd15m: 1e12,
  });
  assert.ok(r.price <= 20 && r.volume <= 15 && r.liquidation <= 15 && r.total <= 50);
});

check("total equals the rounded sum of the components", () => {
  const r = calculateBiasScore({ candles: series({ drift: 0.0007, baseVol: 9e4, recentVol: 7e4 }), longLiqUsd15m: 3e4, shortLiqUsd15m: 1e4 });
  assert.equal(r.total, Number((r.price + r.volume + r.liquidation).toFixed(1)));
});

/* ------------------------------------------------------------------ */
console.log("\n[2] Liquidation normalizers");

const binanceSample = JSON.stringify({
  e: "forceOrder",
  E: 1795296400123,
  o: { s: "SOLUSDT", S: "SELL", o: "LIMIT", f: "IOC", q: "250", p: "70.10", ap: "70.25", X: "FILLED", l: "250", z: "250", T: 1795296400100 },
});
check("Binance forceOrder SELL -> LONG LIQ, usd = ap × q", () => {
  const [e] = parseBinanceForceOrder(binanceSample, "SOL");
  assert.equal(e.exchange, "BN");
  assert.equal(e.side, "LONG");
  assert.equal(e.price, 70.25);
  assert.ok(Math.abs(e.usd - 70.25 * 250) < 1e-9);
  assert.equal(e.ts, 1795296400100);
});
check("Binance BUY -> SHORT LIQ; 1000PEPEUSDT matches base PEPE; ap=0 falls back to p", () => {
  const raw = { e: "forceOrder", E: 1, o: { s: "1000PEPEUSDT", S: "BUY", q: "1000000", p: "0.0105", ap: "0", T: 2 } };
  const [e] = parseBinanceForceOrder(raw, "PEPE");
  assert.equal(e.side, "SHORT");
  assert.ok(Math.abs(e.usd - 10_500) < 1e-6);
});
check("Binance other symbols / USDC / malformed frames filtered safely", () => {
  assert.equal(parseBinanceForceOrder(binanceSample, "BTC").length, 0);
  assert.equal(parseBinanceForceOrder({ e: "forceOrder", E: 1, o: { s: "SOLUSDC", S: "SELL", q: "2", ap: "70", p: "70", T: 1 } }, "SOL").length, 1);
  assert.equal(parseBinanceForceOrder("not json", "SOL").length, 0);
  assert.equal(parseBinanceForceOrder({ e: "forceOrder" }, "SOL").length, 0);
  assert.equal(parseBinanceForceOrder(null, "SOL").length, 0);
});

const bybitSample = JSON.stringify({
  topic: "allLiquidation.SOLUSDT",
  type: "snapshot",
  ts: 1795296401000,
  data: [
    { T: 1795296400900, s: "SOLUSDT", S: "Buy", v: "120.5", p: "70.31" },
    { T: 1795296400950, s: "SOLUSDT", S: "Sell", v: "10", p: "70.40" },
  ],
});
check("Bybit allLiquidation: S is the POSITION side (Buy -> LONG LIQ, Sell -> SHORT LIQ)", () => {
  const ev = parseBybitLiquidation(bybitSample, "SOL");
  assert.equal(ev.length, 2);
  assert.equal(ev[0].side, "LONG");
  assert.ok(Math.abs(ev[0].usd - 120.5 * 70.31) < 1e-9);
  assert.equal(ev[1].side, "SHORT");
  assert.equal(ev[1].ts, 1795296400950);
});
check("Bybit control frames (subscribe ack, pong) ignored", () => {
  assert.equal(parseBybitLiquidation('{"success":true,"ret_msg":"pong","op":"ping"}', "SOL").length, 0);
});

const okxInstruments = {
  code: "0",
  data: [
    { instId: "BTC-USDT-SWAP", ctVal: "0.01", ctValCcy: "BTC", ctType: "linear" },
    { instId: "BTC-USD-SWAP", ctVal: "100", ctValCcy: "USD", ctType: "inverse" },
    { instId: "PEPE-USDT-SWAP", ctVal: "10000000", ctValCcy: "PEPE", ctType: "linear" },
  ],
};
const ctVals = parseOkxInstruments(okxInstruments);
check("OKX instruments -> ctVal map with linear/inverse flag", () => {
  assert.equal(ctVals.size, 3);
  assert.deepEqual(ctVals.get("BTC-USD-SWAP"), { ctVal: 100, inverse: true });
  assert.deepEqual(ctVals.get("BTC-USDT-SWAP"), { ctVal: 0.01, inverse: false });
});
const okxSample = JSON.stringify({
  arg: { channel: "liquidation-orders", instType: "SWAP" },
  data: [
    { instId: "BTC-USDT-SWAP", instType: "SWAP", details: [{ side: "sell", posSide: "long", sz: "35", bkPx: "60000", ts: "1795296402000" }] },
    { instId: "BTC-USD-SWAP", instType: "SWAP", details: [{ side: "buy", posSide: "short", sz: "50", bkPx: "60100", ts: "1795296402100" }] },
    { instId: "ETH-USDT-SWAP", instType: "SWAP", details: [{ side: "sell", sz: "1", bkPx: "1600", ts: "1" }] },
  ],
});
check("OKX linear: sell -> LONG LIQ, usd = sz × bkPx × ctVal", () => {
  const ev = parseOkxLiquidation(okxSample, "BTC", ctVals);
  const lin = ev.find((e) => e.instrument === "BTC-USDT-SWAP");
  assert.ok(lin);
  assert.equal(lin.side, "LONG");
  assert.ok(Math.abs(lin.usd - 35 * 60000 * 0.01) < 1e-6); // $21,000
});
check("OKX inverse: buy -> SHORT LIQ, usd = sz × ctVal(USD), NOT × bkPx", () => {
  const inv = parseOkxLiquidation(okxSample, "BTC", ctVals).find((e) => e.instrument === "BTC-USD-SWAP");
  assert.ok(inv);
  assert.equal(inv.side, "SHORT");
  assert.equal(inv.usd, 5_000); // 50 × $100, where the raw spec formula would give $300.5M
  assert.equal(okxNotionalUsd(50, 60100, { ctVal: 100, inverse: true }), 5_000);
});
check("OKX: other bases filtered, unknown ctVal skipped, 'pong' text safe", () => {
  const ev = parseOkxLiquidation(okxSample, "BTC", ctVals);
  assert.equal(ev.length, 2);
  assert.equal(parseOkxLiquidation(okxSample, "ETH", ctVals).length, 0); // ETH ctVal not loaded
  assert.equal(parseOkxLiquidation("pong", "BTC", ctVals).length, 0);
});
check("rolling 15m totals", () => {
  const ev = [...parseBinanceForceOrder(binanceSample, "SOL"), ...parseBybitLiquidation(bybitSample, "SOL")];
  const t = totalsSince(ev, 0);
  assert.equal(t.count, 3);
  assert.ok(Math.abs(t.longUsd - (70.25 * 250 + 120.5 * 70.31)) < 1e-6);
  assert.equal(totalsSince(ev, Number.MAX_SAFE_INTEGER).count, 0);
});

/* ------------------------------------------------------------------ */
console.log("\n[3] Symbols");
check("normalizeSymbol / baseAsset / instrumentBase", () => {
  assert.deepEqual(normalizeSymbol(" sol "), { ok: true, symbol: "SOL_USDT" });
  assert.deepEqual(normalizeSymbol("solusdt"), { ok: true, symbol: "SOL_USDT" });
  assert.deepEqual(normalizeSymbol("sol-usdt"), { ok: true, symbol: "SOL_USDT" });
  assert.deepEqual(normalizeSymbol("INVALID_PAIR"), { ok: false, reason: "unsupported-quote" });
  assert.deepEqual(normalizeSymbol("<script>"), { ok: false, reason: "invalid" });
  assert.equal(baseAsset("1000PEPE_USDT"), "PEPE");
  assert.equal(baseAsset("1INCH_USDT"), "1INCH");
  assert.equal(instrumentBase("10000SATSUSDT"), "SATS");
  assert.equal(instrumentBase("BTCUSD_PERP"), "BTC");
  assert.equal(instrumentBase("PEPE-USDT-SWAP"), "PEPE");
});

/* ------------------------------------------------------------------ */
console.log("\n[4] MEXC stream parsing & 1S candles");
check("push.kline parses (MEXC sends volume as q)", () => {
  const c = parseKlinePush({ symbol: "BTC_USDT", interval: "Min1", t: 1795296360, o: 60410, c: 60417.5, h: 60417.6, l: 60410, a: 72090.25, q: 11932 });
  assert.ok(c);
  assert.equal(c.t, 1795296360_000);
  assert.equal(c.v, 11932);
  assert.equal(parseKlinePush({ t: "x" }), null);
});
check("mergeMin1 replaces the forming minute, appends new, caps at 60", () => {
  const s: Candle[] = [];
  for (let i = 0; i < 60; i++) mergeMin1(s, { t: i * 60_000, o: 1, h: 1, l: 1, c: 1, v: 1, a: 1 });
  mergeMin1(s, { t: 59 * 60_000, o: 1, h: 2, l: 1, c: 2, v: 2, a: 2 });
  assert.equal(s.length, 60);
  assert.equal(s[59].c, 2);
  mergeMin1(s, { t: 60 * 60_000, o: 2, h: 2, l: 2, c: 2, v: 1, a: 1 });
  assert.equal(s.length, 60);
  assert.equal(s[0].t, 60_000);
});
check("push.deal -> 1-second OHLCV buckets with turnover and flat padding", () => {
  const b = new SecondCandleBuilder(0.0001);
  const base = 1795296368_000;
  for (const d of [
    { p: 100, v: 10, T: 1, t: base + 100 },
    { p: 102, v: 5, T: 1, t: base + 400 },
    { p: 99, v: 5, T: 2, t: base + 900 },
    { p: 101, v: 1, T: 1, t: base + 3_050 },
  ]) {
    for (const tr of parseDealPush(d)) b.addTrade(tr);
  }
  const s = b.series;
  assert.equal(s.length, 4); // seconds 0, 1 (flat), 2 (flat), 3
  assert.deepEqual([s[0].o, s[0].h, s[0].l, s[0].c, s[0].v], [100, 102, 99, 99, 20]);
  assert.ok(Math.abs(s[0].a - (100 * 10 + 102 * 5 + 99 * 5) * 0.0001) < 1e-9);
  assert.equal(s[1].v, 0);
  assert.equal(s[1].c, 99);
  assert.equal(s[3].o, 101);
  b.advance(base + 200_000);
  assert.equal(b.series.length, 120); // retains last 120s
});

/* ------------------------------------------------------------------ */
console.log("\n[5] Drawer-aware audio alerts");

const board = (n: number) => Array.from({ length: n }, (_, i) => `C${String(i + 1).padStart(2, "0")}_USDT`); // C01 = rank 1
const move = (arr: readonly string[], sym: string, rank: number) => {
  const rest = arr.filter((x) => x !== sym);
  rest.splice(rank - 1, 0, sym);
  return rest;
};
const ctxKey = "15M|0";

check("drawer open: Rank 20 -> Rank 5 is silent, but knownTop15 updates", () => {
  const eng = new LeaderboardAlertEngine();
  let g = board(30);
  const l = board(30).map((x) => x.replace("C", "L"));
  assert.equal(eng.tick({ gainers: g, losers: l, contextKey: ctxKey, live: true, muted: false }).reseeded, true);
  assert.equal(eng.gainersKnownTop15.has("C20_USDT"), false);

  g = move(g, "C20_USDT", 5);
  const d = eng.tick({ gainers: g, losers: l, contextKey: ctxKey, live: true, muted: true });
  assert.deepEqual(d.gainers, ["C20_USDT"], "entry is still detected (NEW badge)");
  assert.equal(d.audible, false, "muted: no leaderboard ping");
  assert.equal(eng.gainersKnownTop15.has("C20_USDT"), true, "registry synced silently");
});

check("drawer closed afterwards: no delayed burst; new outside entries ping again", () => {
  const eng = new LeaderboardAlertEngine();
  let g = board(30);
  const l: string[] = [];
  eng.tick({ gainers: g, losers: l, contextKey: ctxKey, live: true, muted: false });
  // drawer open: two contracts enter, ticks keep flowing
  g = move(g, "C20_USDT", 5);
  eng.tick({ gainers: g, losers: l, contextKey: ctxKey, live: true, muted: true });
  g = move(g, "C25_USDT", 2);
  eng.tick({ gainers: g, losers: l, contextKey: ctxKey, live: true, muted: true });
  // drawer closes: the next tick (same ranks) must not replay those entries
  const after = eng.tick({ gainers: g, losers: l, contextKey: ctxKey, live: true, muted: false });
  assert.deepEqual([after.gainers, after.audible], [[], false]);
  // a genuinely new entry from outside the Top 15 pings again
  g = move(g, "C28_USDT", 7);
  const fresh = eng.tick({ gainers: g, losers: l, contextKey: ctxKey, live: true, muted: false });
  assert.deepEqual([fresh.gainers, fresh.audible], [["C28_USDT"], true]);
});

check("muted entries from ranks 11-15 stay silent after close (hysteresis intact)", () => {
  const eng = new LeaderboardAlertEngine();
  let g = board(30);
  eng.tick({ gainers: g, losers: [], contextKey: ctxKey, live: true, muted: false });
  g = move(g, "C13_USDT", 3);
  assert.equal(eng.tick({ gainers: g, losers: [], contextKey: ctxKey, live: true, muted: true }).gainers.length, 0);
  g = move(g, "C13_USDT", 12);
  g = move(g, "C13_USDT", 4);
  assert.equal(eng.tick({ gainers: g, losers: [], contextKey: ctxKey, live: true, muted: false }).audible, false);
});

const liq = (side: "LONG" | "SHORT", receivedAt: number): LiqEvent => ({
  id: `${side}${receivedAt}`,
  exchange: "BYB",
  side,
  instrument: "SOLUSDT",
  usd: 1000,
  price: 70,
  ts: receivedAt - 150, // exchange clock is slightly behind receipt, as in real life
  receivedAt,
});

check("live LONG LIQ -> long ping, live SHORT LIQ -> short ping (in arrival order)", () => {
  const openedAt = 1_000_000;
  assert.deepEqual(selectLivePings([liq("LONG", openedAt + 5), liq("SHORT", openedAt + 9)], openedAt, true), ["LONG", "SHORT"]);
});

check("mount guard: events received before drawer open never ping", () => {
  const openedAt = 1_000_000;
  assert.deepEqual(selectLivePings([liq("LONG", openedAt - 1), liq("SHORT", openedAt)], openedAt, true), ["SHORT"]);
  // a fill stamped 150ms before open by the exchange but received after open IS live
  assert.deepEqual(selectLivePings([liq("LONG", openedAt + 10)], openedAt, true), ["LONG"]);
});

check("master Ping OFF / unarmed guard: nothing plays", () => {
  assert.deepEqual(selectLivePings([liq("LONG", 5)], 1, false), []);
  assert.deepEqual(selectLivePings([liq("LONG", 5)], 0, true), []);
});

check("90ms cadence limiter spaces a 3-exchange burst and caps backlog", () => {
  let free = 0;
  const at: number[] = [];
  for (let i = 0; i < 3; i++) {
    const slot = nextPingSlot(10, free);
    assert.ok(slot);
    at.push(slot.at);
    free = slot.nextFree;
  }
  assert.deepEqual(at.map((x) => Number((x - 10).toFixed(3))), [0, 0.09, 0.18]);
  // a 20-fill cascade: no more than ~0.72s of backlog is queued; the rest is dropped
  let played = 0;
  free = 0;
  for (let i = 0; i < 20; i++) {
    const slot = nextPingSlot(20, free);
    if (slot) {
      played++;
      free = slot.nextFree;
    }
  }
  assert.equal(played, 9);
  // once the clock moves past the backlog, pings flow again immediately
  assert.deepEqual(nextPingSlot(25, free), { at: 25, nextFree: 25.09 });
});

/* ------------------------------------------------------------------ */
console.log("\n[6] Chart viewport: zoom, follow, pan, watermark");

check("zoom clamps to [10, capacity] and always moves >= 1 bar per step", () => {
  assert.equal(clampBars(3, 60), 10);
  assert.equal(clampBars(500, 120), 120);
  assert.equal(zoomBars(36, 0.8, 60), 28);
  assert.equal(zoomBars(11, 0.99, 60), 10);
  assert.equal(zoomBars(10, 0.5, 60), 10);
  assert.equal(zoomBars(58, 1.25, 60), 60);
  assert.equal(zoomBars(36, 1.001, 60), 37);
});

check("follow mode: newest candle sits in the rightmost slot at every zoom level", () => {
  const plotW = 300;
  for (const bars of [10, 23, 36, 60]) {
    const vp = computeViewport(60, bars, 0, plotW);
    assert.equal(vp.end, 60);
    assert.equal(vp.start, 60 - bars);
    assert.ok(Math.abs(candleX(vp, 59) - (plotW - vp.slotW / 2)) < 1e-9);
    assert.equal(vp.bodyW, Math.max(2, Math.floor((plotW / bars) * 0.68)));
  }
  // zooming in -> wider candles
  assert.ok(computeViewport(60, 10, 0, 300).bodyW > computeViewport(60, 36, 0, 300).bodyW);
  // body never collapses below 2px, even at 120 bars in a narrow plot
  assert.equal(computeViewport(120, 120, 0, 200).bodyW, 2);
});

check("short series right-align (no stretching) and index/X round-trip", () => {
  const vp = computeViewport(5, 36, 0, 360);
  assert.equal(vp.start, 0);
  for (let i = 0; i < 5; i++) assert.equal(indexAtX(vp, candleX(vp, i)), i);
  assert.equal(indexAtX(vp, 1), -1); // empty slots on the left
});

check("pan anchors to a timestamp: new live bars don't drag the historical view", () => {
  const times = Array.from({ length: 60 }, (_, i) => i * 60_000);
  const anchor = anchorFor(times, 12, 36);
  assert.equal(anchor, times[47]);
  assert.equal(resolveOffset(times, anchor, 36), 12);
  // a new minute arrives and the buffer shifts by one (60-cap)
  const next = [...times.slice(1), 60 * 60_000];
  assert.equal(resolveOffset(next, anchor, 36), 13, "same bars stay in view");
  // offsets clamp to the available history; offset 0 => follow (null anchor)
  assert.equal(resolveOffset(times, anchorFor(times, 999, 36), 36), 24);
  assert.equal(anchorFor(times, 0, 36), null);
  assert.equal(anchorFor(times, -5, 36), null);
  assert.equal(resolveOffset(times, null, 36), 0);
});

check("watermark font fits ~60% of plot width, clamped 28..68px", () => {
  // 98,420.5 at 100px mono ~ 480px wide; plot 420px -> 52.5px
  assert.ok(Math.abs(fitWatermarkPx(480, 420, 200) - 52.5) < 1e-9);
  assert.equal(fitWatermarkPx(480, 2000, 200), 68); // cap
  assert.equal(fitWatermarkPx(720, 200, 200), 28); // floor for long sub-cent prices
  assert.equal(fitWatermarkPx(200, 600, 60), 33); // also capped by 55% of pane height
  assert.equal(fitWatermarkPx(0, 300, 200), 28);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(`Failures:\n - ${failures.join("\n - ")}`);
  process.exit(1);
}
