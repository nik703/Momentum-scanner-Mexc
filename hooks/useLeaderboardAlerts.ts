"use client";

import { useEffect, useRef, useState } from "react";
import { LeaderboardAlertEngine } from "@/lib/alerts";
import { playLeaderboardPing } from "@/lib/audio";
import type { Timeframe } from "@/lib/types";

/** How long the NEW badge stays on a row. */
export const NEW_BADGE_MS = 15_000;
/** Chime coalescing window: entries inside it share one chime. */
export const CHIME_COOLDOWN_MS = 1_500;
/** After the drawer closes, ranking frames re-seed silently for this long (plus any catch-up sync). */
export const RESUME_SETTLE_MS = 3_000;
/** Extra silent re-seed time after a catch-up /api/scanner sync lands. */
export const RESYNC_TAIL_MS = 1_500;

interface Options {
  /** Gainers ranked 1..N (symbols), for the active timeframe and volume filter. */
  gainers: readonly string[];
  /** Losers ranked 1..N (symbols). */
  losers: readonly string[];
  timeframe: Timeframe;
  /** 24h volume filter value. Changing it resets the boards silently, like a timeframe change. */
  minVolume: string;
  /** Live socket is CONNECTED. Rankings keep updating silently while it is not. */
  live: boolean;
  pingEnabled: boolean;
  /** Contract Inspection Drawer is open: leaderboard sounds are muted, tracking continues. */
  isDrawerOpen: boolean;
  /** Catch-up /api/scanner sync after closing the drawer is in flight. */
  resyncing?: boolean;
}

export interface LeaderboardAlerts {
  /** symbol -> NEW badge expiry (epoch ms). */
  gainersNew: ReadonlyMap<string, number>;
  losersNew: ReadonlyMap<string, number>;
}

const EMPTY: LeaderboardAlerts = { gainersNew: new Map(), losersNew: new Map() };

/**
 * Top 10 entry alerts with Top 15 hysteresis (engine: LeaderboardAlertEngine in lib/alerts.ts).
 *
 * - Silent seeding: on first hydration and whenever the timeframe or 24h volume filter changes,
 *   `gainersKnownTop15` / `losersKnownTop15` are reset to the current Ranks 1–15 with no sound.
 * - Live evaluation: a symbol in Ranks 1–10 that is not in its board's registry gets a 15s
 *   NEW badge and a chime. One chime plays right away; entries during the next 1.5s share one
 *   trailing chime.
 * - Drawer mute: while `isDrawerOpen`, no leaderboard chime plays (including a pending
 *   trailing one), but both registries keep updating on every tick. Closing the drawer
 *   therefore never replays entries that happened while it was open.
 * - Hysteresis eviction: symbols leave a registry only after their rank goes above 15 or they
 *   are filtered out.
 */
export function useLeaderboardAlerts(o: Options): LeaderboardAlerts {
  const engine = useRef<LeaderboardAlertEngine | null>(null);
  const lastChimeAt = useRef(0);
  const pendingChime = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pingEnabled = useRef(o.pingEnabled);
  const muted = useRef(o.isDrawerOpen);
  const resyncing = useRef(Boolean(o.resyncing));
  const settleUntil = useRef(0);
  const [state, setState] = useState<LeaderboardAlerts>(EMPTY);

  // Declared before the evaluation effect, so a commit that opens the drawer updates the
  // mute flag before that same commit's rank tick is evaluated.
  useEffect(() => {
    pingEnabled.current = o.pingEnabled;
    // Drawer just closed: the next ranking frames are a restore of stale boards followed by
    // fresh ticks and a catch-up sync. They re-seed silently instead of chiming late.
    if (muted.current && !o.isDrawerOpen) settleUntil.current = Date.now() + RESUME_SETTLE_MS;
    // The catch-up sync's own snapshot lands in the same commit that clears `resyncing`, so keep
    // re-seeding silently for a short tail after it ends: the catch-up frame and the first
    // ticker batches after it are part of the restore, not new Top 10 entries.
    if (resyncing.current && !o.resyncing) {
      settleUntil.current = Math.max(settleUntil.current, Date.now() + RESYNC_TAIL_MS);
    }
    muted.current = o.isDrawerOpen;
    resyncing.current = Boolean(o.resyncing);
    if (o.isDrawerOpen && pendingChime.current) {
      clearTimeout(pendingChime.current);
      pendingChime.current = null;
    }
  }, [o.pingEnabled, o.isDrawerOpen, o.resyncing]);

  useEffect(
    () => () => {
      if (pendingChime.current) clearTimeout(pendingChime.current);
    },
    [],
  );

  useEffect(() => {
    engine.current ??= new LeaderboardAlertEngine();
    if (!muted.current && (resyncing.current || Date.now() < settleUntil.current)) {
      if (o.gainers.length || o.losers.length) engine.current.reseed(o.gainers, o.losers);
      return;
    }
    const d = engine.current.tick({
      gainers: o.gainers,
      losers: o.losers,
      contextKey: `${o.timeframe}|${o.minVolume}`,
      live: o.live,
      muted: muted.current,
    });
    if (d.reseeded) {
      setState(EMPTY);
      return;
    }
    if (d.gainers.length === 0 && d.losers.length === 0) return;

    const now = Date.now();
    setState((s) => ({
      gainersNew: withBadges(s.gainersNew, d.gainers, now),
      losersNew: withBadges(s.losersNew, d.losers, now),
    }));

    if (!d.audible || !pingEnabled.current) return;
    const since = now - lastChimeAt.current;
    if (since >= CHIME_COOLDOWN_MS) {
      lastChimeAt.current = now;
      playLeaderboardPing();
    } else if (!pendingChime.current) {
      pendingChime.current = setTimeout(() => {
        pendingChime.current = null;
        if (!pingEnabled.current || muted.current) return; // drawer may have opened meanwhile
        lastChimeAt.current = Date.now();
        playLeaderboardPing();
      }, CHIME_COOLDOWN_MS - since);
    }
  }, [o.gainers, o.losers, o.timeframe, o.minVolume, o.live]);

  return state;
}

function withBadges(prev: ReadonlyMap<string, number>, add: readonly string[], now: number) {
  const next = new Map<string, number>();
  for (const [sym, exp] of prev) if (exp > now) next.set(sym, exp);
  for (const sym of add) next.set(sym, now + NEW_BADGE_MS);
  return next;
}
