"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { ScannerStore } from "@/lib/store";
import { MexcTickerSocket } from "@/lib/ws";
import type { BootstrapPayload } from "@/lib/types";

const RECONCILE_MS = 60_000;

async function fetchBootstrap(): Promise<BootstrapPayload> {
  const res = await fetch("/api/scanner", { cache: "no-store" });
  if (!res.ok) throw new Error(`Bootstrap failed (HTTP ${res.status})`);
  return (await res.json()) as BootstrapPayload;
}

/**
 * Wires the bootstrap REST call, the live MEXC ticker socket, and the 60s
 * background reconcile into a single external store.
 */
export function useScanner() {
  const [store] = useState(() => new ScannerStore());

  useEffect(() => {
    let disposed = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let reconcileTimer: ReturnType<typeof setInterval> | null = null;
    let attempts = 0;

    const socket = new MexcTickerSocket({
      onTickers: (t) => store.applyTickers(t),
      onStatus: (s) => store.setStatus(s),
      onReconnected: () => void reconcile(),
    });

    async function reconcile() {
      try {
        const p = await fetchBootstrap();
        if (!disposed) store.applyBootstrap(p);
      } catch {
        /* silent: live WS data keeps flowing, next tick retries */
      }
    }

    async function hydrate() {
      try {
        const p = await fetchBootstrap();
        if (disposed) return;
        store.applyBootstrap(p);
        socket.connect();
        reconcileTimer = setInterval(reconcile, RECONCILE_MS);
      } catch (e) {
        if (disposed) return;
        store.setError(e instanceof Error ? e.message : "Bootstrap failed");
        const delay = Math.min(30_000, 1500 * 2 ** attempts++);
        retry = setTimeout(hydrate, delay);
      }
    }

    function onVisible() {
      if (document.visibilityState !== "visible" || !store.hasData) return;
      socket.nudge();
      void reconcile();
    }

    store.start();
    void hydrate();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onVisible);

    return () => {
      disposed = true;
      if (retry) clearTimeout(retry);
      if (reconcileTimer) clearInterval(reconcileTimer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onVisible);
      socket.close();
      store.stop();
    };
  }, [store]);

  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
