import type { Candle, ContractKline } from "./types.ts";

export const MIN1_MS = 60_000;
export const MIN1_KEEP = 60;
export const SEC1_KEEP = 120;

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
  /** Trade time, epoch ms. */
  t: number;
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
    out.push({ p, v, T: n(d.T) ?? 0, t });
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
/* 1-second candles built from trades                                  */
/* ------------------------------------------------------------------ */

/**
 * Buckets raw trades into 1-second OHLCV candles and keeps the last 120 seconds.
 * Quiet seconds become flat candles (o=h=l=c=previous close, v=0), so the time axis
 * stays linear and the chart keeps moving even when no one trades.
 */
export class SecondCandleBuilder {
  private candles: Candle[] = [];
  private lastClose: number | null = null;

  constructor(
    /** Base units per contract, so v × p × contractSize is USDT turnover. Null means turnover is unknown. */
    private contractSize: number | null,
    private keep = SEC1_KEEP,
  ) {}

  /** Seeds the last price (e.g. from the latest Min1 close) so flat seconds can start before the first trade. */
  seed(price: number): void {
    if (this.lastClose === null && price > 0) this.lastClose = price;
  }

  get series(): readonly Candle[] {
    return this.candles;
  }

  addTrade(tr: Trade): void {
    const sec = Math.floor(tr.t / 1000) * 1000;
    const turnover = this.contractSize ? tr.p * tr.v * this.contractSize : 0;
    const last = this.candles[this.candles.length - 1];

    if (last && sec < last.t) {
      // Late trade: update its second if it is still inside the window.
      const c = this.candles.find((x) => x.t === sec);
      if (c) {
        c.h = Math.max(c.h, tr.p);
        c.l = Math.min(c.l, tr.p);
        c.v += tr.v;
        c.a += turnover;
      }
      return;
    }
    this.advance(sec);
    const cur = this.candles[this.candles.length - 1];
    if (cur && cur.t === sec) {
      if (cur.v === 0) {
        // First real trade of a padded second: it sets the open.
        cur.o = cur.h = cur.l = tr.p;
      }
      cur.h = Math.max(cur.h, tr.p);
      cur.l = Math.min(cur.l, tr.p);
      cur.c = tr.p;
      cur.v += tr.v;
      cur.a += turnover;
    } else {
      this.candles.push({ t: sec, o: tr.p, h: tr.p, l: tr.p, c: tr.p, v: tr.v, a: turnover });
    }
    this.lastClose = tr.p;
    this.trim();
  }

  /** Pads flat candles up to and including `nowSec` (epoch ms floored to the second). Returns whether anything changed. */
  advance(nowSec: number): boolean {
    if (this.lastClose === null) return false;
    const last = this.candles[this.candles.length - 1];
    let t = last ? last.t + 1000 : nowSec;
    if (last && nowSec - last.t > this.keep * 1000) t = nowSec - (this.keep - 1) * 1000; // long gap: skip ahead
    let changed = false;
    for (; t <= nowSec; t += 1000) {
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
