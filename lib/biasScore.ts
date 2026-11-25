import type { Candle } from "./types.ts";

/**
 * 15-minute directional flow bias: a deterministic 4-factor orderflow model.
 *
 *   cvdScore   (-20..+20)  taker CVD weighted by open-interest intent, times 15m-vs-60m volume pace
 *   priceScore (-15..+15)  net move, position vs the 15m VWAP and range CLV, normalized by ATR
 *   liqScore   (-15..+15)  cross-exchange liquidation imbalance, floored by 24h liquidity and
 *                          damped when price reclaims or rejects the liquidation VWAP
 *   netScore   (-50..+50)  sum of the three, plus a priority-ordered regime label
 *
 * Pure: the same input always gives the same output (pass `now` for full determinism).
 */

export const CVD_MAX = 20;
export const PRICE_MAX = 15;
export const LIQ_MAX = 15;
export const SCORE_MAX = 50;

const WINDOW_MS = 15 * 60_000;
const MIN1_MS = 60_000;

export type BiasRegime =
  | "SHORT SQUEEZE"
  | "LONG CASCADE"
  | "BEAR DIVERGENCE"
  | "BULL DIVERGENCE"
  | "BULL TREND"
  | "BEAR TREND"
  | "CHOP";

/** One MEXC trade (REST /deals or push.deal) with intent fields preserved. */
export interface BiasDeal {
  price: number;
  /** Contract quantity. */
  vol: number;
  /** 1 = aggressive taker buy, 2 = aggressive taker sell. */
  side: number;
  /** 1 = open, 2 = close, 3 = both/neutral. */
  openFlag: number;
  timestampMs: number;
}

export interface BiasInput {
  /** Min1 candles, oldest first (v = contracts, a = USDT turnover). Up to the last 60 are used. */
  candles: readonly Candle[];
  /** Trades in (or beyond) the trailing 15 minutes. Older ones are ignored. */
  deals: readonly BiasDeal[];
  latestPrice: number;
  /** 24h USDT turnover. Sets the liquidation scale floor. */
  amount24: number;
  shortLiqUsd15m: number;
  longLiqUsd15m: number;
  /** USD-weighted liquidation fill price over the trailing 15m (0 = none). */
  liqVwap15m: number;
  /** Evaluation time (ms). Defaults to the end of the newest candle, or the newest deal if later. */
  now?: number;
}

export interface BiasBreakdown {
  contractSize: number;
  dealsUsed: number;
  backfilledCandles: number;
  weightedNetUsd: number;
  total15mUsd: number;
  baseline15mUsd: number;
  cvdRatio: number;
  pace: number;
  atr15m: number;
  vwap15m: number;
  netZ: number;
  vwapZ: number;
  clv: number;
  scaleFloor: number;
  rawLiq: number;
  liqDamped: boolean;
}

export interface BiasResult {
  netScore: number;
  cvdScore: number;
  priceScore: number;
  liqScore: number;
  regime: BiasRegime;
  breakdown: BiasBreakdown;
}

const fin = (v: number, fb = 0): number => (Number.isFinite(v) ? v : fb);
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, fin(v)));
/** One decimal, with -0 normalized to 0 so a flat result reads "0.0". */
const r1 = (v: number): number => {
  const x = Number(fin(v).toFixed(1));
  return x === 0 ? 0 : x;
};
const validCandle = (c: Candle) =>
  [c.o, c.h, c.l, c.c].every((x) => Number.isFinite(x) && x > 0) && Number.isFinite(c.t) && c.h >= c.l;

/** Contract size from candles: median of amount / (vol × close) over candles with volume; 1 if none. */
export function deriveContractSize(candles: readonly Candle[]): number {
  const est: number[] = [];
  for (const c of candles) {
    if (!(c.v > 0) || !(c.a > 0) || !(c.c > 0)) continue;
    const cs = c.a / (c.v * c.c);
    if (Number.isFinite(cs) && cs > 0) est.push(cs);
  }
  if (!est.length) return 1;
  est.sort((a, b) => a - b);
  const m = est.length >> 1;
  return est.length % 2 ? est[m] : (est[m - 1] + est[m]) / 2;
}

/** Component 1: taker CVD with open-interest intent, cold-start candle backfill and volume pace. */
function cvdComponent(candles: readonly Candle[], deals: readonly BiasDeal[], now: number) {
  const start = now - WINDOW_MS;
  const contractSize = deriveContractSize(candles);
  let weightedNetUsd = 0;
  let dealsTotalUsd = 0;
  let dealsUsed = 0;
  let earliestDealTs = Number.POSITIVE_INFINITY;
  for (const d of deals) {
    if (!(d.timestampMs >= start) || !(d.timestampMs <= now)) continue;
    const notional = d.price * d.vol * contractSize;
    if (!(notional > 0) || !Number.isFinite(notional)) continue;
    const intent = d.openFlag === 1 ? 1.25 : d.openFlag === 2 ? 0.75 : 1.0;
    weightedNetUsd += (d.side === 1 ? 1 : -1) * notional * intent;
    dealsTotalUsd += notional;
    dealsUsed++;
    if (d.timestampMs < earliestDealTs) earliestDealTs = d.timestampMs;
  }

  // Cold start: REST trades may only cover the last 1–3 minutes, so the trailing-15m minutes that
  // ended before the first known trade are estimated from intrabar close-location delta.
  let backfilledCandles = 0;
  let total15mUsd = dealsTotalUsd;
  for (const c of candles) {
    if (c.t < start || c.t + MIN1_MS > earliestDealTs || c.t > now) continue;
    const a = Math.max(0, fin(c.a));
    const range = c.h - c.l;
    weightedNetUsd += range > 1e-12 ? ((c.c - c.o) / range) * a : 0;
    total15mUsd += a;
    backfilledCandles++;
  }

  // Pace: trailing 15m turnover vs the average 15m of the preceding 45m (candles last-59..last-15).
  const prior = candles.filter((c) => c.t >= now - 4 * WINDOW_MS && c.t < start);
  let pace = 1;
  let baseline15mUsd = 0;
  if (prior.length > 0) {
    const sum = prior.reduce((s, c) => s + Math.max(0, fin(c.a)), 0);
    baseline15mUsd = (sum / prior.length) * 15; // per-15m average, robust to partial history
    pace = clamp(total15mUsd / Math.max(baseline15mUsd, 1), 0.65, 1.5);
  }
  // Intent weights (×1.25) can push |net| slightly past the total, so keep the ratio in [-1, 1].
  const cvdRatio = clamp(weightedNetUsd / Math.max(total15mUsd, 1), -1, 1);
  return {
    score: clamp(CVD_MAX * cvdRatio * pace, -CVD_MAX, CVD_MAX),
    contractSize,
    dealsUsed,
    backfilledCandles,
    weightedNetUsd,
    total15mUsd,
    baseline15mUsd,
    cvdRatio,
    pace,
  };
}

/** Component 2: ATR-normalized net move, 15m VWAP position and range CLV through tanh. */
function priceComponent(candles: readonly Candle[], latestPrice: number) {
  const last60 = candles.slice(-60);
  const last15 = candles.slice(-15);
  if (!last15.length || !(latestPrice > 0)) {
    return { score: 0, atr15m: 0, vwap15m: 0, netZ: 0, vwapZ: 0, clv: 0 };
  }
  let trSum = 0;
  for (let i = 0; i < last60.length; i++) {
    const c = last60[i];
    const pc = i > 0 ? last60[i - 1].c : c.c;
    trSum += Math.max(c.h - c.l, Math.abs(c.h - pc), Math.abs(c.l - pc));
  }
  const atr1m = trSum / last60.length;
  const atr15m = Math.max(atr1m * Math.sqrt(15), latestPrice * 0.0005, 1e-12);

  let pv = 0;
  let vol = 0;
  let hi = latestPrice;
  let lo = latestPrice;
  for (const c of last15) {
    const a = Math.max(0, fin(c.a));
    pv += ((c.h + c.l + c.c) / 3) * a;
    vol += a;
    hi = Math.max(hi, c.h);
    lo = Math.min(lo, c.l);
  }
  // With zero turnover the formula's max(Σa, 1) floor would make VWAP 0, so vwapZ = price/ATR
  // (a huge false bullish reading). No volume means no VWAP signal: treat VWAP as the price.
  const vwap15m = vol > 0 ? pv / vol : latestPrice;
  const netZ = (latestPrice - last15[0].o) / atr15m;
  const vwapZ = (latestPrice - vwap15m) / atr15m;
  // A flat range would give CLV = -1 (max bearish) under the raw formula, so it is neutral instead.
  const range = hi - lo;
  const clv = range > 1e-12 ? ((latestPrice - lo) / range) * 2 - 1 : 0;
  const score = clamp(PRICE_MAX * Math.tanh(0.45 * netZ + 0.35 * vwapZ + 0.3 * clv), -PRICE_MAX, PRICE_MAX);
  return { score, atr15m, vwap15m, netZ, vwapZ, clv };
}

/** Component 3: liquidity-scaled liquidation imbalance with reclaim/rejection damping. */
function liqComponent(input: BiasInput) {
  const shorts = Math.max(0, fin(input.shortLiqUsd15m));
  const longs = Math.max(0, fin(input.longLiqUsd15m));
  const scaleFloor = Math.max(5000, Math.max(0, fin(input.amount24)) * 0.0005);
  let rawLiq = LIQ_MAX * ((shorts - longs) / Math.max(shorts + longs, scaleFloor));
  const vwap = fin(input.liqVwap15m);
  const px = fin(input.latestPrice);
  let liqDamped = false;
  // Long flush swept, then price reclaimed above the cluster: a stop-hunt bottom, not a breakdown.
  if (rawLiq < 0 && vwap > 0 && px > vwap) {
    rawLiq *= 0.2;
    liqDamped = true;
  }
  // Short squeeze rejected back below the squeeze level.
  if (rawLiq > 0 && vwap > 0 && px < vwap) {
    rawLiq *= 0.2;
    liqDamped = true;
  }
  return { score: clamp(rawLiq, -LIQ_MAX, LIQ_MAX), scaleFloor, rawLiq: fin(rawLiq), liqDamped };
}

/** Regime, in strict priority order. */
export function classifyRegime(netScore: number, cvdScore: number, priceScore: number, liqScore: number): BiasRegime {
  if (liqScore >= 10 && priceScore >= 5) return "SHORT SQUEEZE";
  if (liqScore <= -10 && priceScore <= -5) return "LONG CASCADE";
  if (priceScore >= 6 && cvdScore <= -6 && priceScore - cvdScore >= 14) return "BEAR DIVERGENCE";
  if (priceScore <= -6 && cvdScore >= 6 && cvdScore - priceScore >= 14) return "BULL DIVERGENCE";
  if (netScore >= 12 && priceScore > 0 && cvdScore > 0) return "BULL TREND";
  if (netScore <= -12 && priceScore < 0 && cvdScore < 0) return "BEAR TREND";
  return "CHOP";
}

export function calculateBiasScore(input: BiasInput): BiasResult {
  const candles = input.candles.filter(validCandle).slice(-60);
  const deals = input.deals.filter(
    (d) => Number.isFinite(d.price) && d.price > 0 && Number.isFinite(d.vol) && d.vol > 0 && Number.isFinite(d.timestampMs),
  );
  const lastCandle = candles[candles.length - 1];
  const lastDealTs = deals.reduce((m, d) => Math.max(m, d.timestampMs), 0);
  const now = fin(input.now ?? Math.max(lastCandle ? lastCandle.t + MIN1_MS - 1 : 0, lastDealTs), 0);
  const latestPrice = fin(input.latestPrice) > 0 ? input.latestPrice : (lastCandle?.c ?? 0);

  const cvd = cvdComponent(candles, deals, now);
  const price = priceComponent(candles, latestPrice);
  const liq = liqComponent({ ...input, latestPrice });

  // Components are rounded first, so the net equals the sum of what the gauge shows.
  const cvdScore = r1(cvd.score);
  const priceScore = r1(price.score);
  const liqScore = r1(liq.score);
  const netScore = r1(clamp(Number((cvdScore + priceScore + liqScore).toFixed(1)), -SCORE_MAX, SCORE_MAX));

  return {
    netScore,
    cvdScore,
    priceScore,
    liqScore,
    regime: classifyRegime(netScore, cvdScore, priceScore, liqScore),
    breakdown: {
      contractSize: cvd.contractSize,
      dealsUsed: cvd.dealsUsed,
      backfilledCandles: cvd.backfilledCandles,
      weightedNetUsd: fin(cvd.weightedNetUsd),
      total15mUsd: fin(cvd.total15mUsd),
      baseline15mUsd: fin(cvd.baseline15mUsd),
      cvdRatio: fin(cvd.cvdRatio),
      pace: fin(cvd.pace, 1),
      atr15m: fin(price.atr15m),
      vwap15m: fin(price.vwap15m),
      netZ: fin(price.netZ),
      vwapZ: fin(price.vwapZ),
      clv: fin(price.clv),
      scaleFloor: liq.scaleFloor,
      rawLiq: liq.rawLiq,
      liqDamped: liq.liqDamped,
    },
  };
}
