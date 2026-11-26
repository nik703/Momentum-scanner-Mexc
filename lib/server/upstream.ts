/**
 * Server-side fetch for third-party JSON APIs, hardened so a slow, hostile or broken upstream can
 * never hang a serverless function or exhaust its memory:
 *  - AbortSignal.timeout (5s default) covers connect, headers AND the body stream,
 *    optionally combined with a caller deadline (e.g. the whole bootstrap's budget);
 *  - the Content-Type must be JSON;
 *  - the body is streamed with a hard byte cap (a lying or missing Content-Length can't bypass it);
 *  - failures surface as UpstreamError with a short, non-sensitive message.
 */

export const UPSTREAM_TIMEOUT_MS = 5_000;
/** Default response cap. MEXC's full /ticker list is ~0.5MB; a Min1 kline page is a few KB. */
export const UPSTREAM_MAX_BYTES = 4 * 1024 * 1024;

export type UpstreamFailure = "timeout" | "network" | "http" | "content-type" | "too-large" | "invalid-json";

export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly kind: UpstreamFailure,
    readonly httpStatus: number | null = null,
  ) {
    super(message);
    this.name = "UpstreamError";
  }
}

export interface BoundedFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  /** Extra abort source (an overall deadline). */
  signal?: AbortSignal;
  /** Label used in error messages, e.g. "MEXC". */
  label?: string;
}

export async function fetchJsonBounded<T = unknown>(url: string, opts: BoundedFetchOptions = {}): Promise<T> {
  const { timeoutMs = UPSTREAM_TIMEOUT_MS, maxBytes = UPSTREAM_MAX_BYTES, label = "Upstream" } = opts;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout;
  const isTimeout = () => timeout.aborted || (opts.signal?.aborted ?? false);

  let res: Response;
  try {
    res = await fetch(url, {
      cache: "no-store",
      signal,
      redirect: "error", // never follow an upstream redirect somewhere unexpected
      headers: { accept: "application/json" },
    });
  } catch {
    throw isTimeout()
      ? new UpstreamError(`${label} request timed out`, "timeout")
      : new UpstreamError(`${label} unreachable`, "network");
  }

  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new UpstreamError(`${label} HTTP ${res.status}`, "http", res.status);
  }
  const ctype = res.headers.get("content-type") ?? "";
  if (!/\bjson\b/i.test(ctype)) {
    await res.body?.cancel().catch(() => {});
    throw new UpstreamError(`${label} returned a non-JSON response`, "content-type", res.status);
  }
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw new UpstreamError(`${label} response too large`, "too-large", res.status);
  }

  let text: string;
  try {
    text = await readCapped(res, maxBytes);
  } catch (e) {
    if (e instanceof UpstreamError) throw e;
    throw isTimeout()
      ? new UpstreamError(`${label} response timed out`, "timeout", res.status)
      : new UpstreamError(`${label} connection dropped`, "network", res.status);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new UpstreamError(`${label} returned invalid JSON`, "invalid-json", res.status);
  }
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new UpstreamError("Upstream response too large", "too-large", res.status);
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(buf);
}
