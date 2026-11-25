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
const BOOL = ["true", "false"] as const;

export function useThemeSetting() {
  return usePersistentState<Theme>("mx-theme", "dark", THEMES);
}

export function useRowLimitSetting() {
  return usePersistentState<RowLimit>("mx-limit", "25", ROW_LIMITS);
}

/* ------------------------------------------------------------------ */
/* Audio volume: one level shared by both cogs, all pings and auditions */
/* ------------------------------------------------------------------ */
export const DEFAULT_VOLUME = 75;
const VOLUME_VALUES = Array.from({ length: 101 }, (_, i) => String(i)) as readonly string[];
const PREV_VALUES = VOLUME_VALUES.slice(1);
const VOLUME_KEY = "mexc_audio_volume";
const PREV_VOLUME_KEY = "mexc_audio_prev_volume";

const clampVol = (v: number) => Math.min(100, Math.max(0, Math.round(Number.isFinite(v) ? v : 0)));

export interface AudioVolume {
  /** 0..100. 0 = muted. */
  volume: number;
  /** Last non-zero volume (1..100), restored by unmute. */
  prevVolume: number;
  /** Sets the volume. Any value > 0 also becomes the remembered unmute level. */
  setVolume: (v: number) => void;
  /** Mute (remembering the level) or unmute (restoring it, or 75). */
  toggleMute: () => void;
  /** Level for Test / Long / Short previews: the current volume, or the remembered one when muted. */
  auditionVolume: number;
}

export function useAudioVolume(): AudioVolume {
  const [vRaw, setVRaw] = usePersistentState(VOLUME_KEY, String(DEFAULT_VOLUME), VOLUME_VALUES);
  const [pRaw, setPRaw] = usePersistentState(PREV_VOLUME_KEY, String(DEFAULT_VOLUME), PREV_VALUES);
  const volume = Number(vRaw);
  const prevVolume = Number(pRaw);
  const setVolume = (v: number) => {
    const c = clampVol(v);
    setVRaw(String(c));
    if (c > 0) setPRaw(String(c));
  };
  const toggleMute = () => {
    if (volume > 0) {
      setPRaw(String(volume));
      setVRaw("0");
    } else {
      setVRaw(String(prevVolume > 0 ? prevVolume : DEFAULT_VOLUME));
    }
  };
  return { volume, prevVolume, setVolume, toggleMute, auditionVolume: volume > 0 ? volume : prevVolume || 50 };
}

/**
 * One-time migration from the old ON/OFF switches. Someone who explicitly turned the Top 10 ping
 * OFF (and never enabled liquidation pings) starts muted, with 75 remembered for unmute.
 * Everyone else gets the default volume.
 */
export function migrateLegacyAudio(): void {
  try {
    const ls = window.localStorage;
    if (ls.getItem(VOLUME_KEY) !== null) return;
    if (ls.getItem("mx-ping") === "off" && ls.getItem("mexc_liq_ping") !== "on") {
      ls.setItem(VOLUME_KEY, "0");
      ls.setItem(PREV_VOLUME_KEY, String(DEFAULT_VOLUME));
    }
  } catch {
    /* storage blocked */
  }
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
