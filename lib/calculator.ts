import type { TfMetrics, Timeframe } from "./types.ts";
import { TF_CANDLES } from "./types.ts";

export const CANDLE_MS = 5 * 60 * 1000;
export const MAX_CANDLES = 24;

/** Mutable per-symbol live state kept on the client. */
export interface SymbolState {
  symbol: string;
  price: number;
  amount24: number;
  volume24: number;
  /** Candle open times (ms), opens, closes and *settled* turnover, oldest first. */
  t: number[];
  o: number[];
  c: number[];
  a: number[];
  /** 24h turnover / volume snapshot the live delta is measured from. */
  anchorAmount24: number;
  anchorVolume24: number;
  /** Turnover accrued since the anchor; belongs to the newest (in-progress) candle. */
  liveDelta: number;
}

/**
 * Live turnover delta since the snapshot. amount24 is a rolling 24h number, so a
 * negative difference (old volume dropping out of the window) is clamped to 0.
 */
export function liveDeltaTurnover(
  st: Pick<SymbolState, "anchorAmount24" | "anchorVolume24">,
  ws: { amount24?: number; volume24?: number; lastPrice: number },
): number {
  if (typeof ws.amount24 === "number" && Number.isFinite(ws.amount24)) {
    return Math.max(0, ws.amount24 - st.anchorAmount24);
  }
  if (typeof ws.volume24 === "number" && Number.isFinite(ws.volume24)) {
    return Math.max(0, ws.volume24 - st.anchorVolume24) * ws.lastPrice;
  }
  return 0;
}

/**
 * Rolls the candle buffer forward when wall-clock time has crossed into a new
 * Min5 bucket. The live delta is settled into the closing candle and the anchor
 * is moved to the current 24h figures so new turnover accrues to the new candle.
 * Returns true when the buffer changed.
 */
export function rollCandles(st: SymbolState, now: number): boolean {
  const n = st.t.length;
  if (n === 0) return false;
  const lastOpen = st.t[n - 1];
  if (now < lastOpen + CANDLE_MS) return false;

  st.a[n - 1] += st.liveDelta;
  st.c[n - 1] = st.price;
  st.liveDelta = 0;
  st.anchorAmount24 = st.amount24;
  st.anchorVolume24 = st.volume24;

  const buckets = Math.min(MAX_CANDLES, Math.floor((now - lastOpen) / CANDLE_MS));
  for (let i = 1; i <= buckets; i++) {
    st.t.push(lastOpen + i * CANDLE_MS);
    st.o.push(st.price);
    st.c.push(st.price);
    st.a.push(0);
  }
  const extra = st.t.length - MAX_CANDLES;
  if (extra > 0) {
    st.t.splice(0, extra);
    st.o.splice(0, extra);
    st.c.splice(0, extra);
    st.a.splice(0, extra);
  }
  return true;
}

function sumRange(a: number[], from: number, toExclusive: number): number {
  let s = 0;
  for (let i = from; i < toExclusive; i++) s += a[i];
  return s;
}

/**
 * Timeframe-coupled metrics.
 *  15M: move vs open of candle[last-2]; turnover = last 3 candles;
 *       baseline = avg 15m turnover of the 9 preceding candles (sum / 3).
 *  30M: move vs open of candle[last-5]; turnover = last 6; baseline = prior 6.
 *  1H : move vs open of candle[last-11]; turnover = last 12; baseline = prior 12.
 */
export function computeTf(st: SymbolState, tf: Timeframe): TfMetrics {
  const n = TF_CANDLES[tf];
  const len = st.a.length;
  if (len < n) return { move: null, turnover: 0, volChange: null };

  const start = len - n;
  const open = st.o[start];
  const move = open > 0 ? ((st.price - open) / open) * 100 : null;
  const turnover = sumRange(st.a, start, len) + st.liveDelta;

  const baseCount = tf === "15M" ? 9 : n;
  let volChange: number | null = null;
  if (start - baseCount >= 0) {
    const baseline = (sumRange(st.a, start - baseCount, start) * n) / baseCount;
    volChange = ((turnover - baseline) / Math.max(baseline, 1)) * 100;
  }
  return { move, turnover, volChange };
}
