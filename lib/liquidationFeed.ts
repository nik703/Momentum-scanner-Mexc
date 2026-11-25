import {
  EXCHANGES,
  parseBinanceForceOrder,
  parseBybitLiquidation,
  parseOkxInstruments,
  parseOkxLiquidation,
  liquidationVwap,
  totalsSince,
  WINDOW_15M_MS,
  type Exchange,
  type LiqEvent,
  type LiqTotals,
  type OkxCtValMap,
} from "./liquidations.ts";
import { ReconnectingSocket, type SocketStatus } from "./reconnectingSocket.ts";

const BINANCE_STREAM_BASE = "wss://fstream.binance.com/stream?streams=";
const BYBIT_WS = "wss://stream.bybit.com/v5/public/linear";
// OKX serves the same public API on :443 and :8443. :443 goes first because corporate and
// mobile firewalls often block :8443. Reconnects rotate to the documented :8443 endpoint.
const OKX_WS = ["wss://ws.okx.com/ws/v5/public", "wss://ws.okx.com:8443/ws/v5/public"] as const;
const OKX_INSTRUMENT = "https://www.okx.com/api/v5/public/instruments?instType=SWAP&instId=";

const TAPE_MAX = 200;
/**
 * Binance answers restricted regions (e.g. the US) with HTTP 451 on REST, while its WebSocket
 * still opens and then sends nothing. A per-symbol stream can also be quiet for a long time
 * legitimately, so a long silence only adds an explanatory note. It is not shown as an error.
 */
const BN_SILENCE_MS = 120_000;
const FLUSH_MS = 250;
const PRUNE_MS = 1_000;

export interface LiquidationSnapshot {
  base: string;
  status: Record<Exchange, SocketStatus>;
  /** Optional per-exchange explanation (shown as a tooltip), e.g. a suspected region block. */
  notes: Partial<Record<Exchange, string>>;
  /** Live session tape, newest first. */
  tape: readonly LiqEvent[];
  /** Rolling trailing-15-minute totals. */
  window15m: LiqTotals;
  /** Rolling trailing-15-minute events, oldest first (chart overlay). */
  windowEvents: readonly LiqEvent[];
  /** Trailing-15m USD of SHORT liquidations (forced buys, bullish squeeze pressure). */
  shortLiqUsd15m: number;
  /** Trailing-15m USD of LONG liquidations (forced sells, bearish cascade pressure). */
  longLiqUsd15m: number;
  /** USD-weighted average fill/bankruptcy price of trailing-15m liquidations; 0 when none. */
  liqVwap15m: number;
  /** Totals since the drawer opened. */
  session: LiqTotals;
}

/* ------------------------------------------------------------------ */
/* Per-coin subscriptions (no market-wide streams)                     */
/* ------------------------------------------------------------------ */

/**
 * Binance USDⓈ-M per-symbol liquidation streams for one base asset, as one combined socket:
 * {base}USDT, {base}USDC and the 1000/1000000 size-prefixed listings Binance uses for cheap coins
 * (e.g. 1000PEPEUSDT). Unknown streams are simply silent.
 */
export function binanceStreams(base: string): string[] {
  const b = base.toLowerCase();
  return [`${b}usdt`, `${b}usdc`, `1000${b}usdt`, `1000000${b}usdt`].map((s) => `${s}@forceOrder`);
}

export function binanceUrl(base: string): string {
  return BINANCE_STREAM_BASE + binanceStreams(base).join("/");
}

/** Bybit: exactly one topic for the asset. */
export function bybitTopic(base: string): string {
  return `allLiquidation.${base}USDT`;
}

/** OKX instIds for one asset: linear (USDT) and inverse (USD) perpetuals. */
export function okxInstIds(base: string): string[] {
  return [`${base}-USDT-SWAP`, `${base}-USD-SWAP`];
}

/* OKX ctVal: fetched per asset (only that coin's instruments), cached for the session. */
const okxCtValCache = new Map<string, Promise<OkxCtValMap>>();

/**
 * ctVal for one asset's OKX swaps. Instruments that don't exist (code 51001) are skipped. A
 * network failure rejects, and the next call retries. Resolves to an empty map when OKX doesn't
 * list the coin.
 */
export function loadOkxCtVals(base: string): Promise<OkxCtValMap> {
  let p = okxCtValCache.get(base);
  if (!p) {
    p = Promise.all(
      okxInstIds(base).map(async (id) => {
        const r = await fetch(OKX_INSTRUMENT + encodeURIComponent(id), { signal: AbortSignal.timeout(15_000) });
        if (!r.ok) throw new Error(`OKX instruments HTTP ${r.status}`);
        return parseOkxInstruments(await r.json());
      }),
    )
      .then((maps) => {
        const merged = new Map<string, OkxCtValMap extends ReadonlyMap<string, infer V> ? V : never>();
        for (const m of maps) for (const [k, v] of m) merged.set(k, v);
        return merged as OkxCtValMap;
      })
      .catch((e: unknown) => {
        okxCtValCache.delete(base); // allow a later retry
        throw e;
      });
    okxCtValCache.set(base, p);
  }
  return p;
}

/**
 * Aggregates forced liquidations for one base asset from Binance, Bybit and OKX
 * (public streams, no API keys). Keeps a rolling 15-minute window and a session tape.
 * start() and stop() can be called repeatedly.
 */
export class LiquidationFeed {
  private listeners = new Set<() => void>();
  private eventListeners = new Set<(events: readonly LiqEvent[]) => void>();
  private sockets: ReconnectingSocket[] = [];
  private window: LiqEvent[] = []; // trailing 15m, oldest first
  private tape: LiqEvent[] = []; // newest first, capped
  private seen = new Set<string>();
  private session: LiqTotals = { longUsd: 0, shortUsd: 0, count: 0 };
  private status: Record<Exchange, SocketStatus> = { BN: "connecting", BYB: "connecting", OKX: "connecting" };
  private notes: Partial<Record<Exchange, string>> = {};
  private bnOpenedAt: number | null = null;
  private bnFrames = 0;
  private timers: Array<ReturnType<typeof setInterval>> = [];
  private okxRetry: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  private running = false;
  private snap: LiquidationSnapshot;

  constructor(readonly base: string) {
    this.snap = this.build();
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  getSnapshot = (): LiquidationSnapshot => this.snap;

  /**
   * Called synchronously with each batch of NEW (deduplicated) events as they arrive, without
   * waiting for the 250ms snapshot flush. Audio pings use this so they stay low-latency.
   */
  onEvents = (fn: (events: readonly LiqEvent[]) => void) => {
    this.eventListeners.add(fn);
    return () => {
      this.eventListeners.delete(fn);
    };
  };

  start(): void {
    if (this.running || !this.base) return;
    this.running = true;
    const base = this.base;

    this.sockets.push(
      new ReconnectingSocket({
        urls: [binanceUrl(base)],
        staleMs: 30 * 60_000, // per-symbol streams can be quiet for long; Binance pings at the protocol level
        onOpen: () => {},
        onMessage: (d) => {
          this.bnFrames++;
          if (this.notes.BN) this.notes = {};
          this.add(parseBinanceForceOrder(d, base));
        },
        onStatus: (s) => {
          this.bnOpenedAt = s === "open" ? Date.now() : null;
          this.setStatus("BN", s);
        },
      }),
      new ReconnectingSocket({
        urls: [BYBIT_WS],
        heartbeat: { ms: 20_000, payload: JSON.stringify({ op: "ping" }) },
        onOpen: (send) => send(JSON.stringify({ op: "subscribe", args: [bybitTopic(base)] })),
        onMessage: (d) => {
          if (d.includes('"op":"subscribe"') && d.includes('"success":false')) {
            this.notes = { ...this.notes, BYB: `No Bybit perpetual ${base}USDT` };
            this.dirty = true;
          }
          this.add(parseBybitLiquidation(d, base));
        },
        onStatus: (s) => this.setStatus("BYB", s),
      }),
    );
    this.connectOkx(0);

    this.timers.push(
      setInterval(() => this.flush(), FLUSH_MS),
      setInterval(() => {
        if (this.prune()) this.dirty = true;
        this.checkBinanceSilence();
      }, PRUNE_MS),
    );
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    for (const s of this.sockets) s.close();
    this.sockets = [];
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    if (this.okxRetry) clearTimeout(this.okxRetry);
    this.okxRetry = null;
  }

  private connectOkx(attempt: number) {
    loadOkxCtVals(this.base)
      .then((ctVals) => {
        if (!this.running) return;
        const base = this.base;
        if (ctVals.size === 0) {
          // OKX doesn't list this asset: open no socket at all.
          this.notes = { ...this.notes, OKX: `Not listed on OKX (${base}-USDT/USD-SWAP)` };
          this.setStatus("OKX", "closed");
          return;
        }
        this.sockets.push(
          new ReconnectingSocket({
            urls: OKX_WS,
            heartbeat: { ms: 20_000, payload: "ping" },
            onOpen: (send) => send(JSON.stringify({ op: "subscribe", args: [{ channel: "liquidation-orders", instType: "SWAP" }] })),
            onMessage: (d) => {
              if (d !== "pong") this.add(parseOkxLiquidation(d, base, ctVals));
            },
            onStatus: (s) => this.setStatus("OKX", s),
          }),
        );
      })
      .catch(() => {
        if (!this.running) return;
        // Without ctVal there is no accurate USD conversion, so don't stream. Retry the metadata load instead.
        this.setStatus("OKX", "error");
        this.okxRetry = setTimeout(() => this.connectOkx(attempt + 1), Math.min(60_000, 5_000 * 2 ** attempt));
      });
  }

  private checkBinanceSilence() {
    if (this.bnFrames > 0 || this.bnOpenedAt === null || this.notes.BN) return;
    if (Date.now() - this.bnOpenedAt < BN_SILENCE_MS) return;
    this.notes = { ...this.notes, BN: "No Binance liquidations yet (quiet market, or region-restricted: HTTP 451)" };
    this.dirty = true;
  }

  private setStatus(ex: Exchange, s: SocketStatus) {
    if (!this.running && s !== "closed") return;
    if (this.status[ex] === s) return;
    this.status = { ...this.status, [ex]: s };
    this.dirty = true;
  }

  private add(events: LiqEvent[]) {
    if (!events.length) return;
    const cutoff = Date.now() - WINDOW_15M_MS;
    const fresh: LiqEvent[] = [];
    for (const e of events) {
      if (this.seen.has(e.id)) continue;
      this.seen.add(e.id);
      fresh.push(e);
      this.session.count++;
      if (e.side === "LONG") this.session.longUsd += e.usd;
      else this.session.shortUsd += e.usd;
      this.tape.unshift(e);
      if (e.ts >= cutoff) this.window.push(e);
    }
    if (this.tape.length > TAPE_MAX) this.tape.length = TAPE_MAX;
    this.window.sort((a, b) => a.ts - b.ts);
    if (this.seen.size > 5_000) this.seen = new Set(this.tape.map((e) => e.id));
    if (fresh.length === 0) return;
    this.dirty = true;
    for (const fn of this.eventListeners) {
      try {
        fn(fresh);
      } catch {
        /* a listener (e.g. audio) must never break ingestion */
      }
    }
  }

  /** Drops events older than 15 minutes. Returns whether anything was removed. */
  private prune(): boolean {
    const cutoff = Date.now() - WINDOW_15M_MS;
    let i = 0;
    while (i < this.window.length && this.window[i].ts < cutoff) i++;
    if (i > 0) this.window.splice(0, i);
    return i > 0;
  }

  private build(): LiquidationSnapshot {
    const cutoff = Date.now() - WINDOW_15M_MS;
    const totals = totalsSince(this.window, cutoff);
    return {
      shortLiqUsd15m: totals.shortUsd,
      longLiqUsd15m: totals.longUsd,
      liqVwap15m: liquidationVwap(this.window, cutoff),
      base: this.base,
      status: this.status,
      notes: this.notes,
      tape: this.tape.slice(),
      window15m: totals,
      windowEvents: this.window.slice(),
      session: { ...this.session },
    };
  }

  private flush() {
    if (!this.dirty) return;
    this.dirty = false;
    this.snap = this.build();
    for (const l of this.listeners) l();
  }
}

export { EXCHANGES };
