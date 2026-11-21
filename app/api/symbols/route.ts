import { fetchUniverse } from "@/lib/mexc";
import type { ApiError, UniverseItem } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

/** Every active MEXC *_USDT perpetual, used by the top bar's contract lookup. */
export async function GET() {
  try {
    const items: UniverseItem[] = await fetchUniverse();
    return Response.json(items, {
      headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300" },
    });
  } catch (err) {
    const body: ApiError = {
      error: "MEXC upstream unavailable",
      detail: err instanceof Error ? err.message : undefined,
    };
    return Response.json(body, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
