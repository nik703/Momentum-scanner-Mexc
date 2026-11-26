import { MexcError } from "@/lib/mexc";
import { UpstreamError } from "@/lib/server/upstream";
import { clientKey, hasQuery, jsonError, RateLimiter, rejectQuery, tooMany } from "@/lib/server/http";
import { getUniverse } from "@/lib/server/universe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

const limiter = new RateLimiter(30, 1);

/** Every active MEXC *_USDT perpetual, used by the top bar's contract lookup. Cached per instance for 60s. */
export async function GET(req: Request) {
  if (hasQuery(req)) return rejectQuery();
  const wait = limiter.take(clientKey(req));
  if (wait > 0) return tooMany(wait);
  try {
    const items = await getUniverse();
    return Response.json(items, {
      headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300" },
    });
  } catch (err) {
    console.warn(`[api/symbols] upstream failed: ${err instanceof Error ? err.message : String(err)}`);
    const known = err instanceof MexcError || err instanceof UpstreamError;
    return jsonError(502, "MEXC upstream unavailable", known ? (err as Error).message : "Upstream error");
  }
}
