import type { BootstrapPayload, BootstrapSymbol } from "./types.ts";

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

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    cache: "no-store",
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const body = (await res.json()) as { success: boolean; data: T; code?: number };
  if (!body.success) throw new Error(`MEXC error code ${body.code} for ${url}`);
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
