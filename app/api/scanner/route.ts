import { buildBootstrap } from "@/lib/mexc";
import type { BootstrapPayload } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const CACHE_HEADER = "public, s-maxage=12, stale-while-revalidate=24, stale-if-error=120";
/** Last good payload served (marked stale) when a rebuild fails, rather than a 502. */
const STALE_OK_MS = 180_000;
const STALE_CACHE_HEADER = "public, s-maxage=5, stale-while-revalidate=10";

// Per-instance memo + in-flight de-duplication. Vercel's CDN absorbs most
// traffic via s-maxage; this only collapses concurrent cache misses that hit
// the same warm function instance so MEXC never sees a duplicate burst.
let memo: { at: number; payload: BootstrapPayload } | null = null;
let inflight: Promise<BootstrapPayload> | null = null;
const MEMO_MS = 8000;

async function getPayload(): Promise<BootstrapPayload> {
  if (memo && Date.now() - memo.at < MEMO_MS) return memo.payload;
  if (!inflight) {
    inflight = buildBootstrap()
      .then((payload) => {
        memo = { at: Date.now(), payload };
        return payload;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

export async function GET() {
  try {
    const payload = await getPayload();
    return Response.json(payload, {
      headers: { "Cache-Control": CACHE_HEADER },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Upstream error";
    // Logged so transient upstream failures (rate limits, timeouts) are diagnosable in Vercel logs.
    console.warn(`[api/scanner] bootstrap rebuild failed: ${message}`);
    // A short MEXC blip should not blank the scanner: serve the last good snapshot (the client
    // reconciles it with live ticks) as long as it is recent, and mark it stale.
    if (memo && Date.now() - memo.at < STALE_OK_MS) {
      return Response.json(memo.payload, {
        headers: {
          "Cache-Control": STALE_CACHE_HEADER,
          "X-Scanner-Stale": String(Math.round((Date.now() - memo.at) / 1000)),
        },
      });
    }
    return Response.json(
      { error: "MEXC upstream unavailable", detail: message },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}
