import { fetchContractDetail, MexcError } from "@/lib/mexc";
import { normalizeSymbol } from "@/lib/symbol";
import type { ApiError, ContractDetail } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

const CACHE_OK = "public, s-maxage=5, stale-while-revalidate=10";
// Negative answers are cached briefly too, so a typo can't hammer MEXC.
const CACHE_404 = "public, s-maxage=30, stale-while-revalidate=60";

function fail(status: number, body: ApiError, cache = "no-store") {
  return Response.json(body, { status, headers: { "Cache-Control": cache } });
}

export async function GET(_req: Request, ctx: { params: Promise<{ symbol: string }> }) {
  const { symbol: rawParam } = await ctx.params;
  let raw: string;
  try {
    raw = decodeURIComponent(rawParam);
  } catch {
    return fail(400, { error: "Invalid symbol", detail: "Malformed URL encoding" });
  }

  const norm = normalizeSymbol(raw);
  if (!norm.ok) {
    return norm.reason === "invalid"
      ? fail(400, { error: "Invalid symbol", detail: "Use a symbol like SOL_USDT" })
      : fail(404, { error: "Contract not found", detail: "Only USDT-M perpetuals are supported" }, CACHE_404);
  }

  try {
    const detail: ContractDetail = await fetchContractDetail(norm.symbol);
    return Response.json(detail, { headers: { "Cache-Control": CACHE_OK } });
  } catch (err) {
    if (err instanceof MexcError && err.notFound) {
      return fail(404, { error: "Contract not found", detail: `${norm.symbol} is not an active MEXC contract` }, CACHE_404);
    }
    const detail = err instanceof Error ? err.message : "Upstream error";
    console.warn(`[api/contract] ${norm.symbol}: upstream failed: ${detail}`);
    return fail(502, { error: "MEXC upstream unavailable", detail });
  }
}
