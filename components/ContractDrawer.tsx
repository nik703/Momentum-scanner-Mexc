"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useContractFeed } from "@/hooks/useContractFeed";
import { useCrossExchangeLiquidations } from "@/hooks/useCrossExchangeLiquidations";
import { calculateBiasScore } from "@/lib/biasScore";
import type { ContractSnapshot } from "@/lib/contractFeed";
import { fmtPct, fmtPrice, fmtUsd } from "@/lib/format";
import { DirectionalBiasBar } from "./DirectionalBiasBar";
import { LiquidationsPanel } from "./LiquidationsPanel";
import { MicroChart, type ChartTimeframe } from "./MicroChart";
import { Badge, SegmentedControl, cx } from "./ui/primitives";

const CHART_TFS = [
  { value: "1M", label: "1M", hint: "1-minute candles (MEXC Min1 kline stream)" },
  { value: "1S", label: "1S", hint: "1-second candles built from live trades (last 120s)" },
] as const;

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="min-w-0 px-2 py-1.5 sm:px-3">
      <div className="text-[9.5px] font-medium uppercase tracking-wider text-fg-3">{label}</div>
      <div className={cx("num truncate text-[12px]", tone ?? "text-fg")}>{value}</div>
    </div>
  );
}

/**
 * Contract Inspection Drawer: a 520px right slide-over below the top bar on desktop, and a
 * full-screen sheet on mobile. It is not modal: the scanner and its Top 10 alerts keep running.
 */
export function ContractDrawer({ symbol, onClose }: { symbol: string; onClose: () => void }) {
  const feed = useContractFeed(symbol);
  const closeRef = useRef<HTMLButtonElement>(null);

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
          <InspectorBody symbol={symbol} feed={feed} />
        )}
      </div>
    </aside>
  );
}

function InspectorBody({ symbol, feed }: { symbol: string; feed: ContractSnapshot }) {
  const liqs = useCrossExchangeLiquidations(symbol, feed.detail?.baseCoin, feed.status === "ready");
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

  const t = feed.ticker;
  const change = t ? t.riseFallRate * 100 : null;
  const liqReady = liqs.status.BN === "open" || liqs.status.BYB === "open" || liqs.status.OKX === "open";

  return (
    <>
      {/* Price strip */}
      <div className="flex items-end justify-between gap-3 border-b border-line px-2 py-2 sm:px-3">
        <div>
          <div className="num text-[22px] font-semibold leading-none" data-testid="drawer-price">
            {t ? fmtPrice(t.lastPrice) : "—"}
          </div>
          <div className={cx("num mt-1 text-[11px]", change === null ? "text-fg-3" : change >= 0 ? "text-gain" : "text-loss")}>
            {fmtPct(change)} 24h
          </div>
        </div>
        <div className="num text-right text-[10.5px] text-fg-3">
          <div>
            H <span className="text-fg-2">{t ? fmtPrice(t.high24Price) : "—"}</span>
          </div>
          <div>
            L <span className="text-fg-2">{t ? fmtPrice(t.lower24Price) : "—"}</span>
          </div>
        </div>
      </div>
      <div className="grid grid-cols-2 border-b border-line sm:grid-cols-4 [&>*]:border-line [&>*:nth-child(odd)]:border-r sm:[&>*]:border-r sm:[&>*:last-child]:border-r-0">
        <Stat label="Mark" value={t ? fmtPrice(t.fairPrice) : "—"} />
        <Stat label="Index" value={t ? fmtPrice(t.indexPrice) : "—"} />
        <Stat
          label="Funding"
          value={t ? fmtPct(t.fundingRate * 100, 4) : "—"}
          tone={!t ? undefined : t.fundingRate > 0 ? "text-gain" : t.fundingRate < 0 ? "text-loss" : "text-fg"}
        />
        <Stat label="24h Turnover" value={t ? fmtUsd(t.amount24) : "—"} />
      </div>

      {/* Bias */}
      <div className="border-b border-line px-2 pb-3 pt-2.5 sm:px-3">
        <DirectionalBiasBar bias={bias} liqReady={liqReady} />
      </div>

      {/* Chart */}
      <div className="border-b border-line px-2 py-2 sm:px-3">
        <div className="mb-1 flex items-center justify-between">
          <span className="text-[10px] font-medium uppercase tracking-wider text-fg-3">
            {tf === "1M" ? "1-minute · last 60m" : "1-second · last 120s"}
          </span>
          <SegmentedControl label="Chart timeframe" value={tf} onChange={setTf} options={CHART_TFS} mono />
        </div>
        {feed.status === "loading" && tf === "1M" && feed.min1.length === 0 ? (
          <div className="flex h-[260px] items-center justify-center text-[11px] text-fg-3" aria-busy="true">
            Loading {symbol}…
          </div>
        ) : (
          <MicroChart
            candles={tf === "1M" ? feed.min1 : feed.sec1}
            timeframe={tf}
            emptyLabel={tf === "1S" ? "Waiting for trades…" : "No candles"}
          />
        )}
      </div>

      {/* Liquidations */}
      <div className="px-2 py-2 sm:px-3">
        <LiquidationsPanel snap={liqs} />
      </div>
    </>
  );
}
