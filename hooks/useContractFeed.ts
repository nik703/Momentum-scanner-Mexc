"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";
import { ContractFeed, type ContractSnapshot } from "@/lib/contractFeed";

/**
 * REST hydrate + live MEXC kline/deal/ticker stream for one contract.
 * A new feed is created per symbol. Switching symbol or closing the drawer runs stop(),
 * which sends unsub.kline / unsub.deal / unsub.ticker before closing the socket.
 */
export function useContractFeed(symbol: string): ContractSnapshot {
  const feed = useMemo(() => new ContractFeed(symbol), [symbol]);

  useEffect(() => {
    feed.start();
    return () => feed.stop();
  }, [feed]);

  return useSyncExternalStore(feed.subscribe, feed.getSnapshot, feed.getSnapshot);
}
