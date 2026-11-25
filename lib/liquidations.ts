import { stripMultiplier } from "./symbol.ts";

export type Exchange = "BN" | "BYB" | "OKX";
export const EXCHANGES: readonly Exchange[] = ["BN", "BYB", "OKX"] as const;

/** LONG = a long position was force-closed (bearish forced sell). SHORT = a short was force-closed (bullish forced buy). */
export type LiqSide = "LONG" | "SHORT";

export interface LiqEvent {
  id: string;
  exchange: Exchange;
  side: LiqSide;
  /** Exchange-native instrument, e.g. BTCUSDT / BTC-USDT-SWAP. */
  instrument: string;
  /** Notional in USD. */
  usd: number;
  /** Fill / bankruptcy price. */
  price: number;
  /** Event time from the exchange, epoch ms. */
  ts: number;
  /**
   * Local clock when this browser received the event. The "live after drawer opened" guard
   * uses this, not `ts`: exchange timestamps come from the exchange's clock and
   * a fill that happened 200ms before the drawer opened can still arrive after it.
   */
  receivedAt: number;
}

export const WINDOW_15M_MS = 15 * 60 * 1000;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : typeof v === "number" ? String(v) : null);
const posNum = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number.parseFloat(v) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** Accepts a raw JSON string or an already-parsed value. Returns null for non-JSON frames such as "pong". */
function parse(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Normalized base of an exchange instrument code, e.g. "1000PEPEUSDT" -> "PEPE", "BTCUSD_PERP" -> "BTC". */
export function instrumentBase(code: string): string {
  const c = code.toUpperCase();
  const m = /^([A-Z0-9]+?)(?:USDT|USDC|USD_PERP)$/.exec(c) ?? /^([A-Z0-9]+)-(?:USDT|USDC|USD)-SWAP$/.exec(c);
  return m ? stripMultiplier(m[1]) : "";
}

/* ------------------------------------------------------------------ */
/* Binance USDⓈ-M: wss://fstream.binance.com/ws/!forceOrder@arr        */
/* {"e":"forceOrder","E":..,"o":{"s":"BTCUSDT","S":"SELL","q":"0.014","p":"9910","ap":"9910","T":..}} */
/* o.S is the liquidation ORDER side: SELL closes a long -> LONG LIQ.   */
/* ------------------------------------------------------------------ */
export function parseBinanceForceOrder(raw: unknown, base: string): LiqEvent[] {
  const msg = parse(raw);
  // Combined per-symbol streams wrap the event: {"stream":"btcusdt@forceOrder","data":{...}}
  const unwrapped = isObj(msg) && typeof msg.stream === "string" && "data" in msg ? msg.data : msg;
  const frames = Array.isArray(unwrapped) ? unwrapped : [unwrapped];
  const out: LiqEvent[] = [];
  for (const f of frames) {
    if (!isObj(f) || f.e !== "forceOrder" || !isObj(f.o)) continue;
    const o = f.o;
    const s = str(o.s);
    if (!s || instrumentBase(s) !== base) continue;
    const side = o.S === "SELL" ? "LONG" : o.S === "BUY" ? "SHORT" : null;
    // Average fill price is preferred. If ap is "0", fall back to the order price.
    const price = posNum(o.ap) ?? posNum(o.p);
    const qty = posNum(o.q);
    if (!side || !price || !qty) continue;
    const ts = posNum(o.T) ?? posNum(f.E) ?? Date.now();
    out.push({
      id: `BN:${s}:${ts}:${o.S}:${qty}`,
      exchange: "BN",
      side,
      instrument: s,
      usd: price * qty,
      price,
      ts,
      receivedAt: Date.now(),
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Bybit V5 linear: topic allLiquidation.{BASE}USDT                    */
/* {"topic":"allLiquidation.ROSEUSDT","data":[{"T":..,"s":"ROSEUSDT","S":"Sell","v":"20000","p":"0.04499"}]} */
/* Bybit docs: S is the POSITION side. "When you receive a Buy update, */
/* this means that a long position has been liquidated." So Buy -> LONG LIQ. */
/* ------------------------------------------------------------------ */
export function parseBybitLiquidation(raw: unknown, base: string): LiqEvent[] {
  const msg = parse(raw);
  if (!isObj(msg) || typeof msg.topic !== "string" || !msg.topic.startsWith("allLiquidation.")) return [];
  const rows = Array.isArray(msg.data) ? msg.data : isObj(msg.data) ? [msg.data] : [];
  const out: LiqEvent[] = [];
  for (const d of rows) {
    if (!isObj(d)) continue;
    const s = str(d.s);
    if (!s || instrumentBase(s) !== base) continue;
    const side = d.S === "Buy" ? "LONG" : d.S === "Sell" ? "SHORT" : null;
    const price = posNum(d.p);
    const qty = posNum(d.v);
    if (!side || !price || !qty) continue;
    const ts = posNum(d.T) ?? posNum(msg.ts) ?? Date.now();
    out.push({
      id: `BYB:${s}:${ts}:${d.S}:${qty}`,
      exchange: "BYB",
      side,
      instrument: s,
      usd: price * qty,
      price,
      ts,
      receivedAt: Date.now(),
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* OKX: channel liquidation-orders (instType SWAP)                     */
/* {"arg":{..},"data":[{"instId":"BTC-USDT-SWAP","details":[{"side":"sell","sz":"3","bkPx":"60000","ts":"..."}]}]} */
/* side is the liquidation ORDER side: sell closes a long -> LONG LIQ. */
/* ------------------------------------------------------------------ */

export interface OkxContractSpec {
  ctVal: number;
  /** Inverse (coin-margined) swaps quote ctVal in USD, linear swaps quote it in base coin. */
  inverse: boolean;
}
export type OkxCtValMap = ReadonlyMap<string, OkxContractSpec>;

/** Builds the instId -> ctVal map from GET /api/v5/public/instruments?instType=SWAP. */
export function parseOkxInstruments(raw: unknown): Map<string, OkxContractSpec> {
  const msg = parse(raw);
  const map = new Map<string, OkxContractSpec>();
  if (!isObj(msg) || !Array.isArray(msg.data)) return map;
  for (const d of msg.data) {
    if (!isObj(d)) continue;
    const id = str(d.instId);
    const ctVal = posNum(d.ctVal);
    if (!id || !ctVal) continue;
    map.set(id, { ctVal, inverse: d.ctType === "inverse" || d.ctValCcy === "USD" });
  }
  return map;
}

/**
 * USD notional of an OKX liquidation.
 *  - linear  (ctVal in base coin):  sz × bkPx × ctVal
 *  - inverse (ctVal in USD):        sz × ctVal. Multiplying by bkPx here would overstate it by the price, e.g. ~60,000× for BTC.
 */
export function okxNotionalUsd(sz: number, bkPx: number, spec: OkxContractSpec): number {
  return spec.inverse ? sz * spec.ctVal : sz * bkPx * spec.ctVal;
}

export function parseOkxLiquidation(raw: unknown, base: string, ctVals: OkxCtValMap): LiqEvent[] {
  const msg = parse(raw);
  if (!isObj(msg) || !isObj(msg.arg) || msg.arg.channel !== "liquidation-orders" || !Array.isArray(msg.data)) return [];
  const out: LiqEvent[] = [];
  for (const d of msg.data) {
    if (!isObj(d)) continue;
    const instId = str(d.instId);
    if (!instId || !/-(?:USDT|USD)-SWAP$/.test(instId) || instrumentBase(instId) !== base) continue;
    const spec = ctVals.get(instId);
    if (!spec || !Array.isArray(d.details)) continue; // can't convert to USD without ctVal
    for (const x of d.details) {
      if (!isObj(x)) continue;
      const side = x.side === "sell" ? "LONG" : x.side === "buy" ? "SHORT" : null;
      const sz = posNum(x.sz);
      const px = posNum(x.bkPx);
      if (!side || !sz || !px) continue;
      const ts = posNum(x.ts) ?? Date.now();
      out.push({
        id: `OKX:${instId}:${ts}:${x.side}:${sz}`,
        exchange: "OKX",
        side,
        instrument: instId,
        usd: okxNotionalUsd(sz, px, spec),
        price: px,
        ts,
        receivedAt: Date.now(),
      });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Rolling window                                                      */
/* ------------------------------------------------------------------ */

export interface LiqTotals {
  longUsd: number;
  shortUsd: number;
  count: number;
}

/** USD-weighted average fill price of events at/after `since`; 0 when there are none. */
export function liquidationVwap(events: readonly LiqEvent[], since: number): number {
  let pv = 0;
  let v = 0;
  for (const e of events) {
    if (e.ts < since || !(e.usd > 0) || !(e.price > 0)) continue;
    pv += e.price * e.usd;
    v += e.usd;
  }
  return v > 0 ? pv / v : 0;
}

export function totalsSince(events: readonly LiqEvent[], since: number): LiqTotals {
  let longUsd = 0;
  let shortUsd = 0;
  let count = 0;
  for (const e of events) {
    if (e.ts < since) continue;
    count++;
    if (e.side === "LONG") longUsd += e.usd;
    else shortUsd += e.usd;
  }
  return { longUsd, shortUsd, count };
}

/**
 * Sides to sonify for a batch of freshly received events. Only events received at or after
 * `openedAt` (drawer open, or contract switch, which remounts the drawer) count, and nothing
 * plays when sound is off. Returns sides in arrival order.
 */
export function selectLivePings(events: readonly LiqEvent[], openedAt: number, soundEnabled: boolean): LiqSide[] {
  if (!soundEnabled || openedAt <= 0) return [];
  const out: LiqSide[] = [];
  for (const e of events) if (e.receivedAt >= openedAt) out.push(e.side);
  return out;
}
