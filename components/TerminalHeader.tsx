"use client";

import { TIMEFRAMES, type Timeframe } from "@/lib/types";
import { Kbd, SegmentedControl, Switch, Tooltip, cx } from "./ui/primitives";

export const MIN_VOLUMES = ["0", "1000000", "5000000", "25000000"] as const;
export type MinVolume = (typeof MIN_VOLUMES)[number];
const MIN_VOL_OPTS = [
  { value: "0", label: "All" },
  { value: "1000000", label: ">$1M" },
  { value: "5000000", label: ">$5M" },
  { value: "25000000", label: ">$25M" },
] as const satisfies ReadonlyArray<{ value: MinVolume; label: string }>;

export const ROW_LIMITS = ["25", "50", "all"] as const;
export type RowLimit = (typeof ROW_LIMITS)[number];
const LIMIT_OPTS = [
  { value: "25", label: "Top 25" },
  { value: "50", label: "Top 50" },
  { value: "all", label: "All" },
] as const satisfies ReadonlyArray<{ value: RowLimit; label: string }>;

export type Theme = "dark" | "light";

interface Props {
  timeframe: Timeframe;
  onTimeframe: (tf: Timeframe) => void;
  minVolume: MinVolume;
  onMinVolume: (v: MinVolume) => void;
  limit: RowLimit;
  onLimit: (v: RowLimit) => void;
  query: string;
  onQuery: (q: string) => void;
  theme: Theme;
  onToggleTheme: () => void;
  pingOn: boolean;
  onPing: (on: boolean) => void;
  onTestPing: () => void;
}

function SearchBox({ query, onQuery, className }: { query: string; onQuery: (q: string) => void; className?: string }) {
  return (
    <label className={cx("relative flex h-7 items-center", className)}>
      <span className="sr-only">Search symbol</span>
      <svg
        viewBox="0 0 16 16"
        width="12"
        height="12"
        aria-hidden
        className="pointer-events-none absolute left-2 text-fg-3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      >
        <circle cx="7" cy="7" r="4.5" />
        <path d="M10.5 10.5L14 14" />
      </svg>
      <input
        data-symbol-search
        type="search"
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        placeholder="Symbol"
        autoComplete="off"
        spellCheck={false}
        className="num h-full w-full rounded-[3px] border border-line bg-canvas pl-6 pr-6 text-[12px] uppercase text-fg placeholder:normal-case placeholder:text-fg-3 focus:border-line-strong focus:outline-none"
      />
      <span className="pointer-events-none absolute right-1.5 hidden sm:block">
        <Kbd>/</Kbd>
      </span>
    </label>
  );
}

function Filters(p: Pick<Props, "minVolume" | "onMinVolume" | "limit" | "onLimit" | "query" | "onQuery">) {
  return (
    <>
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] font-medium uppercase tracking-wider text-fg-3">24h Vol</span>
        <SegmentedControl label="Minimum 24h volume" value={p.minVolume} onChange={p.onMinVolume} options={MIN_VOL_OPTS} mono />
      </div>
      <SegmentedControl label="Row count" value={p.limit} onChange={p.onLimit} options={LIMIT_OPTS} />
      <SearchBox query={p.query} onQuery={p.onQuery} className="min-w-[8rem] flex-1 lg:w-44 lg:flex-none" />
    </>
  );
}

export function TerminalHeader(p: Props) {
  return (
    <>
      <header className="sticky top-0 z-20 flex h-[44px] items-center gap-2 border-b border-line bg-panel px-2 sm:gap-3 sm:px-3">
        <div className="flex shrink-0 items-center gap-2">
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden className="text-gain">
            <path d="M2 11.5l3.5-3.5 2.5 2.5L14 4.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
          </svg>
          <h1 className="num hidden text-[12px] font-semibold uppercase tracking-wider sm:block">
            MEXC<span className="text-fg-3">/</span>Momentum
          </h1>
        </div>

        <span aria-hidden className="hidden h-5 w-px bg-line sm:block" />

        <div className="flex items-center gap-1.5">
          <SegmentedControl
            label="Timeframe"
            value={p.timeframe}
            onChange={p.onTimeframe}
            mono
            options={TIMEFRAMES.map((t, i) => ({ value: t, label: t, hint: `${t} window (key ${i + 1})` }))}
          />
          <span className="hidden items-center gap-0.5 xl:flex">
            <Kbd>1</Kbd>
            <Kbd>2</Kbd>
            <Kbd>3</Kbd>
          </span>
        </div>

        <div className="hidden items-center gap-3 lg:flex">
          <Filters {...p} />
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <Tooltip content="Toggle theme (T)">
            <button
              type="button"
              onClick={p.onToggleTheme}
              aria-label={`Theme: ${p.theme}. Switch to ${p.theme === "dark" ? "light" : "dark"}`}
              className="inline-flex h-7 items-center gap-1.5 rounded-[3px] border border-line px-2 text-[11.5px] font-medium text-fg-2 hover:text-fg"
            >
              {p.theme === "dark" ? (
                <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden fill="currentColor">
                  <path d="M6.2 1.5a6.5 6.5 0 1 0 8.3 8.3A5.5 5.5 0 0 1 6.2 1.5z" />
                </svg>
              ) : (
                <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.5">
                  <circle cx="8" cy="8" r="3" />
                  <path d="M8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M3 3l1 1M12 12l1 1M3 13l1-1M12 4l1-1" />
                </svg>
              )}
              <span className="hidden sm:inline">{p.theme === "dark" ? "Dark" : "Light"}</span>
            </button>
          </Tooltip>

          <div className="flex h-7 items-center rounded-[3px] border border-line">
            <Switch checked={p.pingOn} onChange={p.onPing} label="Top 10 audio alert">
              <span className="num">
                Ping: <span className={p.pingOn ? "text-gain" : "text-fg-2"}>{p.pingOn ? "ON" : "OFF"}</span>
              </span>
            </Switch>
            <button
              type="button"
              onClick={p.onTestPing}
              title="Play the test chime (also unlocks browser audio)"
              className="h-full border-l border-line px-2 text-[11px] font-medium text-fg-2 hover:bg-row-hover hover:text-fg"
            >
              Test
            </button>
          </div>
        </div>
      </header>

      {/* Below lg the filters move to a secondary toolbar so the top bar stays 44px tall. */}
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-panel px-2 py-1.5 sm:px-3 lg:hidden">
        <Filters {...p} />
      </div>
    </>
  );
}
