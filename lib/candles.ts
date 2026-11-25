import type { Candle, ContractKline } from "./types.ts";

export const MIN1_MS = 60_000;
export const MIN1_KEEP = 60;
export const SEC1_KEEP = 180; // 3 minutes

export function fromContractKline(k: ContractKline): Candle {
  return { t: k.timestamp, o: k.open, h: k.high, l: k.low, c: k.close, v: k.vol, a: k.amount };
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/* ------------------------------------------------------------------ */
/* MEXC push frames                                                    */
/* ------------------------------------------------------------------ */

/**
 * push.kline data: {"symbol","interval":"Min1","t":<sec>,"o","c","h","l","a":<USDT>,"q":<contracts>}.
 * The spec names the volume field `v`. MEXC actually sends `q`, so both are accepted.
 */
export function parseKlinePush(data: unknown): Candle | null {
  if (!isObj(data)) return null;
  const t = n(data.t);
  const o = n(data.o);
  const h = n(data.h);
  const l = n(data.l);
  const c = n(data.c);
  if (t === null || o === null || h === null || l === null || c === null || o <= 0 || c <= 0) return null;
  return { t: t < 1e12 ? t * 1000 : t, o, h, l, c, v: n(data.q) ?? n(data.v) ?? 0, a: n(data.a) ?? 0 };
}

export interface Trade {
  p: number;
  /** Quantity in contracts. */
  v: number;
  /** 1 = taker buy, 2 = taker sell. */
  T: number;
  /** Open-interest intent: 1 = open, 2 = close, 3 = both/neutral (default when omitted). */
  O: number;
  /** Trade time, epoch ms. */
  t: number;
  /** MEXC trade id, when known (used for dedupe). */
  id?: string;
}

/** push.deal data: {"p":60417.5,"v":1,"T":2,"O":1,"M":2,"t":1795296368642}. MEXC may also batch it as an array. */
export function parseDealPush(data: unknown): Trade[] {
  const rows = Array.isArray(data) ? data : [data];
  const out: Trade[] = [];
  for (const d of rows) {
    if (!isObj(d)) continue;
    const p = n(d.p);
    const v = n(d.v);
    const t = n(d.t);
    if (p === null || v === null || t === null || p <= 0 || v < 0) continue;
    const id = typeof d.i === "string" || typeof d.i === "number" ? String(d.i) : undefined;
    const o = n(d.O);
    out.push({ p, v, T: n(d.T) ?? 0, O: o === 1 || o === 2 || o === 3 ? o : 3, t, id });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Min1 series                                                         */
/* ------------------------------------------------------------------ */

/** Merges a live Min1 candle into the series in place: replaces the same minute or appends a newer one. */
export function mergeMin1(series: Candle[], c: Candle): void {
  const last = series[series.length - 1];
  if (!last || c.t > last.t) {
    series.push(c);
    if (series.length > MIN1_KEEP) series.splice(0, series.length - MIN1_KEEP);
  } else if (c.t === last.t) {
    series[series.length - 1] = c;
  } else {
    const i = series.findIndex((x) => x.t === c.t);
    if (i >= 0) series[i] = c; // late correction of a closed minute
  }
}

/* ------------------------------------------------------------------ */
/* Sub-minute candles built from trades (10S and 1S)                   */
/* ------------------------------------------------------------------ */

export const SEC10_MS = 10_000;
export const SEC10_KEEP = 90; // 15 minutes
export const SEC1_MS = 1_000;

/** Bucket start for a trade time: Math.floor(ts / bucketMs) * bucketMs. */
export const bucketStart = (ts: number, bucketMs: number): number => Math.floor(ts / bucketMs) * bucketMs;

/**
 * Buckets raw trades into fixed-width OHLCV candles (10S: 10_000ms × 90 bars, 1S: 1_000ms × 180
 * bars). Quiet buckets become flat candles (o=h=l=c=previous close, v=0), so the time axis stays
 * linear and the chart keeps moving when no one trades.
 */
export class TradeCandleBuilder {
  private candles: Candle[] = [];
  private lastClose: number | null = null;

  constructor(
    readonly bucketMs: number,
    readonly keep: number,
    /** Base units per contract, so v × p × contractSize is USDT turnover. Null means turnover is unknown. */
    private contractSize: number | null,
  ) {}

  /** Seeds the last price (e.g. from the latest Min1 close) so flat buckets can start before the first trade. */
  seed(price: number): void {
    if (this.lastClose === null && price > 0) this.lastClose = price;
  }

  get series(): readonly Candle[] {
    return this.candles;
  }

  addTrade(tr: Trade): void {
    const b = bucketStart(tr.t, this.bucketMs);
    const turnover = this.contractSize ? tr.p * tr.v * this.contractSize : 0;
    const last = this.candles[this.candles.length - 1];

    if (last && b < last.t) {
      // Late trade: update its bucket if it is still inside the window.
      const c = this.candles.find((x) => x.t === b);
      if (c) {
        if (c.v === 0) c.o = c.h = c.l = c.c = tr.p;
        c.h = Math.max(c.h, tr.p);
        c.l = Math.min(c.l, tr.p);
        c.v += tr.v;
        c.a += turnover;
      }
      return;
    }
    this.advance(b);
    const cur = this.candles[this.candles.length - 1];
    if (cur && cur.t === b) {
      if (cur.v === 0) cur.o = cur.h = cur.l = tr.p; // first real trade of a padded bucket sets the open
      cur.h = Math.max(cur.h, tr.p);
      cur.l = Math.min(cur.l, tr.p);
      cur.c = tr.p;
      cur.v += tr.v;
      cur.a += turnover;
    } else {
      this.candles.push({ t: b, o: tr.p, h: tr.p, l: tr.p, c: tr.p, v: tr.v, a: turnover });
    }
    this.lastClose = tr.p;
    this.trim();
  }

  /** Pads flat candles up to and including the bucket containing `now`. Returns whether anything changed. */
  advance(now: number): boolean {
    if (this.lastClose === null) return false;
    const target = bucketStart(now, this.bucketMs);
    const last = this.candles[this.candles.length - 1];
    let t = last ? last.t + this.bucketMs : target;
    if (last && target - last.t > this.keep * this.bucketMs) t = target - (this.keep - 1) * this.bucketMs; // long gap: skip ahead
    let changed = false;
    for (; t <= target; t += this.bucketMs) {
      const p = this.lastClose;
      this.candles.push({ t, o: p, h: p, l: p, c: p, v: 0, a: 0 });
      changed = true;
    }
    if (changed) this.trim();
    return changed;
  }

  private trim() {
    if (this.candles.length > this.keep) this.candles.splice(0, this.candles.length - this.keep);
  }
}

/* ------------------------------------------------------------------ */
/* Display pipeline: raw vs Smooth (gap-free + Heikin-Ashi)            */
/* ------------------------------------------------------------------ */

/**
 * Candles to DRAW (pricing, the live price line and the crosshair always use the raw candles).
 *
 *  smooth = false: the raw trade OHLC, unchanged.
 *  smooth = true:
 *    1. Gap-free anchoring: for i > 0, anchoredOpen = raw[i-1].close and the high/low are widened
 *       to include it, so consecutive candles connect instead of jumping in mid-air.
 *    2. Heikin-Ashi: haClose = (aO + aH + aL + close) / 4, haOpen = (prevHaOpen + prevHaClose) / 2
 *       (seeded with (aO + close) / 2), haHigh = max(aH, haOpen, haClose), haLow = min(aL, haOpen, haClose).
 *  Time, volume and turnover always pass through untouched. Non-finite input is never propagated.
 */
export function buildDisplayCandles(raw: readonly Candle[], smooth: boolean): Candle[] {
  if (!smooth) return raw.slice();
  const out: Candle[] = new Array(raw.length);
  let prevHaOpen = 0;
  let prevHaClose = 0;
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i];
    const prevClose = i > 0 ? raw[i - 1].c : r.o;
    const aO = Number.isFinite(prevClose) && prevClose > 0 ? prevClose : r.o;
    const aH = Math.max(r.h, aO);
    const aL = Math.min(r.l, aO);
    const haClose = (aO + aH + aL + r.c) / 4;
    const haOpen = i === 0 ? (aO + r.c) / 2 : (prevHaOpen + prevHaClose) / 2;
    const c: Candle = {
      t: r.t,
      o: haOpen,
      h: Math.max(aH, haOpen, haClose),
      l: Math.min(aL, haOpen, haClose),
      c: haClose,
      v: r.v,
      a: r.a,
    };
    if (![c.o, c.h, c.l, c.c].every(Number.isFinite)) {
      // Defensive: fall back to the raw bar instead of propagating NaN into every later candle.
      out[i] = { ...r };
      prevHaOpen = r.o;
      prevHaClose = r.c;
      continue;
    }
    out[i] = c;
    prevHaOpen = haOpen;
    prevHaClose = haClose;
  }
  return out;
}
