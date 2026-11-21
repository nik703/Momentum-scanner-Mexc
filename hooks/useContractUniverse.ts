"use client";

import { useCallback, useSyncExternalStore } from "react";
import type { UniverseItem } from "@/lib/types";

interface UniverseState {
  status: "idle" | "loading" | "ready" | "error";
  items: readonly UniverseItem[];
}

const REFRESH_MS = 5 * 60_000;

// Shared module-level store: every lookup box reuses one list, fetched on first focus.
let state: UniverseState = { status: "idle", items: [] };
let loadedAt = 0;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function set(next: UniverseState) {
  state = next;
  for (const l of listeners) l();
}

function load(): Promise<void> {
  if (inflight) return inflight;
  if (state.status === "ready" && Date.now() - loadedAt < REFRESH_MS) return Promise.resolve();
  if (state.status !== "ready") set({ ...state, status: "loading" });
  inflight = fetch("/api/symbols", { signal: AbortSignal.timeout(15_000) })
    .then(async (r) => {
      const body: unknown = await r.json().catch(() => null);
      if (!r.ok || !Array.isArray(body)) throw new Error(`HTTP ${r.status}`);
      const items = body.filter(
        (x): x is UniverseItem =>
          typeof x === "object" && x !== null && typeof (x as UniverseItem).symbol === "string",
      );
      loadedAt = Date.now();
      set({ status: "ready", items });
    })
    .catch(() => {
      // Keep any earlier list. Otherwise surface the error; the next focus retries.
      set({ status: state.items.length ? "ready" : "error", items: state.items });
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};
const getSnapshot = () => state;

/** Every active MEXC *_USDT perpetual (loaded lazily; call `ensure()` on focus). */
export function useContractUniverse() {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const ensure = useCallback(() => void load(), []);
  return { ...snap, ensure };
}

/** Ranks lookup matches: exact base, then prefix, then substring; ties go to higher 24h turnover. */
export function searchUniverse(items: readonly UniverseItem[], query: string, limit = 8): UniverseItem[] {
  const q = query.toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/USDT$/, "");
  if (!q) return [];
  const exact: UniverseItem[] = [];
  const prefix: UniverseItem[] = [];
  const contains: UniverseItem[] = [];
  for (const it of items) {
    const base = it.symbol.replace(/_USDT$/, "");
    if (base === q) exact.push(it);
    else if (base.startsWith(q)) prefix.push(it);
    else if (base.includes(q)) contains.push(it);
  }
  // items arrive sorted by turnover, so each bucket keeps that order
  return [...exact, ...prefix, ...contains].slice(0, limit);
}
