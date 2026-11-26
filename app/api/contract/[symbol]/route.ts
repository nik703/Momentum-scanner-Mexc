import { fetchContractDetail, MexcError } from "@/lib/mexc";
import { UpstreamError } from "@/lib/server/upstream";
import { clientKey, hasQuery, jsonError, RateLimiter, rejectQuery, tooMany } from "@/lib/server/http";
import { contractListing } from "@/lib/server/universe";
import { isContractSymbol } from "@/lib/symbol";
import type { ContractDetail } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

const CACHE_OK = "public, s-maxage=5, stale-while-revalidate=10";
// Negative answers are cached briefly too, so a typo can't hammer MEXC.
const CACHE_404 = "public, s-maxage=30, stale-while-revalidate=60";
const CACHE_400 = "public, s-maxage=300";

/** Concurrent / repeated requests for one symbol share one upstream fetch for this long. */
const DETAIL_MEMO_MS = 2_000;
const DETAIL_MEMO_MAX = 256;
const detailMemo = new Map<string, { at: number; p: Promise<ContractDetail> }>();

/** Per client: 40 drawer opens in a burst, then 2/s. Only CDN misses reach this. */
const limiter = new RateLimiter(40, 2);

function getDetail(symbol: string): Promise<ContractDetail> {
  const now = Date.now();
  const hit = detailMemo.get(symbol);
  if (hit && now - hit.at < DETAIL_MEMO_MS) return hit.p;
  if (detailMemo.size >= DETAIL_MEMO_MAX) {
    for (const [k, v] of detailMemo) if (now - v.at >= DETAIL_MEMO_MS) detailMemo.delete(k);
    if (detailMemo.size >= DETAIL_MEMO_MAX) detailMemo.delete(detailMemo.keys().next().value!);
  }
  const p = fetchContractDetail(symbol);
  detailMemo.set(symbol, { at: now, p });
  p.catch(() => detailMemo.delete(symbol)); // failures are not memoized
  return p;
}

/**
 * Contract detail for the Inspection Drawer.
 * Security: `symbol` must already be canonical (/^[A-Z0-9]{1,20}_USDT$/). Lowercase, aliases,
 * percent-encoded or traversal forms get a 400 before any outbound request. Valid-looking symbols
 * that MEXC doesn't list get a 404 from a cached allowlist, so random-symbol enumeration and
 * `?cb=` cache-busting can't be turned into upstream traffic.
 */
export async function GET(req: Request, ctx: { params: Promise<{ symbol: string }> }) {
  if (hasQuery(req)) return rejectQuery();
  const { symbol } = await ctx.params;
  // No decodeURIComponent: the router decodes once; a second decode would accept %255F-style smuggling.
  if (!isContractSymbol(symbol)) {
    return jsonError(400, "Invalid symbol", "Use an uppercase USDT-M symbol like SOL_USDT", { "Cache-Control": CACHE_400 });
  }

  const wait = limiter.take(clientKey(req));
  if (wait > 0) return tooMany(wait);

  if ((await contractListing(symbol)) === "unlisted") {
    return jsonError(404, "Contract not found", `${symbol} is not an active MEXC contract`, { "Cache-Control": CACHE_404 });
  }

  try {
    const detail = await getDetail(symbol);
    return Response.json(detail, { headers: { "Cache-Control": CACHE_OK } });
  } catch (err) {
    if (err instanceof MexcError && err.notFound) {
      return jsonError(404, "Contract not found", `${symbol} is not an active MEXC contract`, { "Cache-Control": CACHE_404 });
    }
    // Only our own upstream messages are returned; anything unexpected stays in the server log.
    const known = err instanceof MexcError || err instanceof UpstreamError;
    console.warn(`[api/contract] ${symbol}: upstream failed: ${err instanceof Error ? err.message : String(err)}`);
    return jsonError(502, "MEXC upstream unavailable", known ? (err as Error).message : "Upstream error");
  }
}
