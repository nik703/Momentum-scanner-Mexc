"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";
import { LiquidationFeed, type LiquidationSnapshot } from "@/lib/liquidationFeed";
import { baseAsset } from "@/lib/symbol";

/**
 * Live cross-exchange forced liquidations (Binance, Bybit, OKX) for the base asset
 * of a MEXC symbol: "SOL_USDT" -> SOL, "1000PEPE_USDT" -> PEPE.
 *
 * One feed per base asset. Its sockets and timers start once `enabled` is true and are all
 * closed when the symbol changes or the drawer unmounts.
 */
export function useCrossExchangeLiquidations(
  symbol: string,
  baseCoin?: string | null,
  /** Start streaming only once the contract is confirmed, so an unknown symbol never opens sockets. */
  enabled = true,
): LiquidationSnapshot {
  const base = baseAsset(baseCoin ? `${baseCoin}_USDT` : symbol);
  const feed = useMemo(() => new LiquidationFeed(base), [base]);

  useEffect(() => {
    if (!enabled) return;
    feed.start();
    return () => feed.stop();
  }, [feed, enabled]);

  return useSyncExternalStore(feed.subscribe, feed.getSnapshot, feed.getSnapshot);
}
