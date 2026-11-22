const compact = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

export function fmtUsd(v: number): string {
  if (!Number.isFinite(v)) return "—";
  return `$${compact.format(v)}`;
}

const priceFmtCache = new Map<number, Intl.NumberFormat>();

export function fmtPrice(p: number): string {
  if (!Number.isFinite(p) || p <= 0) return "—";
  const mag = Math.floor(Math.log10(p));
  const decimals = Math.min(8, Math.max(2, 4 - mag));
  let f = priceFmtCache.get(decimals);
  if (!f) {
    f = new Intl.NumberFormat("en-US", {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
    priceFmtCache.set(decimals, f);
  }
  return f.format(p);
}

export function fmtPct(v: number | null, digits = 2): string {
  if (v === null || !Number.isFinite(v)) return "—";
  const sign = v > 0 ? "+" : v < 0 ? "-" : "";
  return `${sign}${Math.abs(v).toFixed(digits)}%`;
}

export function fmtClock(ts: number | null): string {
  if (!ts) return "—";
  const d = new Date(ts);
  const p = (n: number, l = 2) => String(n).padStart(l, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

const fixedFmtCache = new Map<string, Intl.NumberFormat>();
function fixedFmt(minDec: number, maxDec: number): Intl.NumberFormat {
  const key = `${minDec}:${maxDec}`;
  let f = fixedFmtCache.get(key);
  if (!f) {
    f = new Intl.NumberFormat("en-US", { minimumFractionDigits: minDec, maximumFractionDigits: maxDec });
    fixedFmtCache.set(key, f);
  }
  return f;
}

/**
 * One price formatter shared by related values (last, mark, index), so all three use the same
 * decimals, derived from a reference price.
 *  - Decimals: the contract's tick precision (`priceScale`) when known, otherwise
 *    magnitude-based (about 5 significant digits), capped at 10.
 *  - Prices of 1,000 and above drop redundant trailing zeros ("98,420.5", "98,420"). Prices
 *    below 1,000 keep fixed decimals so their width doesn't jitter on ticks ("0.0000034077").
 */
export function makePriceFormatter(refPrice: number, priceScale?: number | null): (p: number) => string {
  const mag = refPrice > 0 && Number.isFinite(refPrice) ? Math.floor(Math.log10(refPrice)) : 0;
  const byMagnitude = Math.max(0, 4 - mag);
  const decimals = Math.min(10, Math.max(0, priceScale ?? byMagnitude));
  const big = refPrice >= 1000;
  const f = fixedFmt(big ? 0 : decimals, big ? Math.min(decimals, 2) : decimals);
  return (p: number) => (Number.isFinite(p) && p > 0 ? f.format(p) : "—");
}

const compact1 = new Intl.NumberFormat("en-US", {
  notation: "compact",
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

/** Compact USD with exactly 1 decimal: $142.8M, $840.2K, $3.8B. */
export function fmtUsd1(v: number): string {
  if (!Number.isFinite(v) || v < 0) return "—";
  return `$${compact1.format(v)}`;
}
