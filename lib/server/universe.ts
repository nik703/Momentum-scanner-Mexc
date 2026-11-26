import { fetchUniverse } from "../mexc.ts";
import type { UniverseItem } from "../types.ts";

/**
 * Per-instance cache of MEXC's active *_USDT perpetuals, shared by /api/symbols and the contract
 * route's allowlist. Refreshed at most every 60s, concurrent callers share one in-flight request,
 * and the last good list is kept for 10 minutes if MEXC blips.
 */
const FRESH_MS = 60_000;
const STALE_OK_MS = 10 * 60_000;
/** A symbol missing from the list triggers at most one early refresh per this interval (new listings). */
const MISS_REFRESH_MS = 15_000;

interface UniverseCache {
  at: number;
  items: UniverseItem[];
  set: ReadonlySet<string>;
}
let cache: UniverseCache | null = null;
let inflight: Promise<UniverseCache> | null = null;

function refresh(): Promise<UniverseCache> {
  inflight ??= fetchUniverse()
    .then((items): UniverseCache => {
      const next: UniverseCache = { at: Date.now(), items, set: new Set(items.map((i) => i.symbol)) };
      cache = next;
      return next;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export async function getUniverse(): Promise<UniverseItem[]> {
  if (cache && Date.now() - cache.at < FRESH_MS) return cache.items;
  try {
    return (await refresh()).items;
  } catch (e) {
    if (cache && Date.now() - cache.at < STALE_OK_MS) return cache.items;
    throw e;
  }
}

/**
 * "listed" / "unlisted" against the active-contract list, or "unknown" when the list can't be
 * loaded (the route then falls back to asking MEXC directly, so an outage never blocks the drawer).
 */
export async function contractListing(symbol: string): Promise<"listed" | "unlisted" | "unknown"> {
  try {
    await getUniverse();
  } catch {
    if (!cache) return "unknown";
  }
  if (cache!.set.has(symbol)) return "listed";
  if (Date.now() - cache!.at > MISS_REFRESH_MS) {
    try {
      if ((await refresh()).set.has(symbol)) return "listed";
    } catch {
      /* keep the existing answer */
    }
  }
  return "unlisted";
}
