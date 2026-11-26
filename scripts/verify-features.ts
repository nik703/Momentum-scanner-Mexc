/**
 * Engine and parser verification: `npm run verify` (runs `tsx scripts/verify-features.ts`).
 * Checks the bias engine, the cross-exchange liquidation parsers, symbol normalization
 * and 1S candle bucketing against realistic payloads. Exits non-zero on any failure.
 * Not imported by the app, so it never ends up in the client bundle.
 */
import assert from "node:assert/strict";
import { LeaderboardAlertEngine } from "../lib/alerts.ts";
import { nextPingSlot, volumeGain } from "../lib/audio.ts";
import { applyVolSort, nextVolSort } from "../lib/volSort.ts";
import { LiqRollup } from "../lib/liquidations.ts";
import { safeJsonParse } from "../lib/sanitize.ts";
import { isContractSymbol } from "../lib/symbol.ts";
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
import { calculateBiasScore, classifyRegime, type BiasDeal, type BiasResult } from "../lib/biasScore.ts";
import { biasSegments } from "../components/DirectionalBiasBar.tsx";
import {
  buildDisplayCandles,
  mergeMin1,
  parseDealPush,
  parseKlinePush,
  SEC1_KEEP,
  SEC1_MS,
  SEC10_KEEP,
  SEC10_MS,
  TradeCandleBuilder,
} from "../lib/candles.ts";
import { normalizeDeals } from "../lib/mexc.ts";
import { bucketLiquidations, liqBarLayout, TF_BUCKET_MS } from "../lib/liqBuckets.ts";
import { binanceStreams, binanceUrl, bybitTopic, okxInstIds } from "../lib/liquidationFeed.ts";
import { diffChannels, focusChannels, tickersChannels } from "../lib/mexcSocket.ts";
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
  for (const [k, v] of [...Object.entries(r), ...Object.entries(r.breakdown)]) {
    if (typeof v === "number") assert.ok(Number.isFinite(v), `${k} is not finite: ${v}`);
  }
};

/* ------------------------------------------------------------------ */
/* Synthetic Min1 series                                               */
/* ------------------------------------------------------------------ */
const T0 = Date.UTC(2026, 10, 21, 12, 0);

console.log("\n[1] calculateBiasScore: 4-factor orderflow model");

const CS = 0.0001;
const NOW = T0 + 60 * 60_000 - 1;
/** 60 Min1 candles (45 quiet, then 15 trending) with turnover consistent with contract size CS. */
function market(o: { drift: number; baseUsd: number; recentUsd: number; closeLoc?: number }): Candle[] {
  const out: Candle[] = [];
  let p = 60_000;
  for (let i = 0; i < 60; i++) {
    const recent = i >= 45;
    const open = p;
    const close = recent ? p * (1 + o.drift) : p * (1 + (i % 2 ? 0.0003 : -0.0003));
    const wick = Math.max(Math.abs(close - open) * 0.4, p * 0.0002);
    const hi = Math.max(open, close) + (recent && o.drift > 0 ? wick * (1 - (o.closeLoc ?? 0.8)) : wick);
    const lo = Math.min(open, close) - (recent && o.drift < 0 ? wick * (1 - (o.closeLoc ?? 0.8)) : wick);
    const a = recent ? o.recentUsd : o.baseUsd;
    out.push({ t: T0 + i * 60_000, o: open, h: hi, l: lo, c: close, v: a / (close * CS), a });
    p = close;
  }
  return out;
}
function tape(candles: Candle[], minutes: number, buyShare: number, openFlag: number, usdPerMin: number): BiasDeal[] {
  const deals: BiasDeal[] = [];
  for (const c of candles.slice(-minutes)) {
    for (let k = 0; k < 20; k++) {
      deals.push({ price: c.c, vol: usdPerMin / 20 / (c.c * CS), side: k < Math.round(20 * buyShare) ? 1 : 2, openFlag, timestampMs: c.t + k * 2_900 });
    }
  }
  return deals;
}
const noLiq = { shortLiqUsd15m: 0, longLiqUsd15m: 0, liqVwap15m: 0 };

check("strong bullish trend: net > +30, BULL TREND, contract size derived from candles", () => {
  const c = market({ drift: 0.002, baseUsd: 4e6, recentUsd: 8e6, closeLoc: 0.9 });
  const r = calculateBiasScore({ candles: c, deals: tape(c, 15, 0.9, 1, 8e6), latestPrice: c[59].c, amount24: 1e9, shortLiqUsd15m: 300_000, longLiqUsd15m: 0, liqVwap15m: c[52].c, now: NOW });
  finiteResult(r);
  assert.ok(r.netScore > 30, `net ${r.netScore}`);
  assert.equal(r.regime, "BULL TREND");
  assert.ok(Math.abs(r.breakdown.contractSize - CS) / CS < 1e-9);
});

check("bear absorption divergence: price > +8, CVD < -8, BEAR DIVERGENCE (net stays small)", () => {
  const c = market({ drift: 0.0012, baseUsd: 4e6, recentUsd: 5e6, closeLoc: 0.85 });
  const r = calculateBiasScore({ candles: c, deals: tape(c, 15, 0.2, 1, 5e6), latestPrice: c[59].c, amount24: 1e9, ...noLiq, now: NOW });
  finiteResult(r);
  assert.ok(r.priceScore > 8 && r.cvdScore < -8, JSON.stringify(r));
  assert.equal(r.regime, "BEAR DIVERGENCE");
  assert.ok(Math.abs(r.netScore) < 10, "opposing forces cancel in the net, which is why the gauge shows them separately");
});

check("long flush + reclaim above liq VWAP damps liqScore x0.2 (and the squeeze mirror)", () => {
  const c = market({ drift: -0.0004, baseUsd: 4e6, recentUsd: 4e6 });
  const base = { candles: c, deals: tape(c, 15, 0.5, 3, 4e6), amount24: 1e8, shortLiqUsd15m: 0, longLiqUsd15m: 400_000, now: NOW };
  const below = calculateBiasScore({ ...base, latestPrice: c[59].c, liqVwap15m: c[59].c * 1.002 });
  const reclaim = calculateBiasScore({ ...base, latestPrice: c[59].c * 1.004, liqVwap15m: c[59].c * 1.002 });
  assert.equal(below.liqScore, -15);
  assert.equal(below.regime, "LONG CASCADE");
  assert.equal(reclaim.liqScore, -3);
  assert.ok(reclaim.breakdown.liqDamped);
  const rej = calculateBiasScore({ ...base, shortLiqUsd15m: 400_000, longLiqUsd15m: 0, latestPrice: c[59].c, liqVwap15m: c[59].c * 1.01 });
  assert.equal(rej.liqScore, 3);
});

check("liquidity floor: $25k of liqs on a $1B/24h contract is damped by the $500k floor", () => {
  const c = market({ drift: 0, baseUsd: 1e6, recentUsd: 1e6 });
  const r = calculateBiasScore({ candles: c, deals: [], latestPrice: c[59].c, amount24: 1e9, shortLiqUsd15m: 25_000, longLiqUsd15m: 0, liqVwap15m: 0, now: NOW });
  assert.equal(r.breakdown.scaleFloor, 500_000);
  assert.equal(r.liqScore, 0.8); // 15 × 25k / 500k = 0.75 -> 0.8
});

check("cold start: deals cover only 2 min -> the 13 earlier minutes are backfilled from candles", () => {
  const c = market({ drift: 0.0015, baseUsd: 4e6, recentUsd: 6e6, closeLoc: 0.9 });
  const r = calculateBiasScore({ candles: c, deals: tape(c, 2, 0.9, 1, 6e6), latestPrice: c[59].c, amount24: 1e9, ...noLiq, now: NOW });
  assert.equal(r.breakdown.backfilledCandles, 13);
  assert.ok(Math.abs(r.breakdown.total15mUsd - 15 * 6e6) / (15 * 6e6) < 1e-9, "15 minutes of turnover covered");
  assert.ok(r.cvdScore > 10, `backfilled up-closes are bullish, got ${r.cvdScore}`);
});

check("OI intent: opening buys outweigh closing buys", () => {
  const c = market({ drift: 0, baseUsd: 4e6, recentUsd: 4e6 });
  const opens = calculateBiasScore({ candles: c, deals: tape(c, 15, 0.6, 1, 4e6), latestPrice: c[59].c, amount24: 1e9, ...noLiq, now: NOW });
  const closes = calculateBiasScore({ candles: c, deals: tape(c, 15, 0.6, 2, 4e6), latestPrice: c[59].c, amount24: 1e9, ...noLiq, now: NOW });
  assert.ok(opens.cvdScore > closes.cvdScore && closes.cvdScore > 0, `${opens.cvdScore} vs ${closes.cvdScore}`);
});

check("zero volume / no deals / fully empty: 0.0 CHOP, no NaN or Infinity (zero-volume VWAP + flat-CLV guards)", () => {
  const flat: Candle[] = Array.from({ length: 60 }, (_, i) => ({ t: T0 + i * 60_000, o: 5, h: 5, l: 5, c: 5, v: 0, a: 0 }));
  const r = calculateBiasScore({ candles: flat, deals: [], latestPrice: 5, amount24: 0, ...noLiq, now: NOW });
  finiteResult(r);
  assert.deepEqual([r.netScore, r.cvdScore, r.priceScore, r.liqScore, r.regime], [0, 0, 0, 0, "CHOP"]);
  assert.ok(!Object.is(r.netScore, -0));
  const e = calculateBiasScore({ candles: [], deals: [], latestPrice: 0, amount24: 0, ...noLiq });
  finiteResult(e);
  assert.deepEqual([e.netScore, e.regime], [0, "CHOP"]);
  const g = calculateBiasScore({
    candles: [{ t: T0, o: Number.NaN, h: 1, l: 1, c: 1, v: 1, a: 1 }], deals: [{ price: Number.NaN, vol: 1, side: 1, openFlag: 1, timestampMs: T0 }],
    latestPrice: Number.POSITIVE_INFINITY, amount24: Number.NaN, shortLiqUsd15m: Number.NaN, longLiqUsd15m: Number.POSITIVE_INFINITY, liqVwap15m: Number.NaN,
  });
  finiteResult(g);
});

check("regime priority order", () => {
  assert.equal(classifyRegime(30, 10, 6, 12), "SHORT SQUEEZE");
  assert.equal(classifyRegime(-30, -10, -6, -12), "LONG CASCADE");
  assert.equal(classifyRegime(2, -8, 8, 2), "BEAR DIVERGENCE");
  assert.equal(classifyRegime(-2, 8, -8, 2), "BULL DIVERGENCE");
  assert.equal(classifyRegime(12, 1, 1, 10), "BULL TREND");
  assert.equal(classifyRegime(-12, -1, -1, -10), "BEAR TREND");
  assert.equal(classifyRegime(11.9, 6, 5.9, 0), "CHOP");
});

check("net = rounded sum of rounded components, clamped to ±50", () => {
  const c = market({ drift: 0.0007, baseUsd: 3e6, recentUsd: 3.5e6 });
  const r = calculateBiasScore({ candles: c, deals: tape(c, 15, 0.55, 3, 3.5e6), latestPrice: c[59].c, amount24: 5e8, shortLiqUsd15m: 2e4, longLiqUsd15m: 9e4, liqVwap15m: c[50].c, now: NOW });
  assert.equal(r.netScore, Number((r.cvdScore + r.priceScore + r.liqScore).toFixed(1)));
});

check("gauge segments: positives stack right, negatives left, in CVD -> VWAP -> LIQ order", () => {
  const { pos, neg } = biasSegments(14.8, -8.6, 5);
  assert.deepEqual(pos.map((x) => [x.factor, x.offset, x.width]), [["cvd", 0, 14.8], ["liq", 14.8, 5]]);
  assert.deepEqual(neg.map((x) => [x.factor, x.offset, x.width]), [["price", 0, 8.6]]);
  const full = biasSegments(20, 15, 15);
  assert.equal(full.pos.reduce((s, x) => s + x.width, 0), 50);
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
  const b = new TradeCandleBuilder(SEC1_MS, SEC1_KEEP, 0.0001);
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
  b.advance(base + 400_000);
  assert.equal(b.series.length, 180); // retains last 180s (3 minutes)
});

check("10S buckets: trades across several 10-second boundaries -> exact OHLCV", () => {
  const b = new TradeCandleBuilder(SEC10_MS, SEC10_KEEP, 0.1);
  const t0 = 1_795_350_000_000; // a 10s boundary
  const trades = [
    { p: 70.0, v: 10, T: 1, O: 3, t: t0 + 1_200 },
    { p: 70.4, v: 5, T: 1, O: 3, t: t0 + 4_000 },
    { p: 69.9, v: 2, T: 2, O: 3, t: t0 + 9_999 }, // last ms of bucket 0
    { p: 70.1, v: 3, T: 1, O: 3, t: t0 + 10_000 }, // first ms of bucket 1
    { p: 70.6, v: 1, T: 1, O: 3, t: t0 + 35_500 }, // bucket 3 (bucket 2 is quiet)
    { p: 70.2, v: 4, T: 2, O: 3, t: t0 + 39_000 },
  ];
  for (const tr of trades) b.addTrade(tr);
  const s = b.series;
  assert.deepEqual(s.map((c) => c.t - t0), [0, 10_000, 20_000, 30_000]);
  assert.deepEqual([s[0].o, s[0].h, s[0].l, s[0].c, s[0].v], [70.0, 70.4, 69.9, 69.9, 17]);
  assert.ok(Math.abs(s[0].a - (70 * 10 + 70.4 * 5 + 69.9 * 2) * 0.1) < 1e-9);
  assert.deepEqual([s[1].o, s[1].c, s[1].v], [70.1, 70.1, 3]);
  assert.deepEqual([s[2].o, s[2].h, s[2].l, s[2].c, s[2].v], [70.1, 70.1, 70.1, 70.1, 0], "quiet bucket = flat at prior close");
  assert.deepEqual([s[3].o, s[3].h, s[3].l, s[3].c, s[3].v], [70.6, 70.6, 70.2, 70.2, 5]);
  // the same trades bucketed at 1S land on 1-second boundaries
  const one = new TradeCandleBuilder(SEC1_MS, SEC1_KEEP, 0.1);
  for (const tr of trades) one.addTrade(tr);
  assert.ok(one.series.every((c) => c.t % 1000 === 0));
  assert.equal(one.series.filter((c) => c.v > 0).length, 6);
  // retention: 90 bars (15 min)
  b.advance(t0 + 60 * 60_000);
  assert.equal(b.series.length, 90);
});

check("normalizeDeals: newest-first REST -> oldest-first, sides mapped, junk dropped", () => {
  const T0 = Date.UTC(2026, 0, 1);
  const out = normalizeDeals([
    { p: 2, v: 1, T: 2, O: 1, t: T0 + 2000, i: "b" },
    { p: "x", v: 1, T: 1, t: T0 + 1500 },
    { p: 1, v: 3, T: 1, t: 1000, i: "epoch-1970" }, // absurd timestamp: dropped
    { p: 1, v: 3, T: 1, t: T0 + 1000, i: 7 },
  ]);
  assert.deepEqual(out, [
    { id: "7", price: 1, vol: 3, side: 1, openFlag: 3, timestampMs: T0 + 1000 },
    { id: "b", price: 2, vol: 1, side: 2, openFlag: 1, timestampMs: T0 + 2000 },
  ]);
  assert.deepEqual(normalizeDeals(null), []);
});

check("Smooth: gap-free anchoring removes open-to-previous-close jumps", () => {
  const raw = [
    { t: 0, o: 100, h: 101, l: 99.5, c: 100.8, v: 3, a: 1 },
    { t: 1, o: 102.0, h: 102.4, l: 101.9, c: 102.2, v: 1, a: 1 }, // gapped up 1.2 above prev close
    { t: 2, o: 99.0, h: 99.2, l: 98.7, c: 98.9, v: 2, a: 1 }, // gapped down
    { t: 3, o: 98.9, h: 98.9, l: 98.9, c: 98.9, v: 1, a: 1 }, // single-trade doji
  ];
  const sm = buildDisplayCandles(raw, true);
  // stage 1: every anchored range includes the previous close, so no bar floats
  for (let i = 1; i < raw.length; i++) {
    assert.ok(sm[i].l <= raw[i - 1].c && sm[i].h >= raw[i - 1].c, `bar ${i} connects to previous close`);
  }
  // stage 2: Heikin-Ashi opens chain off the previous HA body midpoint
  for (let i = 1; i < sm.length; i++) {
    assert.ok(Math.abs(sm[i].o - (sm[i - 1].o + sm[i - 1].c) / 2) < 1e-12);
    assert.ok(sm[i].h >= Math.max(sm[i].o, sm[i].c) && sm[i].l <= Math.min(sm[i].o, sm[i].c));
  }
  // haClose formula on bar 1: (aO + aH + aL + close) / 4 with aO = 100.8
  assert.ok(Math.abs(sm[1].c - (100.8 + 102.4 + 100.8 + 102.2) / 4) < 1e-12);
  // time / volume / turnover untouched; raw mode is an exact copy
  assert.deepEqual(sm.map((c) => [c.t, c.v, c.a]), raw.map((c) => [c.t, c.v, c.a]));
  assert.deepEqual(buildDisplayCandles(raw, false), raw);
});

check("Smooth: identical-price ticks / empty / garbage stay finite (no NaN)", () => {
  const flat = Array.from({ length: 50 }, (_, i) => ({ t: i, o: 0.0000034, h: 0.0000034, l: 0.0000034, c: 0.0000034, v: i % 3, a: 0 }));
  const sm = buildDisplayCandles(flat, true);
  assert.ok(sm.every((c) => [c.o, c.h, c.l, c.c].every(Number.isFinite)));
  assert.ok(sm.every((c) => c.o === 0.0000034 && c.c === 0.0000034), "flat stays exactly flat");
  assert.deepEqual(buildDisplayCandles([], true), []);
  const bad = buildDisplayCandles(
    [
      { t: 0, o: 1, h: 1, l: 1, c: 1, v: 1, a: 0 },
      { t: 1, o: Number.NaN, h: 2, l: 1, c: 1.5, v: 1, a: 0 },
      { t: 2, o: 1.5, h: 1.6, l: 1.4, c: 1.55, v: 1, a: 0 },
    ],
    true,
  );
  assert.ok(bad.slice(2).every((c) => [c.o, c.h, c.l, c.c].every(Number.isFinite)), "NaN does not propagate");
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

/* ------------------------------------------------------------------ */
console.log("\n[7] Single-coin focus: multiplexer + per-coin streams");

const methods = (frames: string[]) => frames.map((f) => {
  const j = JSON.parse(f) as { method: string; param: { symbol?: string; compress?: boolean; reduce?: boolean } };
  return `${j.method}${j.param.symbol ? `:${j.param.symbol}` : ""}`;
});

check("open drawer: unsub.tickers is sent BEFORE sub.ticker/kline/deal", () => {
  assert.deepEqual(methods(diffChannels(tickersChannels(), focusChannels("BTC_USDT"))), [
    "unsub.tickers",
    "sub.ticker:BTC_USDT",
    "sub.kline:BTC_USDT",
    "sub.deal:BTC_USDT",
  ]);
  const deal = JSON.parse(focusChannels("BTC_USDT")[2].sub) as { param: { compress: boolean; reduce: boolean } };
  assert.deepEqual([deal.param.compress, deal.param.reduce], [false, false]);
});

check("switch coin: unsub prev x3 BEFORE sub next x3", () => {
  assert.deepEqual(methods(diffChannels(focusChannels("BTC_USDT"), focusChannels("ETH_USDT"))), [
    "unsub.ticker:BTC_USDT",
    "unsub.kline:BTC_USDT",
    "unsub.deal:BTC_USDT",
    "sub.ticker:ETH_USDT",
    "sub.kline:ETH_USDT",
    "sub.deal:ETH_USDT",
  ]);
});

check("close drawer: unsub symbol x3 then sub.tickers; same mode = no frames", () => {
  assert.deepEqual(methods(diffChannels(focusChannels("ETH_USDT"), tickersChannels())), [
    "unsub.ticker:ETH_USDT",
    "unsub.kline:ETH_USDT",
    "unsub.deal:ETH_USDT",
    "sub.tickers",
  ]);
  assert.deepEqual(diffChannels(tickersChannels(), tickersChannels()), []);
});

check("liquidation streams are per-coin (no market-wide subscriptions)", () => {
  assert.equal(bybitTopic("SOL"), "allLiquidation.SOLUSDT");
  assert.deepEqual(okxInstIds("SOL"), ["SOL-USDT-SWAP", "SOL-USD-SWAP"]);
  assert.ok(binanceStreams("PEPE").includes("1000pepeusdt@forceOrder"));
  assert.ok(!binanceUrl("SOL").includes("!forceOrder@arr"));
  assert.ok(binanceUrl("SOL").startsWith("wss://fstream.binance.com/stream?streams=solusdt@forceOrder/"));
});

check("Binance combined-stream frames are unwrapped", () => {
  const wrapped = { stream: "solusdt@forceOrder", data: { e: "forceOrder", E: 1, o: { s: "SOLUSDT", S: "SELL", q: "2", p: "70", ap: "70", T: 5 } } };
  const [e] = parseBinanceForceOrder(JSON.stringify(wrapped), "SOL");
  assert.equal(e.side, "LONG");
  assert.equal(e.usd, 140);
});

/* ------------------------------------------------------------------ */
console.log("\n[8] Chart liquidation overlay: bucketing + geometry");

const at = (hh: number, mm: number, ss: number) => Date.UTC(2026, 10, 24, hh, mm, ss);
const ev = (id: string, side: "LONG" | "SHORT", usd: number, ts: number): LiqEvent => ({
  id, exchange: "BN", side, instrument: "BTCUSDT", usd, price: 60_000, ts, receivedAt: ts,
});
const liqSample = [
  ev("a", "LONG", 1000, at(13, 56, 12)),
  ev("b", "SHORT", 400, at(13, 56, 48)),
  ev("c", "LONG", 250, at(13, 56, 48) + 700),
  ev("d", "SHORT", 90, at(13, 57, 3)),
  ev("a", "LONG", 1000, at(13, 56, 12)), // duplicate (window ∩ tape) must not double count
];

check("1M: 13:56:12 + 13:56:48 land in the 13:56 bucket, split by side, deduped", () => {
  const m = bucketLiquidations(liqSample, TF_BUCKET_MS["1M"]);
  assert.deepEqual(m.get(at(13, 56, 0)), { longUsd: 1250, shortUsd: 400 });
  assert.deepEqual(m.get(at(13, 57, 0)), { longUsd: 0, shortUsd: 90 });
  assert.equal(m.size, 2);
});

check("10S: separate 13:56:10 / 13:56:40 / 13:57:00 buckets", () => {
  const m = bucketLiquidations(liqSample, TF_BUCKET_MS["10S"]);
  assert.deepEqual(m.get(at(13, 56, 10)), { longUsd: 1000, shortUsd: 0 });
  assert.deepEqual(m.get(at(13, 56, 40)), { longUsd: 250, shortUsd: 400 });
  assert.deepEqual(m.get(at(13, 57, 0)), { longUsd: 0, shortUsd: 90 });
  assert.equal(m.size, 3);
});

check("1S: each second is its own bucket (13:56:48 holds the short; +700ms long is 13:56:48 too)", () => {
  const m = bucketLiquidations(liqSample, TF_BUCKET_MS["1S"]);
  assert.deepEqual(m.get(at(13, 56, 12)), { longUsd: 1000, shortUsd: 0 });
  assert.deepEqual(m.get(at(13, 56, 48)), { longUsd: 250, shortUsd: 400 });
  assert.deepEqual(m.get(at(13, 57, 3)), { longUsd: 0, shortUsd: 90 });
});

check("overlay geometry: single centered thin bar / dual side-by-side bars, 3px min, clamped", () => {
  const one = liqBarLayout({ longUsd: 1000, shortUsd: 0 }, 100, 10, 5_000_000, 40);
  assert.equal(one.length, 1);
  assert.equal(one[0].w, 3); // max(2, floor(10 × 0.32))
  assert.equal(one[0].x + one[0].w / 2, 100); // centered
  assert.equal(one[0].h, 3); // $1000 vs $5M volume -> min 3px
  const two = liqBarLayout({ longUsd: 9e9, shortUsd: 1 }, 50, 20, 1_000, 40);
  assert.deepEqual(two.map((b) => [b.side, b.w]), [["LONG", 5], ["SHORT", 5]]); // floor(20 × 0.26) = 5
  assert.equal(two[1].x - (two[0].x + two[0].w), 1); // 1px gap
  assert.equal((two[0].x + two[1].x + two[1].w) / 2, 50); // pair centered
  assert.equal(two[0].h, 40); // clamped to the volume zone
  assert.deepEqual(liqBarLayout({ longUsd: 0, shortUsd: 0 }, 0, 10, 1, 40), []);
});

/* ------------------------------------------------------------------ */
console.log("\n[9] Vol % sort + volume curve");

check("Vol % header cycles default -> desc -> asc -> default", () => {
  assert.equal(nextVolSort("default"), "vol_desc");
  assert.equal(nextVolSort("vol_desc"), "vol_asc");
  assert.equal(nextVolSort("vol_asc"), "default");
});

check("applyVolSort: desc/asc by volChange, nulls last both ways, ties keep price rank, default untouched", () => {
  const rows = [
    { rank: 1, volChange: 20 },
    { rank: 2, volChange: null },
    { rank: 3, volChange: 250 },
    { rank: 4, volChange: -40 },
    { rank: 5, volChange: 20 },
  ];
  assert.deepEqual(applyVolSort(rows, "vol_desc").map((r) => r.rank), [3, 1, 5, 4, 2]);
  assert.deepEqual(applyVolSort(rows, "vol_asc").map((r) => r.rank), [4, 1, 5, 3, 2]);
  assert.equal(applyVolSort(rows, "default"), rows);
  assert.deepEqual(rows.map((r) => r.rank), [1, 2, 3, 4, 5], "input not mutated");
});

check("volumeGain: 0/invalid = silent, perceptual curve, capped at 1", () => {
  assert.equal(volumeGain(0), 0);
  assert.equal(volumeGain(-5), 0);
  assert.equal(volumeGain(Number.NaN), 0);
  assert.equal(volumeGain(100), 1);
  assert.equal(volumeGain(150), 1);
  assert.equal(volumeGain(50), 0.25);
  assert.ok(volumeGain(42) > volumeGain(41));
});

console.log("\n[10] Security guards (untrusted frames)");
check("strict server symbol: canonical only, no aliases / encodings / traversal", () => {
  for (const ok of ["BTC_USDT", "1000PEPE_USDT", "A_USDT"]) assert.ok(isContractSymbol(ok), ok);
  for (const bad of ["btc_usdt", "BTCUSDT", "BTC%5FUSDT", "../BTC_USDT", "BTC_USDT ", "BTC_USDT&limit=1", `${"A".repeat(21)}_USDT`, "BTC_USD"]) {
    assert.ok(!isContractSymbol(bad), bad);
  }
});
check("safeJsonParse: drops __proto__/constructor/prototype, rejects junk and oversized frames", () => {
  const v = safeJsonParse('{"__proto__":{"p":1},"constructor":{"prototype":{"p":1}},"ok":1}') as Record<string, unknown>;
  assert.deepEqual(Object.keys(v), ["ok"]);
  assert.equal(({} as Record<string, unknown>).p, undefined);
  assert.equal(safeJsonParse("pong"), undefined);
  assert.equal(safeJsonParse('{"a":1}', 3), undefined);
});
check("liquidation parsers: Infinity notional dropped, absurd timestamps re-stamped to receive time", () => {
  const T = Date.now();
  assert.equal(parseBybitLiquidation(`{"topic":"allLiquidation.BTCUSDT","data":[{"T":${T},"s":"BTCUSDT","S":"Buy","v":"1e200","p":"1e200"}]}`, "BTC").length, 0);
  const [e] = parseBinanceForceOrder(`{"e":"forceOrder","E":1,"o":{"s":"BTCUSDT","S":"SELL","q":"1","ap":"60000","T":999999999999999}}`, "BTC");
  assert.ok(e && e.ts === e.receivedAt, "future ts must not be trusted");
});
check("Min1 / trade pushes: far-future or inverted bars rejected (chart can't be frozen)", () => {
  const T = Date.now();
  assert.equal(parseKlinePush({ t: 99999999999, o: 2, h: 3, l: 1, c: 2 }), null);
  assert.equal(parseKlinePush({ t: Math.floor(T / 1000), o: 2, h: -5, l: -9, c: 2 }), null);
  assert.equal(parseDealPush([{ p: 1, v: 1, T: 1, t: 999999999999999 }]).length, 0);
  assert.equal(parseDealPush([{ p: 1, v: 1, T: 1, t: T }]).length, 1);
});
check("LiqRollup: exact totals + VWAP, prunes by window", () => {
  const T = Date.now();
  const r = new LiqRollup();
  const mk = (side: "LONG" | "SHORT", usd: number, price: number, ts: number): LiqEvent =>
    ({ id: String(Math.random()), exchange: "BYB", side, instrument: "BTCUSDT", usd, price, ts, receivedAt: ts });
  r.add(mk("LONG", 100, 10, T - 1000));
  r.add(mk("SHORT", 300, 20, T));
  r.add(mk("LONG", 50, 10, T - 20 * 60_000));
  assert.deepEqual(r.totals(T - 15 * 60_000), { longUsd: 100, shortUsd: 300, count: 2, vwap: (10 * 100 + 20 * 300) / 400 });
  r.prune(T - 15 * 60_000);
  assert.equal(r.size, 2);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(`Failures:\n - ${failures.join("\n - ")}`);
  process.exit(1);
}
