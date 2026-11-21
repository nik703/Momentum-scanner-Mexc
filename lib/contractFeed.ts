import { fromContractKline, mergeMin1, parseDealPush, parseKlinePush, SecondCandleBuilder } from "./candles.ts";
import { ReconnectingSocket, type SocketStatus } from "./reconnectingSocket.ts";
import type { ApiError, Candle, ContractDetail, ContractTicker } from "./types.ts";

const MEXC_WS = "wss://contract.mexc.com/edge";
const FLUSH_MS = 250;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_FETCH_RETRIES = 3;

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
  sec1: readonly Candle[];
  ws: SocketStatus;
  lastTradeAt: number | null;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** Subscription frames for one symbol: `sub.*` on start/reconnect, `unsub.*` on stop. */
export function subscriptionFrames(symbol: string, op: "sub" | "unsub"): string[] {
  return [
    JSON.stringify({ method: `${op}.kline`, param: { symbol, interval: "Min1" } }),
    JSON.stringify({ method: `${op}.deal`, param: { symbol, compress: false } }),
    JSON.stringify({ method: `${op}.ticker`, param: { symbol } }),
  ];
}

/**
 * Live data for one contract in the Inspection Drawer:
 *  - REST hydrate from /api/contract/[symbol] (60 × Min1 + ticker + contract size)
 *  - MEXC WS: sub.kline Min1 (live 1M candle), sub.deal (raw trades -> 1S candles), sub.ticker
 * Framework-agnostic external store; snapshots are rebuilt at most every 250ms.
 * start() and stop() can be called repeatedly (React Strict Mode mounts effects twice).
 */
export class ContractFeed {
  private snap: ContractSnapshot;
  private listeners = new Set<() => void>();
  private socket: ReconnectingSocket | null = null;
  private abort: AbortController | null = null;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private secTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private min1: Candle[] = [];
  private sec1: SecondCandleBuilder = new SecondCandleBuilder(null);
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
      sec1: [],
      ws: "connecting",
      lastTradeAt: null,
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
    this.socket = new ReconnectingSocket({
      urls: [MEXC_WS],
      heartbeat: { ms: 15_000, payload: JSON.stringify({ method: "ping" }) },
      onOpen: (send) => {
        for (const f of subscriptionFrames(this.symbol, "sub")) send(f);
      },
      onMessage: (d) => this.onMessage(d),
      onStatus: (s) => {
        this.snap = { ...this.snap, ws: s };
        this.emit();
      },
    });
    this.flushTimer = setInterval(() => this.flush(), FLUSH_MS);
    this.secTimer = setInterval(() => {
      if (this.sec1.advance(Math.floor(Date.now() / 1000) * 1000)) this.dirty = true;
    }, 1000);
  }

  /** Sends unsub.kline / unsub.deal / unsub.ticker, closes the socket, aborts in-flight fetches, clears timers. */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.socket) {
      for (const f of subscriptionFrames(this.symbol, "unsub")) this.socket.send(f);
      this.socket.close();
      this.socket = null;
    }
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
      // Definitive: the contract doesn't exist, so drop the socket instead of streaming nothing.
      this.socket?.close();
      this.socket = null;
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

    const prevSec = this.sec1.series;
    this.sec1 = new SecondCandleBuilder(detail.contractSize);
    const lastClose = base[base.length - 1]?.c ?? detail.ticker.lastPrice;
    this.sec1.seed(lastClose);
    // Re-add any seconds built before hydration (their turnover was unknown until now).
    for (const c of prevSec) if (c.v > 0) this.sec1.addTrade({ p: c.c, v: c.v, T: 0, t: c.t });

    this.snap = {
      ...this.snap,
      status: "ready",
      error: null,
      detail,
      ticker: (this.ticker = { ...detail.ticker, ...(this.ticker ?? {}) }),
      min1: this.min1.slice(),
      sec1: this.sec1.series.slice(),
    };
    this.emit();
  }

  private onMessage(raw: string) {
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!isObj(msg) || typeof msg.channel !== "string") return;
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
        if (trades.length) {
          for (const t of trades) this.sec1.addTrade(t);
          this.lastTradeAt = trades[trades.length - 1].t;
          this.dirty = true;
        }
        break;
      }
      case "push.ticker": {
        if (!isObj(msg.data)) break;
        const d = msg.data;
        const prev = this.ticker;
        const pick = (k: keyof ContractTicker): number | undefined => {
          const v = d[k];
          return typeof v === "number" && Number.isFinite(v) ? v : undefined;
        };
        const next: Partial<ContractTicker> = {};
        for (const k of [
          "lastPrice", "fairPrice", "indexPrice", "fundingRate", "amount24", "volume24",
          "riseFallRate", "high24Price", "lower24Price", "holdVol", "timestamp",
        ] as const) {
          const v = pick(k);
          if (v !== undefined) next[k] = v;
        }
        if (prev) this.ticker = { ...prev, ...next };
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
    this.dirty = false;
    this.snap = {
      ...this.snap,
      ticker: this.ticker,
      lastTradeAt: this.lastTradeAt,
      min1: this.min1.slice(),
      sec1: this.sec1.series.slice(),
    };
    this.emit();
  }
}
