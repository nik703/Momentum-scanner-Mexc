"use client";

import { LIQ_MAX, PRICE_MAX, SCORE_MAX, VOLUME_MAX, type BiasResult } from "@/lib/biasScore";
import { cx } from "./ui/primitives";

const TICKS = [-50, -25, 0, 25, 50] as const;
const SCORE_MIN: number = -SCORE_MAX;

function signed(v: number): string {
  if (v === 0) return "0.0";
  return `${v > 0 ? "+" : "-"}${Math.abs(v).toFixed(1)}`;
}

function Pill({ label, value, max }: { label: string; value: number; max: number }) {
  const tone = value > 0 ? "text-gain" : value < 0 ? "text-loss" : "text-fg-2";
  return (
    <span
      className="num inline-flex h-5 items-center gap-1 rounded-[2px] border border-line px-1.5 text-[10.5px]"
      title={`${label}: ${signed(value)} of ±${max}`}
    >
      <span className="text-fg-3">{label}:</span>
      <span className={tone}>{signed(value)}</span>
    </span>
  );
}

/**
 * Two-sided gauge centered at 0. Negative scores fill left in the loss color and positive
 * scores fill right in the gain color, with ticks at -50, -25, 0, +25 and +50.
 */
export function DirectionalBiasBar({ bias, liqReady }: { bias: BiasResult; liqReady: boolean }) {
  const pct = (Math.min(SCORE_MAX, Math.abs(bias.total)) / SCORE_MAX) * 50; // % of full width, per side
  const tone = bias.total > 0 ? "text-gain" : bias.total < 0 ? "text-loss" : "text-fg-2";

  return (
    <div className="space-y-2" data-testid="bias-bar">
      <div className="flex items-baseline justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <span className={cx("num text-[20px] font-semibold leading-none", tone)} data-testid="bias-score">
            {signed(bias.total)}
          </span>
          <span className={cx("num text-[11px] font-semibold tracking-widest", tone)}>{bias.label}</span>
        </div>
        <span className="num text-[10px] uppercase tracking-wider text-fg-3">
          15M bias · {bias.sampleSize}/15 bars{liqReady ? "" : " · liq warming"}
        </span>
      </div>

      <div
        role="meter"
        aria-label="Directional bias"
        aria-valuemin={SCORE_MIN}
        aria-valuemax={SCORE_MAX}
        aria-valuenow={bias.total}
        aria-valuetext={`${signed(bias.total)} ${bias.label}`}
        className="relative h-2.5 border border-line bg-canvas"
      >
        {bias.total < 0 && <span className="absolute inset-y-0 right-1/2 bg-loss" style={{ width: `${pct}%` }} />}
        {bias.total > 0 && <span className="absolute inset-y-0 left-1/2 bg-gain" style={{ width: `${pct}%` }} />}
        {/* Tick marks */}
        {TICKS.map((t) => (
          <span
            key={t}
            aria-hidden
            className={cx("absolute -bottom-[5px] w-px bg-line-strong", t === 0 ? "-top-[5px] bg-fg-2" : "h-[5px]")}
            style={{ left: `calc(${((t + SCORE_MAX) / (2 * SCORE_MAX)) * 100}% - ${t === SCORE_MAX ? 1 : 0}px)` }}
          />
        ))}
      </div>
      <div className="num relative h-3 text-[9.5px] text-fg-3" aria-hidden>
        {TICKS.map((t) => (
          <span
            key={t}
            className={cx("absolute top-0", t === -SCORE_MAX ? "left-0" : t === SCORE_MAX ? "right-0" : "-translate-x-1/2")}
            style={t === -SCORE_MAX || t === SCORE_MAX ? undefined : { left: `${((t + SCORE_MAX) / (2 * SCORE_MAX)) * 100}%` }}
          >
            {t > 0 ? `+${t}` : t}
          </span>
        ))}
      </div>

      <div className="flex flex-wrap gap-1.5">
        <Pill label="PA" value={bias.price} max={PRICE_MAX} />
        <Pill label="VOL" value={bias.volume} max={VOLUME_MAX} />
        <Pill label="LIQ" value={bias.liquidation} max={LIQ_MAX} />
      </div>
    </div>
  );
}
