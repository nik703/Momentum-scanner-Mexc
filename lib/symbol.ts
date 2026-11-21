/** Leading size multipliers that exchanges put on low-priced assets (1000PEPE, 10000SATS, 1000000MOG...). */
const MULTIPLIER = /^(?:1000000|100000|10000|1000)(?=[A-Z])/;
const SYMBOL_CHARS = /^[A-Z0-9_]{2,30}$/;

export type NormalizedSymbol =
  | { ok: true; symbol: string }
  | { ok: false; reason: "invalid" | "unsupported-quote" };

/**
 * Normalizes free-form user input into a MEXC USDT-M symbol.
 *   "sol" | "SOL" | "solusdt" | "SOL_USDT" | " sol-usdt " -> "SOL_USDT"
 *   "BTC_USD" -> unsupported-quote (USDT-M only)
 *   "s#!" -> invalid
 */
export function normalizeSymbol(input: string): NormalizedSymbol {
  const raw = input.trim().toUpperCase().replace(/[-/\s]+/g, "_");
  if (!SYMBOL_CHARS.test(raw)) return { ok: false, reason: "invalid" };
  if (/^[A-Z0-9]+_USDT$/.test(raw)) return { ok: true, symbol: raw };
  if (/^[A-Z0-9]+USDT$/.test(raw) && raw.length > 4) return { ok: true, symbol: `${raw.slice(0, -4)}_USDT` };
  if (/^[A-Z0-9]+$/.test(raw)) return { ok: true, symbol: `${raw}_USDT` };
  if (/^[A-Z0-9]+_[A-Z0-9]+$/.test(raw)) return { ok: false, reason: "unsupported-quote" };
  return { ok: false, reason: "invalid" };
}

/** Strips a 1000/10000/1000000 size prefix: "1000PEPE" -> "PEPE". Leaves "1INCH" alone. */
export function stripMultiplier(asset: string): string {
  return asset.toUpperCase().replace(MULTIPLIER, "");
}

/** MEXC symbol -> normalized base asset: "SOL_USDT" -> "SOL", "1000PEPE_USDT" -> "PEPE". */
export function baseAsset(symbol: string): string {
  return stripMultiplier(symbol.toUpperCase().replace(/_USDT$/, ""));
}
