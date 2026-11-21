"use client";

import { useEffect, useRef, useState } from "react";
import { evaluateTop10Entries, seedKnownTop15 } from "@/lib/alerts";
import { playChime } from "@/lib/audio";
import type { Timeframe } from "@/lib/types";

/** How long the NEW badge stays on a row. */
export const NEW_BADGE_MS = 15_000;
/** Chime coalescing window: entries inside it share one chime. */
export const CHIME_COOLDOWN_MS = 1_500;

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
}

export interface LeaderboardAlerts {
  /** symbol -> NEW badge expiry (epoch ms). */
  gainersNew: ReadonlyMap<string, number>;
  losersNew: ReadonlyMap<string, number>;
}

const EMPTY: LeaderboardAlerts = { gainersNew: new Map(), losersNew: new Map() };

/**
 * Top 10 entry alerts with Top 15 hysteresis (see lib/alerts.ts).
 *
 * - Silent seeding: on first hydration and whenever the timeframe or 24h
 *   volume filter changes, both registries are reset to the current Ranks 1–15
 *   with no sound.
 * - Live evaluation: a symbol in Ranks 1–10 that is not in its board's
 *   registry gets a 15s NEW badge and a chime. Chimes are coalesced: one plays
 *   right away, and entries during the next 1.5s share one trailing chime.
 * - Hysteresis eviction: symbols leave a registry only after their rank goes
 *   above 15 or they are filtered out.
 */
export function useLeaderboardAlerts(o: Options): LeaderboardAlerts {
  const gainersKnownTop15 = useRef(new Set<string>());
  const losersKnownTop15 = useRef(new Set<string>());
  const contextKey = useRef<string | null>(null);
  const lastChimeAt = useRef(0);
  const pendingChime = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pingEnabled = useRef(o.pingEnabled);
  const [state, setState] = useState<LeaderboardAlerts>(EMPTY);

  useEffect(() => {
    pingEnabled.current = o.pingEnabled;
  }, [o.pingEnabled]);

  useEffect(
    () => () => {
      if (pendingChime.current) clearTimeout(pendingChime.current);
    },
    [],
  );

  useEffect(() => {
    if (o.gainers.length === 0 && o.losers.length === 0) return; // not hydrated yet

    const key = `${o.timeframe}|${o.minVolume}`;
    if (contextKey.current !== key) {
      contextKey.current = key;
      seedKnownTop15(gainersKnownTop15.current, o.gainers);
      seedKnownTop15(losersKnownTop15.current, o.losers);
      setState(EMPTY);
      return;
    }

    const g = evaluateTop10Entries(gainersKnownTop15.current, o.gainers);
    const l = evaluateTop10Entries(losersKnownTop15.current, o.losers);
    if (!o.live || (g.length === 0 && l.length === 0)) return;

    const now = Date.now();
    setState((s) => ({
      gainersNew: withBadges(s.gainersNew, g, now),
      losersNew: withBadges(s.losersNew, l, now),
    }));

    if (!pingEnabled.current) return;
    const since = now - lastChimeAt.current;
    if (since >= CHIME_COOLDOWN_MS) {
      lastChimeAt.current = now;
      playChime();
    } else if (!pendingChime.current) {
      pendingChime.current = setTimeout(() => {
        pendingChime.current = null;
        lastChimeAt.current = Date.now();
        if (pingEnabled.current) playChime();
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
