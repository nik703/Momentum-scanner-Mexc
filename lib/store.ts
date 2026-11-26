import { computeTf, liveDeltaTurnover, rollCandles, type SymbolState } from "./calculator.ts";
import { MAX_PRICE, priceNum } from "./sanitize.ts";
import type { BootstrapPayload, BootstrapSymbol, ScannerRow, WsStatus } from "./types.ts";

const finiteArr = (a: unknown): a is number[] => Array.isArray(a) && a.every((x) => typeof x === "number" && Number.isFinite(x));
/** A bootstrap row is used only if every number in it is finite and the series line up. */
function validBootstrapSymbol(s: BootstrapSymbol): boolean {
  if (typeof s !== "object" || s === null || typeof s.symbol !== "string" || s.symbol.length > 30) return false;
  if (priceNum(s.lastPrice) === null || !Number.isFinite(s.amount24) || !Number.isFinite(s.volume24)) return false;
  const k = s.k;
  if (typeof k !== "object" || k === null || !finiteArr(k.t) || !finiteArr(k.o) || !finiteArr(k.c) || !finiteArr(k.a)) return false;
  return k.t.length > 0 && k.o.length === k.t.length && k.c.length === k.t.length && k.a.length === k.t.length;
}
const finiteNonNeg = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

export interface ScannerSnapshot {
  rows: ScannerRow[];
  status: WsStatus;
  tracked: number;
  lastTickAt: number | null;
  bootstrapAt: number | null;
  /** Time of the flush that produced this snapshot (drives NEW-tag expiry). */
  flushedAt: number;
  error: string | null;
}

export interface WsTicker {
  symbol: string;
  lastPrice: number;
  amount24?: number;
  volume24?: number;
}

const FLUSH_MS = 250;

/**
 * Framework-agnostic store. WebSocket ticks mutate per-symbol state in place
 * (O(1), no allocation churn) and mark the store dirty; a 250ms flush loop
 * rebuilds the row snapshot at most 4x/s and notifies React subscribers once.
 */
export class ScannerStore {
  private syms = new Map<string, SymbolState>();
  private prevRows = new Map<string, ScannerRow>();
  private listeners = new Set<() => void>();
  private dirty = false;
  private paused = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private snapshot: ScannerSnapshot = {
    rows: [],
    status: "CONNECTING",
    tracked: 0,
    lastTickAt: null,
    bootstrapAt: null,
    flushedAt: 0,
    error: null,
  };
  private meta = {
    status: "CONNECTING" as WsStatus,
    lastTickAt: null as number | null,
    bootstrapAt: null as number | null,
    error: null as string | null,
  };

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = () => this.snapshot;

  start() {
    if (this.timer || this.paused) return;
    this.timer = setInterval(() => this.flush(), FLUSH_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Single-coin focus mode: stop the 250ms flush entirely, so there are no candle rolls, row
   * rebuilds or snapshot emits, and the leaderboards never re-sort or re-render. Data that
   * arrives meanwhile (e.g. an in-flight bootstrap) is kept and published on resume().
   */
  pause() {
    this.paused = true;
    this.stop();
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    this.dirty = true;
    this.start();
  }

  get isPaused() {
    return this.paused;
  }

  /** Hydrate (first call) or reconcile (subsequent calls) from /api/scanner. */
  applyBootstrap(p: BootstrapPayload) {
    if (this.meta.bootstrapAt && p.generatedAt <= this.meta.bootstrapAt) return; // stale CDN copy
    const next = new Map<string, SymbolState>();
    for (const s of p.symbols) {
      if (!validBootstrapSymbol(s)) continue;
      const prev = this.syms.get(s.symbol);
      // Keep the freshest price: a WS tick newer than the snapshot wins.
      const price = prev && (this.meta.lastTickAt ?? 0) > p.generatedAt ? prev.price : s.lastPrice;
      const st: SymbolState = {
        symbol: s.symbol,
        price,
        amount24: prev?.amount24 ?? s.amount24,
        volume24: prev?.volume24 ?? s.volume24,
        t: s.k.t.slice(),
        o: s.k.o.slice(),
        c: s.k.c.slice(),
        a: s.k.a.slice(),
        anchorAmount24: s.amount24,
        anchorVolume24: s.volume24,
        liveDelta: 0,
      };
      if (prev) {
        st.liveDelta = liveDeltaTurnover(st, {
          amount24: prev.amount24,
          volume24: prev.volume24,
          lastPrice: price,
        });
      }
      rollCandles(st, Date.now());
      next.set(s.symbol, st);
    }
    this.syms = next;
    this.meta.bootstrapAt = p.generatedAt;
    this.meta.error = null;
    this.dirty = true;
    this.flush();
  }

  applyTickers(ticks: WsTicker[]) {
    let touched = false;
    for (const tk of ticks) {
      if (typeof tk !== "object" || tk === null || typeof tk.symbol !== "string") continue;
      const st = this.syms.get(tk.symbol);
      // 1e999 in JSON parses to Infinity; strings, NaN and absurd values are dropped too.
      if (!st || !(typeof tk.lastPrice === "number" && Number.isFinite(tk.lastPrice) && tk.lastPrice > 0 && tk.lastPrice <= MAX_PRICE)) continue;
      const clean: WsTicker = {
        symbol: tk.symbol,
        lastPrice: tk.lastPrice,
        amount24: finiteNonNeg(tk.amount24) ? tk.amount24 : undefined,
        volume24: finiteNonNeg(tk.volume24) ? tk.volume24 : undefined,
      };
      st.price = clean.lastPrice;
      st.liveDelta = liveDeltaTurnover(st, clean);
      if (clean.amount24 !== undefined) st.amount24 = clean.amount24;
      if (clean.volume24 !== undefined) st.volume24 = clean.volume24;
      touched = true;
    }
    if (touched) {
      this.meta.lastTickAt = Date.now();
      this.dirty = true;
    }
  }

  setStatus(status: WsStatus) {
    if (this.meta.status === status) return;
    this.meta.status = status;
    this.dirty = true;
  }

  setError(error: string | null) {
    this.meta.error = error;
    this.dirty = true;
    this.flush();
  }

  get hasData() {
    return this.syms.size > 0;
  }

  private flush() {
    if (this.paused) return;
    const now = Date.now();
    for (const st of this.syms.values()) {
      if (rollCandles(st, now)) this.dirty = true;
    }
    if (!this.dirty) return;
    this.dirty = false;

    const rows: ScannerRow[] = [];
    const nextPrev = new Map<string, ScannerRow>();
    for (const st of this.syms.values()) {
      const prev = this.prevRows.get(st.symbol);
      let tickDir: ScannerRow["tickDir"] = prev?.tickDir ?? 0;
      let tickSeq = prev?.tickSeq ?? 0;
      if (prev && prev.price !== st.price) {
        tickDir = st.price > prev.price ? 1 : -1;
        tickSeq++;
      }
      const row: ScannerRow = {
        symbol: st.symbol,
        price: st.price,
        amount24: st.amount24,
        tickDir,
        tickSeq,
        tf: {
          "15M": computeTf(st, "15M"),
          "30M": computeTf(st, "30M"),
          "1H": computeTf(st, "1H"),
        },
      };
      rows.push(row);
      nextPrev.set(st.symbol, row);
    }
    this.prevRows = nextPrev;
    this.snapshot = {
      rows,
      status: this.meta.status,
      tracked: rows.length,
      lastTickAt: this.meta.lastTickAt,
      bootstrapAt: this.meta.bootstrapAt,
      flushedAt: now,
      error: this.meta.error,
    };
    for (const l of this.listeners) l();
  }
}
