"use client";

import { useEffect, useRef, useState } from "react";
import { Top15Tracker } from "@/lib/alerts";
import { playChime } from "@/lib/audio";
import type { Timeframe } from "@/lib/types";

/** How long a NEW tag stays visible. */
export const NEW_TAG_MS = 60_000;
/** A symbol cannot re-ping on the same board within this window. */
const SYMBOL_COOLDOWN_MS = 180_000;
/** Minimum spacing between audible chimes (bursts collapse into one). */
const CHIME_GAP_MS = 1_500;
/** After (re)seeding, rankings settle silently for this long. */
const SETTLE_MS = 4_000;

interface Options {
  gainers: readonly string[];
  losers: readonly string[];
  timeframe: Timeframe;
  /** Anything that changes the ranked universe (liquidity filter) - reseeds silently. */
  scopeKey: string;
  /** Live data is flowing (socket CONNECTED + hydrated). */
  live: boolean;
  pingEnabled: boolean;
}

export interface AlertState {
  /** symbol -> NEW-tag expiry epoch ms, per board. */
  gainersNew: ReadonlyMap<string, number>;
  losersNew: ReadonlyMap<string, number>;
}

/**
 * Top 10 entry alerts with Top 15 hysteresis.
 *
 * Suppression rules:
 *  - Registries seed silently on first live data, on timeframe switch, and on
 *    liquidity-filter change, then stay quiet for a short settle window.
 *  - While the socket is not CONNECTED registries keep tracking silently so a
 *    reconnect never produces a burst of stale "entries".
 *  - A contract re-arms only after it leaves the Top 15 (see Top15Tracker), and
 *    each board enforces a per-symbol cooldown.
 *  - Chimes are rate-limited globally; simultaneous entries play once.
 *  - Search text and row-count do NOT affect ranking, so they never trigger.
 */
export function useLeaderboardAlerts(o: Options): AlertState {
  const gT = useRef(new Top15Tracker());
  const lT = useRef(new Top15Tracker());
  const scope = useRef("");
  const seededAt = useRef(0);
  const lastChime = useRef(0);
  const cooldown = useRef(new Map<string, number>());
  const [state, setState] = useState<AlertState>({ gainersNew: new Map(), losersNew: new Map() });

  useEffect(() => {
    const now = Date.now();
    const key = `${o.timeframe}|${o.scopeKey}`;
    if (key !== scope.current) {
      scope.current = key;
      gT.current.reset();
      lT.current.reset();
      seededAt.current = now;
      setState((s) => (s.gainersNew.size || s.losersNew.size ? { gainersNew: new Map(), losersNew: new Map() } : s));
    }
    if (!o.gainers.length && !o.losers.length) return;

    const gEntered = gT.current.update(o.gainers);
    const lEntered = lT.current.update(o.losers);
    if (!o.live || now - seededAt.current < SETTLE_MS) return;

    const accept = (board: "g" | "l", syms: string[]) =>
      syms.filter((s) => {
        const k = `${board}:${o.timeframe}:${s}`;
        if ((cooldown.current.get(k) ?? 0) > now) return false;
        cooldown.current.set(k, now + SYMBOL_COOLDOWN_MS);
        return true;
      });
    const g = accept("g", gEntered);
    const l = accept("l", lEntered);
    if (!g.length && !l.length) return;

    setState((s) => {
      const prune = (m: ReadonlyMap<string, number>, add: string[]) => {
        const next = new Map<string, number>();
        for (const [k, v] of m) if (v > now) next.set(k, v);
        for (const sym of add) next.set(sym, now + NEW_TAG_MS);
        return next;
      };
      return { gainersNew: prune(s.gainersNew, g), losersNew: prune(s.losersNew, l) };
    });

    if (o.pingEnabled && now - lastChime.current >= CHIME_GAP_MS) {
      lastChime.current = now;
      playChime();
    }
  }, [o.gainers, o.losers, o.timeframe, o.scopeKey, o.live, o.pingEnabled]);

  return state;
}
