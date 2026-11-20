"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { ScannerStore } from "@/lib/store";
import { MexcTickerSocket } from "@/lib/ws";
import type { BootstrapPayload } from "@/lib/types";

const RECONCILE_MS = 60_000;

const FETCH_TIMEOUT_MS = 20_000;

function isBootstrapPayload(v: unknown): v is BootstrapPayload {
  if (typeof v !== "object" || v === null) return false;
  const p = v as Partial<BootstrapPayload>;
  return typeof p.generatedAt === "number" && Array.isArray(p.symbols);
}

async function fetchBootstrap(): Promise<BootstrapPayload> {
  let res: Response;
  try {
    res = await fetch("/api/scanner", { cache: "no-store", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (e) {
    const timedOut = e instanceof DOMException && e.name === "TimeoutError";
    throw new Error(timedOut ? "Bootstrap request timed out" : "Network unavailable");
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
