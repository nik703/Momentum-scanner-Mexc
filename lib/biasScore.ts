import type { Candle } from "./types.ts";

export const PRICE_MAX = 20;
export const VOLUME_MAX = 15;
export const LIQ_MAX = 15;
export const SCORE_MAX = 50;
/** Smallest liquidation total used to normalize the imbalance, so small liquidations don't swing the needle. */
export const LIQ_NORMALIZER_FLOOR = 25_000;

const WINDOW = 15; // trailing Min1 candles = 15 minutes
const BASELINE = 45; // preceding Min1 candles = 45 minutes (3 × 15m)
/** Recency decay per candle for the body-direction average (half-life ≈ 3.5 candles). */
const DECAY = 0.2;
/** A 1.5% net 15m move gives tanh(1.5) ≈ 0.9 of the net-change sub-score. */
const NET_MOVE_SCALE_PCT = 1;
/** Neutral band for the headline label. */
const NEUTRAL_BAND = 5;

export type BiasLabel = "BULLISH" | "BEARISH" | "NEUTRAL";

export interface BiasInput {
  /** Min1 candles, oldest first. The last 60 are used. The last candle may still be forming. */
  candles: readonly Candle[];
  /** USD notional of LONG liquidations (forced sells) in the trailing 15 minutes. */
  longLiqUsd15m: number;
  /** USD notional of SHORT liquidations (forced buys) in the trailing 15 minutes. */
  shortLiqUsd15m: number;
}

export interface BiasResult {
  /** -50..+50, one decimal. */
  total: number;
  /** -20..+20 */
  price: number;
  /** -15..+15 */
  volume: number;
  /** -15..+15 */
  liquidation: number;
  label: BiasLabel;
  /** Number of Min1 candles that fed the price and volume components (0..15). */
  sampleSize: number;
}

const fin = (v: number): number => (Number.isFinite(v) ? v : 0);
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, fin(v)));
/** Rounds to one decimal and turns -0 into 0, so a flat result reads "0.0". */
const round1 = (v: number): number => {
  const r = Number(fin(v).toFixed(1));
  return r === 0 ? 0 : r;
};

function validCandle(c: Candle): boolean {
  return (
    Number.isFinite(c.o) && Number.isFinite(c.h) && Number.isFinite(c.l) && Number.isFinite(c.c) &&
    c.o > 0 && c.h > 0 && c.l > 0 && c.c > 0
  );
}

/** 15M price action: net % change, Close Location Value, and recency-weighted body direction. */
export function priceActionScore(win: readonly Candle[]): number {
  if (win.length === 0) return 0;
  const open15 = win[0].o;
  const close = win[win.length - 1].c;
  let hi = -Infinity;
  let lo = Infinity;
  for (const c of win) {
    if (c.h > hi) hi = c.h;
    if (c.l < lo) lo = c.l;
  }

  const netPct = ((close - open15) / open15) * 100;
  const netComponent = Math.tanh(netPct / NET_MOVE_SCALE_PCT);

  // CLV = ((close - low) / max(range, 1e-12)) * 2 - 1. A zero range (perfectly flat market)
  // would give -1 (max bearish) under the raw formula, so it is treated as neutral instead.
  const range = hi - lo;
  const clv = range > 1e-12 ? ((close - lo) / Math.max(range, 1e-12)) * 2 - 1 : 0;

  // Recency-weighted body direction: each candle adds body/range in [-1, 1].
  let wSum = 0;
  let dirSum = 0;
  for (let i = 0; i < win.length; i++) {
    const c = win[i];
    const w = Math.exp(-DECAY * (win.length - 1 - i));
    const r = c.h - c.l;
    const body = r > 0 ? (c.c - c.o) / r : 0;
    dirSum += w * clamp(body, -1, 1);
    wSum += w;
  }
  const bodyDir = wSum > 0 ? dirSum / wSum : 0;

  return clamp(PRICE_MAX * (0.5 * netComponent + 0.25 * clv + 0.25 * bodyDir), -PRICE_MAX, PRICE_MAX);
}

/** 15M volume pressure: directional turnover share × surge factor versus the preceding 45m. */
export function volumePressureScore(win: readonly Candle[], baseline: readonly Candle[]): number {
  let bull = 0;
  let bear = 0;
  let total = 0;
  for (const c of win) {
    const a = Math.max(0, fin(c.a));
    total += a;
    if (c.c > c.o) bull += a;
    else if (c.c < c.o) bear += a;
  }
  if (total <= 0) return 0;
  const directional = (bull - bear) / total; // [-1, 1]

  // Surge factor: trailing 15m turnover / average 15m turnover of the preceding 45m.
  // 1× volume -> factor 1; 2× -> 1.5 (cap); half -> 0.75; no baseline history -> 1.
  let factor = 1;
  if (baseline.length > 0) {
    let baseSum = 0;
    for (const c of baseline) baseSum += Math.max(0, fin(c.a));
    const avg15 = (baseSum / baseline.length) * WINDOW; // per-15m average, robust to partial history
    const ratio = avg15 > 0 ? total / avg15 : 2;
    factor = clamp(0.5 + 0.5 * ratio, 0.5, 1.5);
  }
  return clamp(VOLUME_MAX * directional * factor, -VOLUME_MAX, VOLUME_MAX);
}

/** 15M liquidation imbalance: short liqs (squeeze) are bullish, long liqs (cascade) are bearish. */
export function liquidationScore(longLiqUsd15m: number, shortLiqUsd15m: number): number {
  const longs = Math.max(0, fin(longLiqUsd15m));
  const shorts = Math.max(0, fin(shortLiqUsd15m));
  const net = shorts - longs;
  return clamp((net / Math.max(shorts + longs, LIQ_NORMALIZER_FLOOR)) * LIQ_MAX, -LIQ_MAX, LIQ_MAX);
}

export function biasLabel(total: number): BiasLabel {
  if (total >= NEUTRAL_BAND) return "BULLISH";
  if (total <= -NEUTRAL_BAND) return "BEARISH";
  return "NEUTRAL";
}

/** Deterministic -50..+50 directional bias from 15m of Min1 candles and 15m of liquidations. */
export function calculateBiasScore(input: BiasInput): BiasResult {
  const candles = input.candles.filter(validCandle).slice(-(WINDOW + BASELINE));
  const win = candles.slice(-WINDOW);
  const baseline = candles.slice(0, Math.max(0, candles.length - WINDOW));

  const price = round1(priceActionScore(win));
  const volume = round1(volumePressureScore(win, baseline));
  const liquidation = round1(liquidationScore(input.longLiqUsd15m, input.shortLiqUsd15m));
  const total = round1(clamp(Number((price + volume + liquidation).toFixed(1)), -SCORE_MAX, SCORE_MAX));

  return { total, price, volume, liquidation, label: biasLabel(total), sampleSize: win.length };
}
