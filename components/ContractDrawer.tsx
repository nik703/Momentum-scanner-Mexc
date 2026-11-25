"use client";

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  THEMES,
  useBgPriceSetting,
  useLiqOverlaySetting,
  useLiqPingSetting,
  useSmoothSetting,
  useThemeSetting,
} from "@/hooks/useAppSettings";
import { useContractFeed } from "@/hooks/useContractFeed";
import { useCrossExchangeLiquidations } from "@/hooks/useCrossExchangeLiquidations";
import { playLongLiqPing, playShortLiqPing, unlockAudio } from "@/lib/audio";
import { calculateBiasScore, type BiasDeal } from "@/lib/biasScore";
import type { ContractSnapshot } from "@/lib/contractFeed";
import { fmtPct, fmtUsd1, makePriceFormatter } from "@/lib/format";
import type { ContractTicker } from "@/lib/types";
import { DirectionalBiasBar } from "./DirectionalBiasBar";
import { LiquidationsPanel } from "./LiquidationsPanel";
import { MicroChart, type ChartTimeframe } from "./MicroChart";
import { SettingsAction, SettingsDivider, SettingsPopover, SettingsRow, SettingsSwitch } from "./SettingsPopover";
import { Badge, SegmentedControl, cx } from "./ui/primitives";

const CHART_TFS = [
  { value: "1M", label: "1M", hint: "1-minute candles (MEXC Min1 kline stream)" },
  { value: "10S", label: "10S", hint: "10-second candles from recent + live trades (last 15m)" },
  { value: "1S", label: "1S", hint: "1-second candles from recent + live trades (last 3m)" },
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
/** Drawer cog: theme, liquidation pings (+ audition), chart overlay, smoothing, background price. */
function DrawerSettings() {
  const [theme, setTheme] = useThemeSetting();
  const [liqPing, setLiqPing] = useLiqPingSetting();
  const [liqOverlay, setLiqOverlay] = useLiqOverlaySetting();
  const [smooth, setSmooth] = useSmoothSetting();
  const [bgPrice, setBgPrice] = useBgPriceSetting();
  const audition = async (side: "LONG" | "SHORT") => {
    await unlockAudio(); // a click is a user gesture: also unlocks live pings
    if (side === "LONG") playLongLiqPing();
    else playShortLiqPing();
  };
  return (
    <SettingsPopover label="Chart & drawer settings" testId="drawer-settings">
      <SettingsRow label="Theme">
        <SegmentedControl
          label="Theme"
          value={theme}
          onChange={setTheme}
          options={THEMES.map((t) => ({ value: t, label: t === "dark" ? "Dark" : "Light" }))}
          compact
        />
      </SettingsRow>
      <SettingsDivider />
      <SettingsRow label="Liq pings" hint="Live LONG / SHORT liquidation sounds for this coin">
        <SettingsSwitch
          label="Liquidation audio pings"
          testId="set-liq-ping"
          checked={liqPing}
          onChange={(v) => {
            setLiqPing(v);
            if (v) void unlockAudio();
          }}
        />
      </SettingsRow>
      <SettingsRow label="Audition">
        <SettingsAction label="Play long liquidation ping (740 → 554 Hz)" testId="preview-long-ping" tone="liq-long" onClick={() => void audition("LONG")}>
          ▼ Long
        </SettingsAction>
        <SettingsAction label="Play short liquidation ping (880 → 1245 Hz)" testId="preview-short-ping" tone="liq-short" onClick={() => void audition("SHORT")}>
          ▲ Short
        </SettingsAction>
      </SettingsRow>
      <SettingsDivider />
      <SettingsRow label="Chart liqs" hint="Liquidation bars over the volume bars (purple = longs, yellow = shorts)">
        <SettingsSwitch label="Chart liquidations overlay" testId="set-liq-overlay" checked={liqOverlay} onChange={setLiqOverlay} />
      </SettingsRow>
      <SettingsRow label="Smoothing" hint="Gap-free Heikin-Ashi candles on 10S / 1S (prices stay exact)">
        <SettingsSwitch label="Candle smoothing" testId="set-smooth" checked={smooth} onChange={setSmooth} />
      </SettingsRow>
      <SettingsRow label="BG price" hint="Large live price watermark behind the candles">
        <SettingsSwitch label="Background price watermark" testId="set-bg-price" checked={bgPrice} onChange={setBgPrice} />
      </SettingsRow>
    </SettingsPopover>
  );
}

export function ContractDrawer({ symbol, onClose }: { symbol: string; onClose: () => void }) {
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
        <DrawerSettings />
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
          <InspectorBody symbol={symbol} feed={feed} drawerOpenedAtRef={drawerOpenedAtRef} />
        )}
      </div>
    </aside>
  );
}

function InspectorBody({
  symbol,
  feed,
  drawerOpenedAtRef,
}: {
  symbol: string;
  feed: ContractSnapshot;
  drawerOpenedAtRef: RefObject<number>;
}) {
  const [soundEnabled] = useLiqPingSetting();
  const [liqOverlay] = useLiqOverlaySetting();
  const [smooth] = useSmoothSetting();
  const [bgPrice] = useBgPriceSetting();
  const liqs = useCrossExchangeLiquidations(symbol, feed.detail?.baseCoin, {
    enabled: feed.status === "ready",
    soundEnabled,
    drawerOpenedAtRef,
  });
  const [tf, setTf] = useState<ChartTimeframe>("1M");

  // Rolling 15-minute deal buffer for this contract (REST history + live push.deal, intent fields
  // kept). The window end is the newest known event, not Date.now(), so render stays pure.
  const deals15m = useMemo(() => {
    const lastDeal = feed.deals.length ? feed.deals[feed.deals.length - 1].t : 0;
    const lastCandle = feed.min1.length ? feed.min1[feed.min1.length - 1].t + 59_999 : 0;
    const from = Math.max(lastDeal, lastCandle) - 900_000;
    const out: BiasDeal[] = [];
    for (const d of feed.deals) {
      if (d.t >= from) out.push({ price: d.p, vol: d.v, side: d.T === 2 ? 2 : 1, openFlag: d.O, timestampMs: d.t });
    }
    return out;
  }, [feed.deals, feed.min1]);

  const latestPrice = feed.ticker?.lastPrice ?? feed.min1[feed.min1.length - 1]?.c ?? 0;
  const amount24 = feed.ticker?.amount24 ?? 0;
  const bias = useMemo(
    () =>
      calculateBiasScore({
        candles: feed.min1,
        deals: deals15m,
        latestPrice,
        amount24,
        shortLiqUsd15m: liqs.shortLiqUsd15m,
        longLiqUsd15m: liqs.longLiqUsd15m,
        liqVwap15m: liqs.liqVwap15m,
      }),
    [feed.min1, deals15m, latestPrice, amount24, liqs.shortLiqUsd15m, liqs.longLiqUsd15m, liqs.liqVwap15m],
  );

  // Same decimals as the price strip, so the watermark matches the headline price exactly.
  const chartFmt = useMemo(
    () => makePriceFormatter(feed.ticker?.lastPrice ?? 0, feed.detail?.priceScale ?? null),
    [feed.ticker?.lastPrice, feed.detail?.priceScale],
  );
  // Rolling 15m window + session tape (the bucketing dedupes by id). Stable between flushes.
  const liqEvents = useMemo(() => [...liqs.windowEvents, ...liqs.tape], [liqs.windowEvents, liqs.tape]);
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
          candles={tf === "1M" ? feed.min1 : tf === "10S" ? feed.sec10 : feed.sec1}
          timeframe={tf}
          title={tf === "1M" ? "1-minute · 60m" : tf === "10S" ? "10-second · 15m" : "1-second · 3m"}
          timeframeControl={
            <SegmentedControl label="Chart timeframe" value={tf} onChange={setTf} options={CHART_TFS} mono compact />
          }
          livePrice={feed.ticker?.lastPrice ?? null}
          formatPrice={chartFmt}
          bgPrice={bgPrice}
          smooth={smooth}
          liqOverlay={liqOverlay}
          liquidations={liqEvents}
          emptyLabel={
            feed.status === "loading" ? `Loading ${symbol}…` : tf === "1M" ? "No candles" : "Waiting for trades…"
          }
        />
      </div>

      {/* Liquidations */}
      <div className="px-2 py-2 sm:px-3">
        <LiquidationsPanel snap={liqs} />
      </div>
    </>
  );
}
