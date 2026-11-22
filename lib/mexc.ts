import type {
  BootstrapPayload,
  BootstrapSymbol,
  ContractDetail,
  ContractKline,
  ContractTicker,
  ContractTrade,
  UniverseItem,
} from "./types.ts";

const BASE = "https://contract.mexc.com/api/v1/contract";
const TOP_N = 150;
const CONCURRENCY = 15;
const KLINE_LIMIT = 24;
const TIMEOUT_MS = 6000;

interface RawTicker {
  symbol: string;
  lastPrice: number;
  amount24: number;
  volume24: number;
}

interface RawKline {
  time: number[];
  open: number[];
  close: number[];
  amount: number[];
}

/** MEXC error code returned for unknown / delisted contracts. */
export const MEXC_CONTRACT_NOT_FOUND = 1001;

export class MexcError extends Error {
  constructor(
    message: string,
    /** MEXC business error code (e.g. 1001), or null for transport/HTTP failures. */
    readonly code: number | null,
    readonly httpStatus: number | null = null,
  ) {
    super(message);
    this.name = "MexcError";
  }
  get notFound(): boolean {
    return this.code === MEXC_CONTRACT_NOT_FOUND;
  }
}

interface MexcEnvelope<T> {
  success: boolean;
  code?: number;
  message?: string;
  data: T;
}

async function getJson<T>(url: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
  } catch (e) {
    const timedOut = e instanceof DOMException && e.name === "TimeoutError";
    throw new MexcError(timedOut ? "MEXC request timed out" : "MEXC unreachable", null);
  }
  if (!res.ok) throw new MexcError(`MEXC HTTP ${res.status}`, null, res.status);
  let body: MexcEnvelope<T>;
  try {
    body = (await res.json()) as MexcEnvelope<T>;
  } catch {
    throw new MexcError("MEXC returned invalid JSON", null, res.status);
  }
  if (!body.success) throw new MexcError(body.message ?? `MEXC error ${body.code}`, body.code ?? null);
  return body.data;
}

/** Runs `fn` over `items` with at most `limit` promises in flight. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const out: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      try {
        out[i] = { status: "fulfilled", value: await fn(items[i], i) };
      } catch (reason) {
        out[i] = { status: "rejected", reason };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function fetchKline(symbol: string): Promise<RawKline> {
  const url = `${BASE}/kline/${encodeURIComponent(symbol)}?interval=Min5&limit=${KLINE_LIMIT}`;
  try {
    return await getJson<RawKline>(url);
  } catch {
    // One retry with a short pause absorbs transient 5xx / rate-limit blips.
    await new Promise((r) => setTimeout(r, 250));
    return getJson<RawKline>(url);
  }
}

export async function buildBootstrap(): Promise<BootstrapPayload> {
  const tickers = await getJson<RawTicker[]>(`${BASE}/ticker`);
  const top = tickers
    .filter((t) => t.symbol.endsWith("_USDT") && t.amount24 > 0 && t.lastPrice > 0)
    .sort((a, b) => b.amount24 - a.amount24)
    .slice(0, TOP_N);

  const results = await mapLimit(top, CONCURRENCY, (t) => fetchKline(t.symbol));

  const symbols: BootstrapSymbol[] = [];
  let failed = 0;
  results.forEach((r, i) => {
    const tk = top[i];
    if (r.status !== "fulfilled" || !r.value?.time?.length) {
      failed++;
      return;
    }
    const k = r.value;
    const len = Math.min(k.time.length, k.open.length, k.close.length, k.amount.length);
    const from = Math.max(0, len - KLINE_LIMIT);
    symbols.push({
      symbol: tk.symbol,
      lastPrice: tk.lastPrice,
      amount24: tk.amount24,
      volume24: tk.volume24,
      k: {
        t: k.time.slice(from, len).map((s) => s * 1000),
        o: k.open.slice(from, len),
        c: k.close.slice(from, len),
        a: k.amount.slice(from, len),
      },
    });
  });

  return { generatedAt: Date.now(), interval: "Min5", symbols, failed };
}

/* ------------------------------------------------------------------ */
/* Contract Inspection Drawer                                          */
/* ------------------------------------------------------------------ */

interface RawKlineFull extends RawKline {
  high: number[];
  low: number[];
  vol: number[];
}

interface RawTickerFull extends RawTicker {
  fairPrice: number;
  indexPrice: number;
  fundingRate: number;
  riseFallRate: number;
  high24Price: number;
  lower24Price: number;
  holdVol: number;
  timestamp: number;
}

interface RawContractInfo {
  baseCoin: string;
  contractSize: number;
  priceScale: number;
}

const num = (v: unknown, fallback = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

/**
 * Ticker + 60×Min1 klines (+ contract detail for contract size), fetched in parallel.
 * Throws MexcError; `.notFound` is true when the contract does not exist.
 */
/** getJson with one short retry for transient failures. A definitive "not found" is never retried. */
async function getJsonRetry<T>(url: string): Promise<T> {
  try {
    return await getJson<T>(url);
  } catch (e) {
    if (e instanceof MexcError && e.notFound) throw e;
    await new Promise((r) => setTimeout(r, 300));
    return getJson<T>(url);
  }
}

interface RawDeal {
  p: number;
  v: number;
  /** 1 = taker buy, 2 = taker sell */
  T: number;
  t: number;
  i?: string | number;
}

/** Normalizes /deals (newest first, max 100) to oldest-first ContractTrade[]; malformed rows are dropped. */
export function normalizeDeals(raw: unknown): ContractTrade[] {
  if (!Array.isArray(raw)) return [];
  const out: ContractTrade[] = [];
  for (const d of raw as RawDeal[]) {
    if (!d || typeof d !== "object") continue;
    const price = num(d.p, Number.NaN);
    const vol = num(d.v, Number.NaN);
    const ts = num(d.t, Number.NaN);
    if (!(price > 0) || !(vol >= 0) || !(ts > 0)) continue;
    out.push({
      id: d.i !== undefined ? String(d.i) : `${ts}:${price}:${vol}`,
      price,
      vol,
      side: d.T === 2 ? "sell" : "buy",
      timestampMs: ts,
    });
  }
  return out.sort((a, b) => a.timestampMs - b.timestampMs);
}

export async function fetchContractDetail(symbol: string): Promise<ContractDetail> {
  const q = encodeURIComponent(symbol);
  // All legs run in parallel. Trades are optional: a failure or empty list falls back to [].
  const [klineR, tickerR, infoR, dealsR] = await Promise.allSettled([
    getJsonRetry<RawKlineFull>(`${BASE}/kline/${q}?interval=Min1&limit=60`),
    getJsonRetry<RawTickerFull>(`${BASE}/ticker?symbol=${q}`),
    getJsonRetry<RawContractInfo>(`${BASE}/detail?symbol=${q}`),
    getJson<RawDeal[]>(`${BASE}/deals/${q}?limit=100`),
  ]);

  // A 1001 from any leg means the contract does not exist.
  for (const r of [tickerR, klineR, infoR]) {
    if (r.status === "rejected" && r.reason instanceof MexcError && r.reason.notFound) throw r.reason;
  }
  if (tickerR.status === "rejected") throw tickerR.reason;
  if (klineR.status === "rejected") throw klineR.reason;

  const t = tickerR.value;
  // MEXC answers an unknown ?symbol= with the full ticker array on some edges. Treat that as not found.
  if (!t || Array.isArray(t) || t.symbol !== symbol) {
    throw new MexcError("Contract does not exist", MEXC_CONTRACT_NOT_FOUND);
  }
  const ticker: ContractTicker = {
    lastPrice: num(t.lastPrice),
    fairPrice: num(t.fairPrice, num(t.lastPrice)),
    indexPrice: num(t.indexPrice, num(t.lastPrice)),
    fundingRate: num(t.fundingRate),
    amount24: num(t.amount24),
    volume24: num(t.volume24),
    riseFallRate: num(t.riseFallRate),
    high24Price: num(t.high24Price),
    lower24Price: num(t.lower24Price),
    holdVol: num(t.holdVol),
    timestamp: num(t.timestamp, Date.now()),
  };

  const k = klineR.value;
  const len = Math.min(
    k.time?.length ?? 0,
    k.open?.length ?? 0,
    k.high?.length ?? 0,
    k.low?.length ?? 0,
    k.close?.length ?? 0,
    k.vol?.length ?? 0,
    k.amount?.length ?? 0,
  );
  const klines: ContractKline[] = [];
  for (let i = Math.max(0, len - 60); i < len; i++) {
    klines.push({
      timestamp: k.time[i] * 1000,
      open: k.open[i],
      high: k.high[i],
      low: k.low[i],
      close: k.close[i],
      vol: k.vol[i],
      amount: k.amount[i],
    });
  }

  const info = infoR.status === "fulfilled" ? infoR.value : null;
  return {
    symbol,
    baseCoin: info?.baseCoin ?? symbol.replace(/_USDT$/, ""),
    contractSize: info && info.contractSize > 0 ? info.contractSize : null,
    priceScale: info && Number.isInteger(info.priceScale) ? info.priceScale : null,
    ticker,
    klines,
    trades: dealsR.status === "fulfilled" ? normalizeDeals(dealsR.value) : [],
    generatedAt: Date.now(),
  };
}

/** Every active *_USDT perpetual, most liquid first (for the global lookup). */
export async function fetchUniverse(): Promise<UniverseItem[]> {
  const tickers = await getJson<RawTickerFull[]>(`${BASE}/ticker`);
  return tickers
    .filter((t) => typeof t.symbol === "string" && t.symbol.endsWith("_USDT") && t.lastPrice > 0)
    .sort((a, b) => b.amount24 - a.amount24)
    .map((t) => ({
      symbol: t.symbol,
      lastPrice: num(t.lastPrice),
      amount24: num(t.amount24),
      riseFallRate: num(t.riseFallRate),
    }));
}
