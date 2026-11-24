"use client";

import { usePersistentState } from "./usePersistentState";

/**
 * Every user-facing toggle, persisted in localStorage. They are shared stores, so the main-page
 * cog, the drawer cog and the chart all see the same value instantly.
 */
export const THEMES = ["dark", "light"] as const;
export type Theme = (typeof THEMES)[number];
export const ROW_LIMITS = ["25", "50", "all"] as const;
export type RowLimit = (typeof ROW_LIMITS)[number];
const ON_OFF = ["on", "off"] as const;
const BOOL = ["true", "false"] as const;

export function useThemeSetting() {
  return usePersistentState<Theme>("mx-theme", "dark", THEMES);
}

export function useRowLimitSetting() {
  return usePersistentState<RowLimit>("mx-limit", "25", ROW_LIMITS);
}

/** Top 10 leaderboard entry ping (main page). Default OFF. */
export function useTopPingSetting(): [boolean, (v: boolean) => void] {
  const [v, set] = usePersistentState("mx-ping", "off", ON_OFF);
  return [v === "on", (b: boolean) => set(b ? "on" : "off")];
}

/** Live LONG/SHORT liquidation pings inside the drawer. Default OFF (opt-in, like the Top 10 ping). */
export function useLiqPingSetting(): [boolean, (v: boolean) => void] {
  const [v, set] = usePersistentState("mexc_liq_ping", "off", ON_OFF);
  return [v === "on", (b: boolean) => set(b ? "on" : "off")];
}

function useBoolSetting(key: string, defaultOn: boolean): [boolean, (v: boolean) => void] {
  const [v, set] = usePersistentState(key, defaultOn ? "true" : "false", BOOL);
  return [v === "true", (b: boolean) => set(b ? "true" : "false")];
}

/** Liquidation bars drawn over the chart's volume bars. Default ON. */
export const useLiqOverlaySetting = () => useBoolSetting("mexc_chart_liq_overlay", true);
/** Smoothed (gap-free Heikin-Ashi) 10S/1S candles. Default ON. */
export const useSmoothSetting = () => useBoolSetting("mexc_chart_smooth", true);
/** Large background price watermark behind the candles. Default ON. */
export const useBgPriceSetting = () => useBoolSetting("mexc_chart_bg_price", true);
