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
