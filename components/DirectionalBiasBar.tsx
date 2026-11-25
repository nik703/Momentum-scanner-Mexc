"use client";

import { CVD_MAX, LIQ_MAX, PRICE_MAX, SCORE_MAX, type BiasRegime, type BiasResult } from "@/lib/biasScore";
import { fmtUsd } from "@/lib/format";
import { cx } from "./ui/primitives";

const TICKS = [-50, -25, 0, 25, 50] as const;
const SCORE_MIN: number = -SCORE_MAX;

type Factor = "cvd" | "price" | "liq";

/** Tailwind background class per factor and direction (theme tokens, aligned with the chart overlay). */
const FACTOR_BG: Record<Factor, { pos: string; neg: string }> = {
  cvd: { pos: "bg-gain", neg: "bg-loss" }, // emerald / crimson
  price: { pos: "bg-bias-price-pos", neg: "bg-bias-price-neg" }, // teal / orange
  liq: { pos: "bg-liq-short", neg: "bg-liq-long" }, // yellow (short liqs) / purple (long liqs)
};

const FACTOR_LABEL: Record<Factor, string> = { cvd: "CVD", price: "VWAP", liq: "LIQ" };
const FACTOR_TITLE: Record<Factor, string> = {
  cvd: "Taker CVD × open-interest intent × volume pace (±20)",
  price: "ATR-normalized move, 15m VWAP position and range CLV (±15)",
  liq: "Liquidity-scaled cross-exchange liquidation imbalance (±15)",
};

const REGIME_TONE: Record<BiasRegime, string> = {
  "BULL TREND": "border-gain bg-gain-tint text-gain",
  "SHORT SQUEEZE": "border-gain bg-gain-tint text-gain",
  "BEAR TREND": "border-loss bg-loss-tint text-loss",
  "LONG CASCADE": "border-loss bg-loss-tint text-loss",
  "BULL DIVERGENCE": "border-alert bg-alert-tint text-alert", // amber
  "BEAR DIVERGENCE": "border-liq-long text-liq-long", // violet
  CHOP: "border-line text-fg-2",
};

function signed(v: number): string {
  if (v === 0) return "0.0";
  return `${v > 0 ? "+" : "-"}${Math.abs(v).toFixed(1)}`;
}

interface Segment {
  factor: Factor;
  score: number;
  /** Offset (%) from the 0 line, outward. */
  offset: number;
  width: number;
}

/**
 * Positive factors stack rightward from 50% and negative factors stack leftward from 50%, both in
 * fixed CVD → VWAP → LIQ order. 1 point = 1% of track width (±50 points fills each half), so
 * opposing forces stay visible instead of cancelling out.
 */
export function biasSegments(cvd: number, price: number, liq: number): { pos: Segment[]; neg: Segment[] } {
  const pos: Segment[] = [];
  const neg: Segment[] = [];
  let po = 0;
  let no = 0;
  for (const [factor, score] of [["cvd", cvd], ["price", price], ["liq", liq]] as const) {
    if (score > 0) {
      const w = Math.min(score, 50 - po);
      pos.push({ factor, score, offset: po, width: w });
      po += w;
    } else if (score < 0) {
      const w = Math.min(-score, 50 - no);
      neg.push({ factor, score, offset: no, width: w });
      no += w;
    }
  }
  return { pos, neg };
}

/**
 * 15M flow bias gauge: a regime badge, the net score, and a center-zero tug-of-war track. Each
 * factor's segment sits on its own side of 0, and a 2px needle marks the exact net sum.
 */
export function DirectionalBiasBar({ bias, liqReady }: { bias: BiasResult; liqReady: boolean }) {
  const { netScore, cvdScore, priceScore, liqScore, regime, breakdown: b } = bias;
  const { pos, neg } = biasSegments(cvdScore, priceScore, liqScore);
  const tone = netScore > 0 ? "text-gain" : netScore < 0 ? "text-loss" : "text-fg-2";
  const needle = Math.max(SCORE_MIN, Math.min(SCORE_MAX, netScore));
  const title =
    `CVD ${signed(cvdScore)} (ratio ${b.cvdRatio.toFixed(2)}, pace ${b.pace.toFixed(2)}, ${b.dealsUsed} trades + ${b.backfilledCandles} backfilled min, 15m ${fmtUsd(b.total15mUsd)})\n` +
    `VWAP ${signed(priceScore)} (netZ ${b.netZ.toFixed(2)}, vwapZ ${b.vwapZ.toFixed(2)}, CLV ${b.clv.toFixed(2)})\n` +
    `LIQ ${signed(liqScore)} (floor ${fmtUsd(b.scaleFloor)}${b.liqDamped ? ", damped ×0.2 (reclaim/rejection)" : ""})`;

  return (
    <div
      className="min-w-0 space-y-2"
      data-testid="bias-bar"
      title={title}
      data-net={netScore}
      data-cvd={cvdScore}
      data-price={priceScore}
      data-liq={liqScore}
      data-deals={b.dealsUsed}
      data-backfill={b.backfilledCandles}
      data-contract-size={b.contractSize}
      data-liq-damped={b.liqDamped ? "1" : "0"}
    >
      {/* Header: label + regime badge | net score */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="whitespace-nowrap text-[10px] font-medium uppercase tracking-wider text-fg-3">15M Flow Bias</span>
          <span
            data-testid="bias-regime"
            className={cx("num truncate rounded-[2px] border px-1.5 text-[10px] font-semibold uppercase leading-[16px] tracking-wider", REGIME_TONE[regime])}
          >
            {regime}
          </span>
        </div>
        <span className={cx("num shrink-0 text-[18px] font-bold leading-none tabular-nums", tone)} data-testid="bias-score">
          {signed(netScore)}
        </span>
      </div>

      {/* Track: -50 (0%) .. 0 (50%) .. +50 (100%), 14px tall, 1px hairline border */}
      <div
        role="meter"
        aria-label="15 minute flow bias"
        aria-valuemin={SCORE_MIN}
        aria-valuemax={SCORE_MAX}
        aria-valuenow={netScore}
        aria-valuetext={`${signed(netScore)} ${regime}; CVD ${signed(cvdScore)}, VWAP ${signed(priceScore)}, liquidations ${signed(liqScore)}`}
        data-testid="bias-track"
        className="relative mx-[3px] h-[14px] border border-line bg-canvas"
      >
        {pos.map((s) => (
          <span
            key={`p-${s.factor}`}
            data-segment={s.factor}
            data-direction="pos"
            className={cx("absolute inset-y-0", FACTOR_BG[s.factor].pos)}
            style={{ left: `${50 + s.offset}%`, width: `${s.width}%` }}
          />
        ))}
        {neg.map((s) => (
          <span
            key={`n-${s.factor}`}
            data-segment={s.factor}
            data-direction="neg"
            className={cx("absolute inset-y-0", FACTOR_BG[s.factor].neg)}
            style={{ right: `${50 + s.offset}%`, width: `${s.width}%` }}
          />
        ))}
        {TICKS.map((t) => (
          <span
            key={t}
            aria-hidden
            className={cx("absolute inset-y-0 w-px", t === 0 ? "bg-fg-3" : "bg-line-strong")}
            style={{ left: `calc(${50 + t}% - ${t === 50 ? 1 : 0}px)` }}
          />
        ))}
        {/* Net needle: 2px, 3px above and below the track */}
        <span
          aria-hidden
          data-testid="bias-needle"
          className="absolute -bottom-[4px] -top-[4px] w-[2px] bg-fg"
          style={{ left: `calc(${50 + needle}% - 1px)` }}
        />
      </div>
      <div className="num relative mx-[3px] h-3 text-[9.5px] text-fg-3" aria-hidden>
        {TICKS.map((t) => (
          <span
            key={t}
            className={cx("absolute top-0", t === -50 ? "left-0" : t === 50 ? "right-0" : "-translate-x-1/2")}
            style={t === -50 || t === 50 ? undefined : { left: `${50 + t}%` }}
          >
            {t > 0 ? `+${t}` : t}
          </span>
        ))}
      </div>

      {/* Factor micro-readout */}
      <div className="num flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] tabular-nums" data-testid="bias-readout">
        {(
          [
            ["cvd", cvdScore, CVD_MAX],
            ["price", priceScore, PRICE_MAX],
            ["liq", liqScore, LIQ_MAX],
          ] as const
        ).map(([f, v, max]) => (
          <span key={f} className="inline-flex items-center gap-1 whitespace-nowrap" title={`${FACTOR_TITLE[f]}: ${signed(v)} of ±${max}`} data-factor={f}>
            <span aria-hidden className={cx("h-1.5 w-1.5", v > 0 ? FACTOR_BG[f].pos : v < 0 ? FACTOR_BG[f].neg : "bg-fg-3")} />
            <span className="text-fg-3">{FACTOR_LABEL[f]}</span>
            <span className={v > 0 ? "text-fg" : v < 0 ? "text-fg" : "text-fg-3"}>{signed(v)}</span>
          </span>
        ))}
        {!liqReady && <span className="text-[10px] uppercase tracking-wider text-fg-3">liq warming</span>}
      </div>
    </div>
  );
}
