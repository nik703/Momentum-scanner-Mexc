import type { LiqEvent } from "./liquidations.ts";

/** Candle width per chart timeframe (ms). */
export const TF_BUCKET_MS = { "1M": 60_000, "10S": 10_000, "1S": 1_000 } as const;

export interface LiqBucket {
  longUsd: number;
  shortUsd: number;
}

/**
 * Sums liquidation USD per candle bucket, using the same floor as the candles themselves:
 * bucket = Math.floor(ts / bucketMs) * bucketMs. Events are deduplicated by id (the rolling
 * window and the session tape overlap), and non-finite or non-positive sizes are ignored.
 */
export function bucketLiquidations(events: Iterable<LiqEvent>, bucketMs: number): Map<number, LiqBucket> {
  const out = new Map<number, LiqBucket>();
  const seen = new Set<string>();
  for (const e of events) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    if (!(e.usd > 0) || !Number.isFinite(e.usd) || !Number.isFinite(e.ts)) continue;
    const t = Math.floor(e.ts / bucketMs) * bucketMs;
    let b = out.get(t);
    if (!b) out.set(t, (b = { longUsd: 0, shortUsd: 0 }));
    if (e.side === "LONG") b.longUsd += e.usd;
    else b.shortUsd += e.usd;
  }
  return out;
}

/**
 * Overlay bar geometry inside a candle's volume bar (CSS px).
 * One side: a single centered bar, max(2, floor(volW × 0.32)) wide.
 * Both sides: two bars side by side, each max(2, floor(volW × 0.26)) wide, with a 1px gap, centered.
 * Height: liqUsd / max(maxVolume, 1) × zoneH, at least 3px when liqUsd > 0, capped at zoneH.
 */
export function liqBarLayout(
  b: LiqBucket,
  centerX: number,
  volumeBarWidth: number,
  maxVolume: number,
  zoneH: number,
): Array<{ side: "LONG" | "SHORT"; x: number; w: number; h: number }> {
  const h = (usd: number) => Math.min(zoneH, Math.max(3, (usd / Math.max(maxVolume, 1)) * zoneH));
  const hasL = b.longUsd > 0;
  const hasS = b.shortUsd > 0;
  if (hasL && hasS) {
    const w = Math.max(2, Math.floor(volumeBarWidth * 0.26));
    const total = w * 2 + 1;
    const x0 = centerX - total / 2;
    return [
      { side: "LONG", x: x0, w, h: h(b.longUsd) },
      { side: "SHORT", x: x0 + w + 1, w, h: h(b.shortUsd) },
    ];
  }
  if (hasL || hasS) {
    const w = Math.max(2, Math.floor(volumeBarWidth * 0.32));
    return [{ side: hasL ? "LONG" : "SHORT", x: centerX - w / 2, w, h: h(hasL ? b.longUsd : b.shortUsd) }];
  }
  return [];
}
