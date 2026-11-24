"use client";

import { TIMEFRAMES, type Timeframe } from "@/lib/types";
import { ContractLookup } from "./ContractLookup";
import { ROW_LIMITS, THEMES, type RowLimit, type Theme } from "@/hooks/useAppSettings";
import { SettingsAction, SettingsDivider, SettingsPopover, SettingsRow, SettingsSwitch } from "./SettingsPopover";
import { Kbd, SegmentedControl } from "./ui/primitives";

export const MIN_VOLUMES = ["0", "1000000", "5000000", "25000000"] as const;
export type MinVolume = (typeof MIN_VOLUMES)[number];
const MIN_VOL_OPTS = [
  { value: "0", label: "All" },
  { value: "1000000", label: ">$1M" },
  { value: "5000000", label: ">$5M" },
  { value: "25000000", label: ">$25M" },
] as const satisfies ReadonlyArray<{ value: MinVolume; label: string }>;

export { ROW_LIMITS, type RowLimit, type Theme };
const LIMIT_OPTS = [
  { value: "25", label: "Top 25" },
  { value: "50", label: "Top 50" },
  { value: "all", label: "All" },
] as const satisfies ReadonlyArray<{ value: RowLimit; label: string }>;

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
  onTheme: (t: Theme) => void;
  pingOn: boolean;
  onPing: (on: boolean) => void;
  onTestPing: () => void;
  onOpenContract: (symbol: string) => void;
  /** Single-coin focus mode (drawer open): the lookup never hits the network. */
  focused: boolean;
}

function Filters(
  p: Pick<Props, "minVolume" | "onMinVolume" | "query" | "onQuery" | "onOpenContract" | "focused">,
) {
  return (
    <>
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] font-medium uppercase tracking-wider text-fg-3">24h Vol</span>
        <SegmentedControl label="Minimum 24h volume" value={p.minVolume} onChange={p.onMinVolume} options={MIN_VOL_OPTS} mono />
      </div>
      <ContractLookup
        query={p.query}
        onQuery={p.onQuery}
        onOpenContract={p.onOpenContract}
        focused={p.focused}
        className="min-w-[8rem] flex-1 lg:w-52 lg:flex-none"
      />
    </>
  );
}

export function TerminalHeader(p: Props) {
  return (
    <>
      <header className="sticky top-0 z-20 flex h-[44px] sm:z-50 items-center gap-2 border-b border-line bg-panel px-2 sm:gap-3 sm:px-3">
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

        <div className="ml-auto flex shrink-0 items-center">
          {/* Theme, Top 10 ping and leaderboard depth live in the cog; live filters stay in the bar. */}
          <SettingsPopover label="Scanner settings" testId="main-settings">
            <SettingsRow label="Theme" hint="Shortcut: T">
              <SegmentedControl
                label="Theme"
                value={p.theme}
                onChange={p.onTheme}
                options={THEMES.map((t) => ({ value: t, label: t === "dark" ? "Dark" : "Light" }))}
                compact
              />
            </SettingsRow>
            <SettingsDivider />
            <SettingsRow label="Top 10 ping" hint="Chime when a contract enters the Top 10 from outside the Top 15">
              <SettingsSwitch label="Top 10 entry ping" testId="set-top-ping" checked={p.pingOn} onChange={p.onPing} />
              <SettingsAction label="Play test chime (also unlocks browser audio)" testId="test-ping" onClick={p.onTestPing}>
                Test
              </SettingsAction>
            </SettingsRow>
            <SettingsDivider />
            <SettingsRow label="Depth">
              <SegmentedControl label="Leaderboard depth" value={p.limit} onChange={p.onLimit} options={LIMIT_OPTS} compact />
            </SettingsRow>
          </SettingsPopover>
        </div>
      </header>

      {/* Below lg the filters move to a secondary toolbar so the top bar stays 44px tall. */}
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-panel px-2 py-1.5 sm:px-3 lg:hidden">
        <Filters {...p} />
      </div>
    </>
  );
}
