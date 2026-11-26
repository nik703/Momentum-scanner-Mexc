/**
 * Request guards shared by the API routes: query-string rejection (CDN cache-busting), a per-client
 * token-bucket rate limiter, and safe JSON error responses.
 */

/**
 * The API routes take no query parameters. The CDN keys its cache on the full URL, so `?cb=1`,
 * `?cb=2`... would each miss the cache and reach the function. Rejecting any query string stops
 * cache-busting from turning into upstream traffic.
 */
export function hasQuery(req: Request): boolean {
  try {
    return new URL(req.url).search.length > 0;
  } catch {
    return true;
  }
}

/** Client address as seen by the platform proxy (Vercel sets x-forwarded-for / x-real-ip). */
export function clientKey(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  const first = xff?.split(",")[0]?.trim();
  const ip = first || req.headers.get("x-real-ip")?.trim() || "local";
  return ip.slice(0, 64);
}

interface Bucket {
  tokens: number;
  at: number;
}

/**
 * Per-instance token bucket keyed by client. In-memory, so it bounds what one client can make a
 * single warm instance do; the CDN and the per-route coalescing do the rest. Memory is capped.
 */
export class RateLimiter {
  private buckets = new Map<string, Bucket>();

  constructor(
    private readonly burst: number,
    private readonly refillPerSec: number,
    private readonly maxKeys = 10_000,
  ) {}

  /** Returns 0 when allowed, else the seconds until a token is available. */
  take(key: string, now = Date.now()): number {
    let b = this.buckets.get(key);
    if (!b) {
      if (this.buckets.size >= this.maxKeys) {
        // Evict the oldest-inserted key (Map preserves insertion order).
        const oldest = this.buckets.keys().next().value;
        if (oldest !== undefined) this.buckets.delete(oldest);
      }
      b = { tokens: this.burst, at: now };
      this.buckets.set(key, b);
    } else {
      b.tokens = Math.min(this.burst, b.tokens + ((now - b.at) / 1000) * this.refillPerSec);
      b.at = now;
    }
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return 0;
    }
    return Math.max(1, Math.ceil((1 - b.tokens) / this.refillPerSec));
  }
}

const NO_STORE = { "Cache-Control": "no-store" };

export function jsonError(status: number, error: string, detail?: string, headers: Record<string, string> = NO_STORE) {
  return Response.json(detail ? { error, detail } : { error }, { status, headers });
}

export function rejectQuery() {
  return jsonError(400, "Unexpected query parameters", "This endpoint takes no query string");
}

export function tooMany(retryAfterSec: number) {
  return jsonError(429, "Too many requests", undefined, { ...NO_STORE, "Retry-After": String(retryAfterSec) });
}
