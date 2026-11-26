/**
 * Shared guards for untrusted exchange data (WebSocket frames, REST bodies, localStorage).
 * Every parser funnels numbers through these, so one malformed or adversarial frame can't put
 * NaN/Infinity on screen, poison a rolling window with a far-future timestamp, or overflow a
 * notional to Infinity.
 */

/** Largest price any listed contract could plausibly trade at (BTC is ~1e5). */
export const MAX_PRICE = 1e9;
/** Largest quantity (contracts or coins) accepted in a single trade or liquidation. */
export const MAX_QTY = 1e13;
/** A single liquidation larger than $100B is not real. */
export const MAX_NOTIONAL_USD = 1e11;
/** Exchange timestamps before 2015 are garbage (or seconds mistaken for ms). */
export const MIN_TS_MS = Date.UTC(2015, 0, 1);
/** Exchange clocks drift. Anything further ahead than this is rejected instead of trusted. */
export const MAX_FUTURE_SKEW_MS = 5 * 60_000;
/** WebSocket frames larger than this are dropped unparsed (MEXC's full ticker frame is ~300KB). */
export const MAX_FRAME_CHARS = 4_000_000;

/** Number or numeric string -> finite number, else null. Never throws. */
export function finiteNum(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.length <= 64 ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : null;
}

/** Finite and in (0, max], else null. */
export function positiveNum(v: unknown, max = Number.MAX_VALUE): number | null {
  const n = finiteNum(v);
  return n !== null && n > 0 && n <= max ? n : null;
}

/** A price: finite, > 0, <= MAX_PRICE. */
export const priceNum = (v: unknown): number | null => positiveNum(v, MAX_PRICE);

/** True for an epoch-ms timestamp between 2015 and a few minutes in the future. */
export function saneTs(ts: number, now = Date.now()): boolean {
  return Number.isFinite(ts) && ts >= MIN_TS_MS && ts <= now + MAX_FUTURE_SKEW_MS;
}

/** Keys that could reach Object.prototype through a careless merge. Stripped from every parsed frame. */
export const UNSAFE_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

const stripUnsafe = (key: string, value: unknown) => (UNSAFE_KEYS.has(key) ? undefined : value);

/**
 * JSON.parse for untrusted frames. Returns undefined for oversized or invalid input (never throws),
 * and drops __proto__ / constructor / prototype keys. The reviver only runs when one of those tokens
 * appears in the text, so the hot path (MEXC's ~1/s full ticker frame) parses at native speed.
 */
export function safeJsonParse(raw: string, maxChars = MAX_FRAME_CHARS): unknown {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > maxChars) return undefined;
  try {
    return /__proto__|constructor|prototype/.test(raw) ? JSON.parse(raw, stripUnsafe) : JSON.parse(raw);
  } catch {
    return undefined;
  }
}
