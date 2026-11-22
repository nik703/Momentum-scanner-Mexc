"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { mexcSocket } from "@/lib/mexcSocket";
import type { SocketStatus } from "@/lib/reconnectingSocket";
import { ScannerStore, type WsTicker } from "@/lib/store";
import type { BootstrapPayload, WsStatus } from "@/lib/types";

const RECONCILE_MS = 60_000;
/** On leaving focus mode, catch up with one immediate sync if the last one is older than this. */
const RESUME_STALE_MS = 45_000;
const FETCH_TIMEOUT_MS = 20_000;

function isBootstrapPayload(v: unknown): v is BootstrapPayload {
  if (typeof v !== "object" || v === null) return false;
  const p = v as Partial<BootstrapPayload>;
  return typeof p.generatedAt === "number" && Array.isArray(p.symbols);
}

async function fetchBootstrap(signal: AbortSignal): Promise<BootstrapPayload> {
  // Caller abort + timeout without AbortSignal.any (missing on iOS Safari < 17.4).
  const ctrl = new AbortController();
  let timedOut = false;
  const onAbort = () => ctrl.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch("/api/scanner", { cache: "no-store", signal: ctrl.signal });
  } catch (e) {
    if (signal.aborted) throw e;
    throw new Error(timedOut ? "Bootstrap request timed out" : "Network unavailable");
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const detail =
      typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
        ? body.error
        : `HTTP ${res.status}`;
    throw new Error(`Bootstrap failed: ${detail}`);
  }
  if (!isBootstrapPayload(body) || body.symbols.length === 0) throw new Error("Bootstrap returned no contracts");
  return body;
}

function toWsStatus(s: SocketStatus, everOpen: boolean): WsStatus {
  if (s === "open") return "CONNECTED";
  return everOpen ? "RECONNECTING" : "CONNECTING";
}

export interface ScannerState {
  snap: ReturnType<ScannerStore["getSnapshot"]>;
  /** True from drawer close until the catch-up sync (if one was needed) has landed. */
  resyncing: boolean;
}

/**
 * Multi-coin scanner data: /api/scanner bootstrap + 60s background sync + the market-wide
 * `sub.tickers` stream, all on the shared MEXC multiplexer.
 *
 * `focusSymbol` (the drawer's contract) switches the app into Single-Coin Focus Mode:
 *  - the multiplexer swaps sub.tickers for that contract's sub.ticker/kline/deal
 *  - the 60s /api/scanner interval is cleared, in-flight syncs are aborted, and no visibility,
 *    online or reconnect sync runs
 *  - the store is paused (no 250ms flush, no leaderboard re-sort or re-render)
 * Leaving focus resubscribes sub.tickers, runs one catch-up sync if the last one is older than 45s,
 * and restarts the interval.
 */
export function useScanner(focusSymbol: string | null): ScannerState {
  const [store] = useState(() => new ScannerStore());
  const [resyncing, setResyncing] = useState(false);
  const focused = focusSymbol !== null;
  const focusedRef = useRef(focused);
  const lastFetchAt = useRef(0);
  const ctl = useRef<{ reconcile: () => Promise<void>; startPolling: () => void; stopPolling: () => void } | null>(null);

  // ---- lifecycle: bootstrap, stream listeners, polling (mount/unmount) ----
  useEffect(() => {
    let disposed = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    let inflight: AbortController | null = null;
    let attempts = 0;
    let everOpen = false;
    let hydrated = false;

    const offMsg = mexcSocket.addListener((m) => {
      if (m.channel === "push.tickers" && Array.isArray(m.data)) store.applyTickers(m.data as WsTicker[]);
    });
    const offStatus = mexcSocket.onStatus((s) => {
      if (s === "open") everOpen = true;
      store.setStatus(toWsStatus(s, everOpen));
    });
    const offConnected = mexcSocket.onConnected((reconnect) => {
      if (reconnect && hydrated && !focusedRef.current) void reconcile();
    });

    async function reconcile() {
      if (focusedRef.current || disposed) return; // never fetch multi-coin data in focus mode
      inflight?.abort();
      const ctrl = new AbortController();
      inflight = ctrl;
      try {
        const p = await fetchBootstrap(ctrl.signal);
        lastFetchAt.current = Date.now();
        if (!disposed && !ctrl.signal.aborted) store.applyBootstrap(p);
      } catch {
        /* silent: live data keeps flowing; next tick retries */
      } finally {
        if (inflight === ctrl) inflight = null;
      }
    }

    function startPolling() {
      if (poll || disposed || !hydrated) return;
      poll = setInterval(() => void reconcile(), RECONCILE_MS);
    }
    function stopPolling() {
      if (poll) clearInterval(poll);
      poll = null;
      inflight?.abort(); // a sync started before focus must not land on the paused boards
      inflight = null;
    }

    async function hydrate() {
      if (focusedRef.current) {
        retry = setTimeout(hydrate, 1000); // opened a coin before the first load; wait for close
        return;
      }
      const ctrl = new AbortController();
      inflight = ctrl;
      try {
        const p = await fetchBootstrap(ctrl.signal);
        lastFetchAt.current = Date.now();
        if (disposed || ctrl.signal.aborted) return;
        store.applyBootstrap(p);
        hydrated = true;
        if (!focusedRef.current) startPolling();
      } catch (e) {
        if (disposed || ctrl.signal.aborted) {
          if (!disposed) retry = setTimeout(hydrate, 500);
          return;
        }
        store.setError(e instanceof Error ? e.message : "Bootstrap failed");
        retry = setTimeout(hydrate, Math.min(30_000, 1500 * 2 ** attempts++));
      } finally {
        if (inflight === ctrl) inflight = null;
      }
    }

    function onVisible() {
      if (document.visibilityState !== "visible" || !hydrated || focusedRef.current) return;
      void reconcile();
    }

    ctl.current = { reconcile, startPolling, stopPolling };
    store.start();
    void hydrate();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onVisible);

    return () => {
      disposed = true;
      ctl.current = null;
      if (retry) clearTimeout(retry);
      stopPolling();
      offMsg();
      offStatus();
      offConnected();
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onVisible);
      store.stop();
    };
  }, [store]);

  // ---- focus mode switching (single owner of the multiplexer mode) ----
  useEffect(() => {
    const wasFocused = focusedRef.current;
    focusedRef.current = focused;
    // Diffed on the shared socket: unsub.tickers -> sub.ticker/kline/deal(symbol); on a switch,
    // unsub prev -> sub next; on close, unsub symbol -> sub.tickers.
    mexcSocket.setFocus(focusSymbol);

    const c = ctl.current;
    if (focused) {
      c?.stopPolling();
      store.pause();
      return;
    }
    store.resume();
    if (wasFocused && c) {
      const stale = Date.now() - lastFetchAt.current > RESUME_STALE_MS;
      if (stale) {
        // Flag the catch-up for the alert engine. setState runs in callbacks, not the effect body.
        queueMicrotask(() => setResyncing(true));
        void c.reconcile().finally(() => {
          setResyncing(false);
          if (!focusedRef.current) c.startPolling(); // the drawer may have reopened meanwhile
        });
        return;
      }
      c.startPolling();
    }
  }, [focused, focusSymbol, store]);

  const snap = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return { snap, resyncing };
}
