"use client";

import { useEffect, useMemo, useRef, useSyncExternalStore, type RefObject } from "react";
import { playLongLiqPing, playShortLiqPing } from "@/lib/audio";
import { LiquidationFeed, type LiquidationSnapshot } from "@/lib/liquidationFeed";
import { selectLivePings } from "@/lib/liquidations";
import { baseAsset } from "@/lib/symbol";

interface Options {
  /** Start streaming only once the contract is confirmed, so an unknown symbol never opens sockets. */
  enabled: boolean;
  /** Shared 0..100 alert volume (0 = muted). */
  volume: number;
  /**
   * When the drawer opened for this contract (epoch ms). Only events received at or after it
   * produce a ping. Switching contracts remounts the drawer, which resets it.
   */
  drawerOpenedAtRef: RefObject<number>;
}

/**
 * Live cross-exchange forced liquidations (Binance, Bybit, OKX) for the base asset of a MEXC
 * symbol: "SOL_USDT" -> SOL, "1000PEPE_USDT" -> PEPE.
 *
 * One feed per base asset. Sockets and timers start once `enabled` is true and are all closed
 * when the symbol changes or the drawer unmounts. When sound is on, each new live event plays a
 * directional ping: LONG LIQ -> playLongLiqPing (descending), SHORT LIQ -> playShortLiqPing
 * (ascending). The 90ms cadence limiter in lib/audio.ts paces bursts.
 */
export function useCrossExchangeLiquidations(
  symbol: string,
  baseCoin: string | null | undefined,
  { enabled, volume, drawerOpenedAtRef }: Options,
): LiquidationSnapshot {
  const base = baseAsset(baseCoin ? `${baseCoin}_USDT` : symbol);
  const feed = useMemo(() => new LiquidationFeed(base), [base]);
  const volumeRef = useRef(volume);

  useEffect(() => {
    volumeRef.current = volume;
  }, [volume]);

  useEffect(() => {
    if (!enabled) return;
    // Arm no earlier than the moment this feed starts, even if the ref hasn't been set yet.
    const armedAt = Math.max(drawerOpenedAtRef.current, Date.now());
    const off = feed.onEvents((events) => {
      const v = volumeRef.current;
      for (const side of selectLivePings(events, armedAt, v > 0)) {
        if (side === "LONG") playLongLiqPing(v);
        else playShortLiqPing(v);
      }
    });
    feed.start();
    return () => {
      off();
      feed.stop();
    };
  }, [feed, enabled, drawerOpenedAtRef]);

  return useSyncExternalStore(feed.subscribe, feed.getSnapshot, feed.getSnapshot);
}
