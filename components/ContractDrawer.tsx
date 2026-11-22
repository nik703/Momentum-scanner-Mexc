"use client";

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useContractFeed } from "@/hooks/useContractFeed";
import { useCrossExchangeLiquidations } from "@/hooks/useCrossExchangeLiquidations";
import { calculateBiasScore } from "@/lib/biasScore";
import type { ContractSnapshot } from "@/lib/contractFeed";
import { fmtPct, fmtUsd1, makePriceFormatter } from "@/lib/format";
import type { ContractTicker } from "@/lib/types";
import { DirectionalBiasBar } from "./DirectionalBiasBar";
import { LiquidationsPanel } from "./LiquidationsPanel";
import { MicroChart, type ChartTimeframe } from "./MicroChart";
import { Badge, SegmentedControl, cx } from "./ui/primitives";

const CHART_TFS = [
  { value: "1M", label: "1M", hint: "1-minute candles (MEXC Min1 kline stream)" },
  { value: "1S", label: "1S", hint: "1-second candles built from live trades (last 120s)" },
] as const;

/**
 * Live last price. Its color follows the direction of the latest tick, and a hairline-free
 * background flash re-triggers on every change. Uses React's "adjust state while rendering"
 * pattern to compare with the previous value, so there are no effects and no reads of refs
 * during render.
 */
function LivePrice({ value, text }: { value: number | null; text: string }) {
  const [prev, setPrev] = useState(value);
  const [tick, setTick] = useState<{ dir: -1 | 0 | 1; seq: number }>({ dir: 0, seq: 0 });
  if (value !== prev) {
    setPrev(value);
    if (value !== null && prev !== null) setTick({ dir: value > prev ? 1 : -1, seq: tick.seq + 1 });
  }
  return (
    <span
      data-testid="drawer-price"
      className={cx(
        "num relative block whitespace-nowrap text-lg font-semibold leading-none tracking-tight tabular-nums sm:text-2xl",
        tick.dir > 0 ? "text-gain" : tick.dir < 0 ? "text-loss" : "text-fg",
      )}
    >
      {tick.seq > 0 && (
        <span
          key={tick.seq}
          aria-hidden
          className={cx("pointer-events-none absolute -inset-x-1 -inset-y-0.5", tick.dir > 0 ? "flash-gain" : "flash-loss")}
        />
      )}
      <span className="relative">{text}</span>
    </span>
  );
}

/** One cell of the 2x2 metadata grid: short label on mobile, full label from sm up. */
function MetaCell({
  stat,
  short,
  long,
  value,
  tone,
}: {
  stat: string;
  short: string;
  long: string;
  value: string;
  tone?: string;
}) {
  return (
    <div data-stat={stat} className="whitespace-nowrap" title={`${long}: ${value}`}>
      <span className="mr-1 text-[9px] uppercase tracking-wider text-fg-3 sm:text-[9.5px]">
        <span className="sm:hidden">{short}</span>
        <span className="hidden sm:inline">{long}</span>
      </span>
      <span className={tone ?? "text-fg"}>{value}</span>
    </div>
  );
}

/**
 * Price + ticker strip. A single row at every width: the live price on the left and a 2x2
 * metadata grid (Mark / Index / Funding / 24h turnover) on the right. On mobile it stays
 * ≤ 44px tall and fits a 12-character sub-cent price at 360px. From sm up it gets more
 * padding, a larger price and full labels.
 */
function PriceStrip({ ticker: t, priceScale }: { ticker: ContractTicker | null; priceScale: number | null }) {
  const fmt = useMemo(() => makePriceFormatter(t?.lastPrice ?? 0, priceScale), [t?.lastPrice, priceScale]);
  const change = t ? t.riseFallRate * 100 : null;
  const funding = t ? t.fundingRate * 100 : null;
  return (
    <div
      data-testid="drawer-price-row"
      className="flex items-center justify-between gap-2 border-b border-line px-3 py-1.5 sm:flex-row sm:items-center sm:justify-between sm:px-4 sm:py-2.5"
    >
      <div data-testid="drawer-price-block" className="shrink-0">
        <LivePrice value={t?.lastPrice ?? null} text={t ? fmt(t.lastPrice) : "—"} />
        <div
          className={cx(
            "num mt-px whitespace-nowrap text-[11px] leading-[12px] tabular-nums sm:mt-1",
            change === null ? "text-fg-3" : change >= 0 ? "text-gain" : "text-loss",
          )}
        >
          {fmtPct(change)} <span className="text-fg-3">24h</span>
        </div>
      </div>
      <div
        data-testid="drawer-stats-grid"
        className="num grid min-w-0 grid-cols-2 grid-rows-2 gap-x-2.5 gap-y-0.5 text-right text-[10px] leading-tight tabular-nums sm:gap-x-5 sm:gap-y-1 sm:text-[11px]"
      >
        <MetaCell stat="mark" short="MRK" long="Mark" value={t ? fmt(t.fairPrice) : "—"} />
        <MetaCell stat="index" short="IDX" long="Index" value={t ? fmt(t.indexPrice) : "—"} />
        <MetaCell
          stat="funding"
          short="FND"
          long="Funding"
          value={funding === null ? "—" : fmtPct(funding, 4)}
          tone={funding === null || funding === 0 ? "text-fg" : funding > 0 ? "text-gain" : "text-loss"}
        />
        <MetaCell stat="turnover" short="24H" long="24h Vol" value={t ? fmtUsd1(t.amount24) : "—"} />
      </div>
    </div>
  );
}

/**
 * Contract Inspection Drawer: a 520px right slide-over below the top bar on desktop, and a
 * full-screen sheet on mobile. It is not modal: the scanner and its Top 10 alerts keep running.
 */
export function ContractDrawer({
  symbol,
  onClose,
  soundEnabled,
}: {
  symbol: string;
  onClose: () => void;
  /** Global Ping: ON / OFF toggle. */
  soundEnabled: boolean;
}) {
  const feed = useContractFeed(symbol);
  const closeRef = useRef<HTMLButtonElement>(null);
  // Liquidation pings only fire for events received after this moment. The drawer is keyed by
  // symbol, so switching contracts remounts it and re-arms the guard.
  const drawerOpenedAtRef = useRef(0);
  useEffect(() => {
    drawerOpenedAtRef.current = Date.now();
  }, []);

  // Move focus into the drawer on open, and give it back to the trigger on close.
  useEffect(() => {
    const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus({ preventScroll: true });
    return () => prev?.focus({ preventScroll: true });
  }, []);

  const wsOk = feed.ws === "open";

  return (
    <aside
      role="dialog"
      aria-modal="false"
      aria-labelledby="drawer-title"
      data-testid="contract-drawer"
      className="drawer-enter fixed inset-0 z-40 flex flex-col bg-panel sm:left-auto sm:top-[44px] sm:w-[520px] sm:border-l sm:border-line"
    >
      <header className="flex h-[44px] shrink-0 items-center gap-2 border-b border-line px-2 sm:px-3">
        <h2 id="drawer-title" className="num truncate text-[13px] font-semibold" data-testid="drawer-symbol">
          {symbol.replace(/_USDT$/, "")}
          <span className="font-normal text-fg-3">_USDT</span>
        </h2>
        <Badge>Perp</Badge>
        {feed.status !== "error" && (
          <span
            className={cx("h-1.5 w-1.5", wsOk ? "bg-gain" : "blink bg-alert")}
            title={`MEXC stream: ${feed.ws}`}
            aria-label={`MEXC stream ${feed.ws}`}
          />
        )}
        <a
          href={`https://futures.mexc.com/exchange/${symbol}`}
          target="_blank"
          rel="noopener noreferrer"
          className="ml-auto inline-flex h-7 items-center rounded-[3px] border border-line px-2 text-[11px] text-fg-2 hover:text-fg"
        >
          Trade ↗
        </a>
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          aria-label="Close inspection drawer (Esc)"
          title="Close (Esc)"
          data-testid="drawer-close"
          className="inline-flex h-7 w-7 items-center justify-center rounded-[3px] border border-line text-fg-2 hover:text-fg"
        >
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.6">
            <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />
          </svg>
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {feed.status === "error" ? (
          <div role="alert" className="m-3 border border-line bg-loss-tint px-3 py-3 text-[12px] text-loss" data-testid="drawer-error">
            <div className="font-semibold">{feed.error?.status === 404 ? "Contract not found" : "Could not load contract"}</div>
            <div className="mt-0.5 text-fg-2">{feed.error?.message}</div>
          </div>
        ) : (
          // Mounted only for a valid contract, so a 404 never opens liquidation sockets.
          <InspectorBody symbol={symbol} feed={feed} soundEnabled={soundEnabled} drawerOpenedAtRef={drawerOpenedAtRef} />
        )}
      </div>
    </aside>
  );
}

function InspectorBody({
  symbol,
  feed,
  soundEnabled,
  drawerOpenedAtRef,
}: {
  symbol: string;
  feed: ContractSnapshot;
  soundEnabled: boolean;
  drawerOpenedAtRef: RefObject<number>;
}) {
  const liqs = useCrossExchangeLiquidations(symbol, feed.detail?.baseCoin, {
    enabled: feed.status === "ready",
    soundEnabled,
    drawerOpenedAtRef,
  });
  const [tf, setTf] = useState<ChartTimeframe>("1M");

  const bias = useMemo(
    () =>
      calculateBiasScore({
        candles: feed.min1,
        longLiqUsd15m: liqs.window15m.longUsd,
        shortLiqUsd15m: liqs.window15m.shortUsd,
      }),
    [feed.min1, liqs.window15m.longUsd, liqs.window15m.shortUsd],
  );

  // Same decimals as the price strip, so the watermark matches the headline price exactly.
  const chartFmt = useMemo(
    () => makePriceFormatter(feed.ticker?.lastPrice ?? 0, feed.detail?.priceScale ?? null),
    [feed.ticker?.lastPrice, feed.detail?.priceScale],
  );
  const liqReady = liqs.status.BN === "open" || liqs.status.BYB === "open" || liqs.status.OKX === "open";

  return (
    <>
      {/* Price + 2x2 ticker strip (single row at all widths) */}
      <PriceStrip ticker={feed.ticker} priceScale={feed.detail?.priceScale ?? null} />

      {/* Bias */}
      <div className="border-b border-line px-2 pb-3 pt-2.5 sm:px-3">
        <DirectionalBiasBar bias={bias} liqReady={liqReady} />
      </div>

      {/* Chart: the toolbar (title, zoom, BG price, 1M/1S) is rendered by MicroChart */}
      <div className="border-b border-line px-2 py-2 sm:px-3">
        <MicroChart
          candles={tf === "1M" ? feed.min1 : feed.sec1}
          timeframe={tf}
          title={tf === "1M" ? "1-minute · last 60m" : "1-second · last 120s"}
          timeframeControl={
            <SegmentedControl label="Chart timeframe" value={tf} onChange={setTf} options={CHART_TFS} mono compact />
          }
          livePrice={feed.ticker?.lastPrice ?? null}
          formatPrice={chartFmt}
          emptyLabel={
            feed.status === "loading" ? `Loading ${symbol}…` : tf === "1S" ? "Waiting for trades…" : "No candles"
          }
        />
      </div>

      {/* Liquidations */}
      <div className="px-2 py-2 sm:px-3">
        <LiquidationsPanel snap={liqs} soundEnabled={soundEnabled} />
      </div>
    </>
  );
}
