import {
  fromContractKline,
  mergeMin1,
  parseDealPush,
  parseKlinePush,
  SEC1_KEEP,
  SEC1_MS,
  SEC10_KEEP,
  SEC10_MS,
  TradeCandleBuilder,
  type Trade,
} from "./candles.ts";
import { mexcSocket, type MexcMessage } from "./mexcSocket.ts";
import type { SocketStatus } from "./reconnectingSocket.ts";
import { MAX_PRICE, saneTs } from "./sanitize.ts";
import type { ApiError, Candle, ContractDetail, ContractTicker } from "./types.ts";

const FLUSH_MS = 250;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_FETCH_RETRIES = 3;
/**
 * Hard cap on raw trades kept in memory. Trades pushed out of the raw log are not lost to the bias
 * engine: they are folded into 10-second aggregates (see DealCompactor), so 15-minute CVD stays
 * exact while memory stays flat during a trade flood.
 */
export const MAX_DEALS = 2_000;
const COMPACT_BUCKET_MS = 10_000;
/** 16 minutes of 10s buckets × 2 sides × 3 intents, plus slack. */
const COMPACT_MAX = 600;
const COMPACT_KEEP_MS = 16 * 60_000;

/**
 * Lossless-for-CVD aggregation of evicted trades: one pseudo-trade per (10s bucket, side, intent)
 * whose p·v equals the bucket's summed p·v, so price × vol × contractSize sums exactly.
 */
export class DealCompactor {
  private buckets = new Map<string, { t: number; pv: number; v: number; T: number; O: number }>();

  add(tr: Trade): void {
    if (!(tr.v > 0) || !(tr.p > 0)) return;
    const b = Math.floor(tr.t / COMPACT_BUCKET_MS);
    const key = `${b}:${tr.T}:${tr.O}`;
    let agg = this.buckets.get(key);
    if (!agg) {
      if (this.buckets.size >= COMPACT_MAX) this.buckets.delete(this.buckets.keys().next().value!);
      this.buckets.set(key, (agg = { t: tr.t, pv: 0, v: 0, T: tr.T, O: tr.O }));
    }
    agg.pv += tr.p * tr.v;
    agg.v += tr.v;
    if (tr.t < agg.t) agg.t = tr.t;
  }

  prune(now: number): void {
    for (const [k, a] of this.buckets) if (a.t < now - COMPACT_KEEP_MS) this.buckets.delete(k);
  }

  get size(): number {
    return this.buckets.size;
  }

  /** Aggregates as trades, oldest first (they all predate the raw log). */
  trades(): Trade[] {
    const out: Trade[] = [];
    for (const a of this.buckets.values()) if (a.v > 0) out.push({ p: a.pv / a.v, v: a.v, T: a.T, O: a.O, t: a.t });
    return out.sort((x, y) => x.t - y.t);
  }
}

export interface FeedError {
  status: number;
  message: string;
}

export interface ContractSnapshot {
  symbol: string;
  status: "loading" | "ready" | "error";
  error: FeedError | null;
  detail: ContractDetail | null;
  /** REST ticker, then overwritten field by field by push.ticker frames. */
  ticker: ContractTicker | null;
  min1: readonly Candle[];
  /** 10-second candles from REST trade history + live trades (up to 90 = 15 min). */
  sec10: readonly Candle[];
  /** 1-second candles from REST trade history + live trades (up to 180 = 3 min). */
  sec1: readonly Candle[];
  ws: SocketStatus;
  lastTradeAt: number | null;
  /** REST history + live trades (id-deduplicated, time-ordered, bounded). The drawer windows it to 15m. */
  deals: readonly Trade[];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Live data for one contract in the Inspection Drawer:
 *  - REST hydrate from /api/contract/[symbol] (60 × Min1, ticker, contract size, last 100 trades)
 *  - MEXC WS (the app's single shared socket, lib/mexcSocket.ts): push.kline Min1, push.deal (raw,
 *    unaggregated trades -> 10S and 1S candles) and push.ticker for this symbol. The feed only
 *    LISTENS. The focus owner (useScanner -> mexcSocket.setFocus) sends the sub/unsub frames, so
 *    opening, switching and closing never create a second connection.
 * Trades from REST and WS go into one log deduplicated by trade id, so the 10S/1S charts open
 * already populated and the overlap between history and live stream never double-counts.
 * Framework-agnostic external store; snapshots are rebuilt at most every 250ms.
 * start() and stop() can be called repeatedly (React Strict Mode mounts effects twice).
 */
export class ContractFeed {
  private snap: ContractSnapshot;
  private listeners = new Set<() => void>();
  private offMessage: (() => void) | null = null;
  private offStatus: (() => void) | null = null;
  private abort: AbortController | null = null;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private secTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private min1: Candle[] = [];
  private sec10 = new TradeCandleBuilder(SEC10_MS, SEC10_KEEP, null);
  private sec1 = new TradeCandleBuilder(SEC1_MS, SEC1_KEEP, null);
  /** Every trade seen (REST + live), ascending by arrival; ids dedupe the REST/WS overlap. */
  private tradeLog: Trade[] = [];
  private tradeIds = new Set<string>();
  private compacted = new DealCompactor();
  private ticker: ContractTicker | null = null;
  private lastTradeAt: number | null = null;
  private dirty = false;
  private running = false;

  constructor(readonly symbol: string) {
    this.snap = {
      symbol,
      status: "loading",
      error: null,
      detail: null,
      ticker: null,
      min1: [],
      sec10: [],
      sec1: [],
      ws: "connecting",
      lastTradeAt: null,
      deals: [],
    };
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  getSnapshot = (): ContractSnapshot => this.snap;

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.hydrate(0);
    this.offMessage = mexcSocket.addListener((m) => this.onMessage(m));
    this.offStatus = mexcSocket.onStatus((s) => {
      if (this.snap.ws === s) return;
      this.snap = { ...this.snap, ws: s };
      this.emit();
    });
    this.flushTimer = setInterval(() => this.flush(), FLUSH_MS);
    this.secTimer = setInterval(() => {
      const now = Date.now();
      const a = this.sec1.advance(now);
      const b = this.sec10.advance(now);
      if (a || b) this.dirty = true;
    }, 1000);
  }

  /** Detaches from the shared socket, aborts in-flight fetches and clears timers. Unsub frames come from the focus owner. */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.offMessage?.();
    this.offStatus?.();
    this.offMessage = this.offStatus = null;
    this.abort?.abort();
    this.abort = null;
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.secTimer) clearInterval(this.secTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.flushTimer = this.secTimer = this.retryTimer = null;
  }

  private emit() {
    for (const l of this.listeners) l();
  }

  private async hydrate(attempt: number): Promise<void> {
    this.abort?.abort();
    const ctrl = new AbortController();
    this.abort = ctrl;
    const timeout = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(`/api/contract/${encodeURIComponent(this.symbol)}`, { signal: ctrl.signal });
      const body: unknown = await res.json().catch(() => null);
      if (!this.running || ctrl.signal.aborted) return;
      if (!res.ok) {
        const msg = isObj(body) && typeof body.error === "string" ? (body as unknown as ApiError) : null;
        const err: FeedError = {
          status: res.status,
          message: msg ? `${msg.error}${msg.detail ? `: ${msg.detail}` : ""}` : `HTTP ${res.status}`,
        };
        // 400/404 are final. Retry 5xx with backoff.
        if (res.status >= 500 && attempt < MAX_FETCH_RETRIES) return this.scheduleRetry(attempt);
        this.fail(err);
        return;
      }
      if (!isObj(body) || !Array.isArray(body.klines) || !isObj(body.ticker)) {
        this.fail({ status: 502, message: "Malformed contract payload" });
        return;
      }
      this.applyDetail(body as unknown as ContractDetail);
    } catch {
      if (!this.running) return;
      if (attempt < MAX_FETCH_RETRIES) return this.scheduleRetry(attempt);
      this.fail({ status: 0, message: "Network error while loading contract" });
    } finally {
      clearTimeout(timeout);
    }
  }

  private scheduleRetry(attempt: number) {
    this.retryTimer = setTimeout(() => void this.hydrate(attempt + 1), 1000 * 2 ** attempt);
  }

  private fail(err: FeedError) {
    if (err.status === 400 || err.status === 404) {
      // Definitive: the contract doesn't exist. Drop its channels from the shared socket instead of
      // keeping dead subscriptions open (the drawer stays in focus mode).
      mexcSocket.dropFocusChannels(this.symbol);
    }
    this.snap = { ...this.snap, status: "error", error: err };
    this.emit();
  }

  private applyDetail(detail: ContractDetail) {
    // REST is the base. Any live Min1 candles that arrived first and are at least as new are merged back on top.
    const live = this.min1;
    const base = detail.klines.map(fromContractKline);
    const lastBase = base[base.length - 1]?.t ?? 0;
    for (const c of live) if (c.t >= lastBase) mergeMin1(base, c);
    this.min1 = base;

    // REST trade history + any live trades received before hydration -> one deduplicated log,
    // re-bucketed in time order into fresh 10S and 1S builders that now know the contract size.
    const history: Trade[] = (detail.trades ?? []).map((t) => ({
      p: t.price,
      v: t.vol,
      T: t.side,
      O: t.openFlag,
      t: t.timestampMs,
      id: t.id,
    }));
    const merged: Trade[] = [];
    const ids = new Set<string>();
    for (const t of [...history, ...this.tradeLog]) {
      if (t.id) {
        if (ids.has(t.id)) continue;
        ids.add(t.id);
      }
      merged.push(t);
    }
    merged.sort((a, b) => a.t - b.t);
    for (const t of merged.slice(0, Math.max(0, merged.length - MAX_DEALS))) this.compacted.add(t);
    this.tradeLog = merged.slice(-MAX_DEALS);
    this.tradeIds = new Set(this.tradeLog.flatMap((t) => (t.id ? [t.id] : [])));
    this.sec10 = new TradeCandleBuilder(SEC10_MS, SEC10_KEEP, detail.contractSize);
    this.sec1 = new TradeCandleBuilder(SEC1_MS, SEC1_KEEP, detail.contractSize);
    const seed = merged[0]?.p ?? base[base.length - 1]?.c ?? detail.ticker.lastPrice;
    this.sec10.seed(seed);
    this.sec1.seed(seed);
    for (const t of merged) {
      this.sec10.addTrade(t);
      this.sec1.addTrade(t);
    }
    const now = Date.now();
    this.sec10.advance(now);
    this.sec1.advance(now);

    this.snap = {
      ...this.snap,
      status: "ready",
      error: null,
      detail,
      ticker: (this.ticker = { ...detail.ticker, ...(this.ticker ?? {}) }),
      min1: this.min1.slice(),
      sec10: this.sec10.series.slice(),
      sec1: this.sec1.series.slice(),
      deals: this.dealsView(),
    };
    this.emit();
  }

  /** Compacted aggregates (older) + raw trades (newer): what the bias engine consumes. */
  private dealsView(): Trade[] {
    return this.compacted.size ? [...this.compacted.trades(), ...this.tradeLog] : this.tradeLog.slice();
  }

  /** Sizes of every rolling buffer (diagnostics and the flood test). */
  bufferSizes() {
    return {
      deals: this.tradeLog.length,
      dealIds: this.tradeIds.size,
      compacted: this.compacted.size,
      min1: this.min1.length,
      sec10: this.sec10.series.length,
      sec1: this.sec1.series.length,
    };
  }

  private onMessage(msg: MexcMessage) {
    // Ignore late frames from a previous symbol on a shared or reconnecting socket.
    if (typeof msg.symbol === "string" && msg.symbol !== this.symbol) return;

    switch (msg.channel) {
      case "push.kline": {
        const c = parseKlinePush(msg.data);
        if (c) {
          mergeMin1(this.min1, c);
          this.dirty = true;
        }
        break;
      }
      case "push.deal": {
        const trades = parseDealPush(msg.data);
        let added = 0;
        for (const t of trades) {
          if (t.id) {
            if (this.tradeIds.has(t.id)) continue; // already in the REST history
            this.tradeIds.add(t.id);
          }
          this.tradeLog.push(t);
          this.sec10.addTrade(t);
          this.sec1.addTrade(t);
          this.lastTradeAt = t.t;
          added++;
        }
        // Trades arrive far more often than push.ticker (~1/s): advance lastPrice from the newest
        // fill so the headline, watermark and price line never lag the tape.
        const newest = trades[trades.length - 1];
        if (added && this.ticker && newest.t >= this.ticker.timestamp) {
          this.ticker = { ...this.ticker, lastPrice: newest.p, timestamp: newest.t };
        }
        if (this.tradeLog.length > MAX_DEALS) {
          const drop = this.tradeLog.splice(0, this.tradeLog.length - MAX_DEALS);
          for (const t of drop) {
            if (t.id) this.tradeIds.delete(t.id);
            this.compacted.add(t);
          }
        }
        if (added) this.dirty = true;
        break;
      }
      case "push.ticker": {
        if (!isObj(msg.data)) break;
        const d = msg.data;
        const prev = this.ticker;
        const POSITIVE = new Set<keyof ContractTicker>(["lastPrice", "fairPrice", "indexPrice", "high24Price", "lower24Price"]);
        const pick = (k: keyof ContractTicker): number | undefined => {
          const v = d[k];
          if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
          // Prices must be positive and plausible; a far-future timestamp would lock lastPrice forever.
          if (POSITIVE.has(k) && !(v > 0 && v <= MAX_PRICE)) return undefined;
          if (k === "timestamp" && !saneTs(v)) return undefined;
          if ((k === "amount24" || k === "volume24" || k === "holdVol") && v < 0) return undefined;
          return v;
        };
        const next: Partial<ContractTicker> = {};
        for (const k of [
          "lastPrice", "fairPrice", "indexPrice", "fundingRate", "amount24", "volume24",
          "riseFallRate", "high24Price", "lower24Price", "holdVol", "timestamp",
        ] as const) {
          const v = pick(k);
          if (v !== undefined) next[k] = v;
        }
        if (prev) {
          // An older ticker frame must not roll lastPrice back behind a newer trade.
          if (next.timestamp !== undefined && next.timestamp < prev.timestamp) {
            delete next.lastPrice;
            delete next.timestamp;
          }
          this.ticker = { ...prev, ...next };
        }
        else if (next.lastPrice !== undefined) {
          this.ticker = {
            lastPrice: next.lastPrice,
            fairPrice: next.fairPrice ?? next.lastPrice,
            indexPrice: next.indexPrice ?? next.lastPrice,
            fundingRate: next.fundingRate ?? 0,
            amount24: next.amount24 ?? 0,
            volume24: next.volume24 ?? 0,
            riseFallRate: next.riseFallRate ?? 0,
            high24Price: next.high24Price ?? next.lastPrice,
            lower24Price: next.lower24Price ?? next.lastPrice,
            holdVol: next.holdVol ?? 0,
            timestamp: next.timestamp ?? Date.now(),
          };
        }
        this.dirty = true;
        break;
      }
      default:
        break;
    }
  }

  private flush() {
    if (!this.dirty) return;
    this.compacted.prune(Date.now());
    this.dirty = false;
    this.snap = {
      ...this.snap,
      ticker: this.ticker,
      lastTradeAt: this.lastTradeAt,
      min1: this.min1.slice(),
      sec10: this.sec10.series.slice(),
      sec1: this.sec1.series.slice(),
      deals: this.dealsView(),
    };
    this.emit();
  }
}
