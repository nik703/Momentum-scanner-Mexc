/**
 * Pure viewport math for MicroChart: zoom window, right-edge follow and pan offsets.
 *
 * Terms:
 *  - visibleBars: candle slots across the plot (zoom level). Ranges from MIN_BARS to the buffer capacity.
 *  - rightOffset: how many bars the view is panned back from the newest candle. 0 = follow mode.
 *  - anchorT: while panned, the view is pinned to the open time of its rightmost candle. That way
 *    new live bars (or the 1S buffer dropping old seconds) don't drag historical inspection along.
 *    null = follow the newest bar.
 */

export const MIN_BARS = 10;
export const DEFAULT_BARS = 36;
/** Gap between the newest candle's slot and the Y-axis price scale (CSS px). */
export const RIGHT_MARGIN_PX = 8;
export const BODY_RATIO = 0.68;

/** Buffer capacity per timeframe: 1M = 60 bars (1h), 10S = 90 (15m), 1S = 180 (3m). */
export function capacityFor(timeframe: "1M" | "10S" | "1S"): number {
  return timeframe === "1S" ? 180 : timeframe === "10S" ? 90 : 60;
}

export function clampBars(bars: number, capacity: number): number {
  if (!Number.isFinite(bars)) return Math.min(DEFAULT_BARS, capacity);
  return Math.min(capacity, Math.max(MIN_BARS, Math.round(bars)));
}

/** Multiplies the bar count (factor < 1 zooms in) and always moves at least one bar per step. */
export function zoomBars(current: number, factor: number, capacity: number): number {
  const target = current * factor;
  const stepped = factor < 1 ? Math.min(current - 1, Math.floor(target)) : Math.max(current + 1, Math.ceil(target));
  return clampBars(stepped, capacity);
}

export function maxOffset(n: number, visibleBars: number): number {
  return Math.max(0, n - visibleBars);
}

/** Bars panned back from the newest candle for a given anchor, clamped to the available history. */
export function resolveOffset(times: readonly number[], anchorT: number | null, visibleBars: number): number {
  const n = times.length;
  if (anchorT === null || n === 0) return 0;
  // Index of the last candle whose open time is <= anchorT.
  let idx = -1;
  for (let i = n - 1; i >= 0; i--) {
    if (times[i] <= anchorT) {
      idx = i;
      break;
    }
  }
  if (idx < 0) idx = 0;
  return Math.min(maxOffset(n, visibleBars), Math.max(0, n - 1 - idx));
}

/** Anchor for a requested offset (null = follow live). */
export function anchorFor(times: readonly number[], offset: number, visibleBars: number): number | null {
  const n = times.length;
  const o = Math.min(maxOffset(n, visibleBars), Math.max(0, Math.round(offset)));
  return o === 0 || n === 0 ? null : times[n - 1 - o];
}

export interface Viewport {
  /** Exclusive end index of the visible slice ([start, end)). */
  end: number;
  start: number;
  slotW: number;
  bodyW: number;
  /** X of the right edge of the candle plot (where the RIGHT_MARGIN_PX gap starts). */
  plotRight: number;
}

/**
 * Viewport geometry: slotW = plotWidth / visibleBars, bodyW = max(2, floor(slotW × 0.68)).
 * The newest visible candle sits in the rightmost slot, flush against plotRight.
 */
export function computeViewport(n: number, visibleBars: number, rightOffset: number, plotWidth: number): Viewport {
  const end = Math.max(0, n - rightOffset);
  const start = Math.max(0, end - visibleBars);
  const slotW = plotWidth / Math.max(1, visibleBars);
  return { end, start, slotW, bodyW: Math.max(2, Math.floor(slotW * BODY_RATIO)), plotRight: plotWidth };
}

/** Center X of candle `i` (only meaningful for start <= i < end). */
export function candleX(vp: Viewport, i: number): number {
  return vp.plotRight - (vp.end - 1 - i + 0.5) * vp.slotW;
}

/** Candle index under plot X, or -1. */
export function indexAtX(vp: Viewport, x: number): number {
  if (x < 0 || x > vp.plotRight) return -1;
  const i = vp.end - 1 - Math.floor((vp.plotRight - x) / vp.slotW);
  return i >= vp.start && i < vp.end ? i : -1;
}

/**
 * Background-price font size (CSS px) so the text spans ~60% of the plot width. `widthAt100` is
 * ctx.measureText(text).width at 100px. The result is clamped to [28, 68] and to 55% of the
 * pane height.
 */
export function fitWatermarkPx(widthAt100: number, plotWidth: number, paneHeight: number): number {
  if (!(widthAt100 > 0) || !(plotWidth > 0)) return 28;
  const byWidth = (0.6 * plotWidth * 100) / widthAt100;
  return Math.min(68, Math.max(28, Math.min(byWidth, paneHeight * 0.55)));
}
