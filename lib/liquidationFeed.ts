import {
  EXCHANGES,
  parseBinanceForceOrder,
  parseBybitLiquidation,
  parseOkxInstruments,
  parseOkxLiquidation,
  totalsSince,
  WINDOW_15M_MS,
  type Exchange,
  type LiqEvent,
  type LiqTotals,
  type OkxCtValMap,
} from "./liquidations.ts";
import { ReconnectingSocket, type SocketStatus } from "./reconnectingSocket.ts";

const BINANCE_WS = "wss://fstream.binance.com/ws/!forceOrder@arr";
const BYBIT_WS = "wss://stream.bybit.com/v5/public/linear";
// OKX serves the same public API on :443 and :8443. :443 goes first because corporate and
// mobile firewalls often block :8443. Reconnects rotate to the documented :8443 endpoint.
const OKX_WS = ["wss://ws.okx.com/ws/v5/public", "wss://ws.okx.com:8443/ws/v5/public"] as const;
const OKX_INSTRUMENTS = "https://www.okx.com/api/v5/public/instruments?instType=SWAP";

const TAPE_MAX = 200;
/**
 * Binance answers restricted regions (e.g. the US) with HTTP 451 on REST, but its WebSocket
 * still opens and then sends nothing. The all-market !forceOrder@arr stream normally delivers
 * frames within a minute or two, so a long silence while "open" is reported as a problem
 * instead of a misleading green dot.
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
  /** Totals since the drawer opened. */
  session: LiqTotals;
}

/* ------------------------------------------------------------------ */
/* Shared Binance all-market stream (ref-counted)                      */
/* !forceOrder@arr carries every symbol, so one connection serves any base asset. */
/* Switching contracts reuses it. It closes BINANCE_GRACE_MS after the last feed  */
/* releases it (i.e. when the drawer closes).                                     */
/* ------------------------------------------------------------------ */
const BINANCE_GRACE_MS = 1_500;

interface BinanceListener {
  onMessage: (d: string) => void;
  onStatus: (s: SocketStatus) => void;
}

const binance = {
  socket: null as ReconnectingSocket | null,
  listeners: new Set<BinanceListener>(),
  status: "connecting" as SocketStatus,
  openedAt: null as number | null,
  frames: 0,
  closeTimer: null as ReturnType<typeof setTimeout> | null,
};

function acquireBinance(l: BinanceListener): () => void {
  if (binance.closeTimer) {
    clearTimeout(binance.closeTimer);
    binance.closeTimer = null;
  }
  binance.listeners.add(l);
  if (!binance.socket) {
    binance.frames = 0;
    binance.status = "connecting";
    binance.socket = new ReconnectingSocket({
      urls: [BINANCE_WS],
      staleMs: 30 * 60_000, // the stream can be silent for long stretches; Binance pings at the protocol level
      onOpen: () => {},
      onMessage: (d) => {
        binance.frames++;
        for (const x of binance.listeners) x.onMessage(d);
      },
      onStatus: (st) => {
        binance.status = st;
        binance.openedAt = st === "open" ? Date.now() : null;
        for (const x of binance.listeners) x.onStatus(st);
      },
    });
  }
  l.onStatus(binance.status);
  return () => {
    binance.listeners.delete(l);
    if (binance.listeners.size > 0 || binance.closeTimer) return;
    binance.closeTimer = setTimeout(() => {
      binance.closeTimer = null;
      if (binance.listeners.size > 0) return;
      binance.socket?.close();
      binance.socket = null;
      binance.openedAt = null;
    }, BINANCE_GRACE_MS);
  };
}

/* ------------------------------------------------------------------ */
/* OKX ctVal cache: fetched once per browser session                  */
/* ------------------------------------------------------------------ */
let okxCtVals: Promise<OkxCtValMap> | null = null;

export function loadOkxCtVals(): Promise<OkxCtValMap> {
  if (!okxCtVals) {
    okxCtVals = fetch(OKX_INSTRUMENTS, { signal: AbortSignal.timeout(15_000) })
      .then((r) => {
        if (!r.ok) throw new Error(`OKX instruments HTTP ${r.status}`);
        return r.json() as Promise<unknown>;
      })
      .then((j) => {
        const map = parseOkxInstruments(j);
        if (map.size === 0) throw new Error("OKX instruments empty");
        return map;
      })
      .catch((e: unknown) => {
        okxCtVals = null; // allow a later retry
        throw e;
      });
  }
  return okxCtVals;
}

/** Bybit topics to try. MEXC may list PEPE while Bybit lists 1000PEPE. Unknown topics are rejected harmlessly. */
export function bybitTopics(base: string): string[] {
  return [base, `1000${base}`, `10000${base}`, `1000000${base}`].map((b) => `allLiquidation.${b}USDT`);
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
  private releaseBinance: (() => void) | null = null;
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

    this.releaseBinance = acquireBinance({
      onMessage: (d) => {
        if (this.notes.BN) {
          this.notes = {};
          this.setStatus("BN", "open");
        }
        this.add(parseBinanceForceOrder(d, base));
      },
      onStatus: (s) => this.setStatus("BN", s),
    });
    this.sockets.push(
      new ReconnectingSocket({
        urls: [BYBIT_WS],
        heartbeat: { ms: 20_000, payload: JSON.stringify({ op: "ping" }) },
        onOpen: (send) => {
          for (const topic of bybitTopics(base)) send(JSON.stringify({ op: "subscribe", args: [topic] }));
        },
        onMessage: (d) => this.add(parseBybitLiquidation(d, base)),
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
    this.releaseBinance?.();
    this.releaseBinance = null;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    if (this.okxRetry) clearTimeout(this.okxRetry);
    this.okxRetry = null;
  }

  private connectOkx(attempt: number) {
    loadOkxCtVals()
      .then((ctVals) => {
        if (!this.running) return;
        const base = this.base;
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
    if (binance.frames > 0 || binance.openedAt === null || this.notes.BN) return;
    if (Date.now() - binance.openedAt < BN_SILENCE_MS) return;
    this.notes = { ...this.notes, BN: "Connected but silent: Binance may block this region (HTTP 451)" };
    this.setStatus("BN", "error");
  }

  private setStatus(ex: Exchange, s: SocketStatus) {
    if (!this.running && s !== "closed") return;
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
    return {
      base: this.base,
      status: this.status,
      notes: this.notes,
      tape: this.tape.slice(),
      window15m: totalsSince(this.window, Date.now() - WINDOW_15M_MS),
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
