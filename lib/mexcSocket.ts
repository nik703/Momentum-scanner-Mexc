import { ReconnectingSocket, type SocketStatus } from "./reconnectingSocket.ts";
import { safeJsonParse } from "./sanitize.ts";

/**
 * The app's ONE connection to wss://contract.mexc.com/edge.
 *
 * - A single 15s `{"method":"ping"}` heartbeat and a single reconnect loop (ReconnectingSocket).
 * - A registry of the channels the app currently WANTS. It is driven entirely by `setFocus`:
 *     focus = null    -> scanner mode:      sub.tickers (market-wide)
 *     focus = SYMBOL  -> single-coin mode:  sub.ticker + sub.kline(Min1) + sub.deal for SYMBOL
 *   On every (re)connect the whole registry is re-sent, so the active mode survives drops.
 * - Mode changes are diffed: unsub frames for channels being dropped are always sent BEFORE sub
 *   frames for new ones (unsub.tickers -> sub.ticker/kline/deal; unsub prev -> sub next).
 * - Consumers attach message listeners; they never subscribe or open sockets themselves.
 */

export const MEXC_WS_URL = "wss://contract.mexc.com/edge";

export interface ChannelSpec {
  /** Registry key, e.g. "tickers" or "deal:BTC_USDT". */
  key: string;
  sub: string;
  unsub: string;
}

const frame = (method: string, param: Record<string, unknown>) => JSON.stringify({ method, param });

export function tickersChannels(): ChannelSpec[] {
  return [{ key: "tickers", sub: frame("sub.tickers", {}), unsub: frame("unsub.tickers", {}) }];
}

export function focusChannels(symbol: string): ChannelSpec[] {
  return [
    { key: `ticker:${symbol}`, sub: frame("sub.ticker", { symbol }), unsub: frame("unsub.ticker", { symbol }) },
    {
      key: `kline:${symbol}`,
      sub: frame("sub.kline", { symbol, interval: "Min1" }),
      unsub: frame("unsub.kline", { symbol, interval: "Min1" }),
    },
    {
      key: `deal:${symbol}`,
      sub: frame("sub.deal", { symbol, compress: false, reduce: false }),
      unsub: frame("unsub.deal", { symbol, compress: false, reduce: false }),
    },
  ];
}

/** Frames to move from one channel set to another: every unsub first, then every sub. */
export function diffChannels(prev: readonly ChannelSpec[], next: readonly ChannelSpec[]): string[] {
  const nextKeys = new Set(next.map((c) => c.key));
  const prevKeys = new Set(prev.map((c) => c.key));
  return [
    ...prev.filter((c) => !nextKeys.has(c.key)).map((c) => c.unsub),
    ...next.filter((c) => !prevKeys.has(c.key)).map((c) => c.sub),
  ];
}

export type MexcMessage = Record<string, unknown> & { channel: string };
type Listener = (msg: MexcMessage) => void;

class MexcMultiplexer {
  private socket: ReconnectingSocket | null = null;
  private registry: ChannelSpec[] = [];
  private focus: string | null | undefined = undefined; // undefined = not started
  private listeners = new Set<Listener>();
  private statusListeners = new Set<(s: SocketStatus) => void>();
  private connectedListeners = new Set<(reconnect: boolean) => void>();
  private status: SocketStatus = "connecting";
  private opens = 0;

  /** Switches mode. `null` = scanner (sub.tickers); a symbol = single-coin channels for it. */
  setFocus(symbol: string | null): void {
    if (symbol === this.focus) return;
    this.focus = symbol;
    this.apply(symbol === null ? tickersChannels() : focusChannels(symbol));
  }

  /** Drops the single-coin channels for a focus that turned out invalid (404), keeping focus mode. */
  dropFocusChannels(symbol: string): void {
    if (this.focus !== symbol) return;
    this.apply([]);
  }

  getFocus(): string | null | undefined {
    return this.focus;
  }

  /** Current desired channel keys (exposed for diagnostics/tests). */
  activeChannels(): string[] {
    return this.registry.map((c) => c.key);
  }

  getStatus(): SocketStatus {
    return this.status;
  }

  addListener(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  onStatus(fn: (s: SocketStatus) => void): () => void {
    this.statusListeners.add(fn);
    fn(this.status);
    return () => {
      this.statusListeners.delete(fn);
    };
  }

  /** Fires after the registry has been (re)sent on each open; `reconnect` is false for the first open. */
  onConnected(fn: (reconnect: boolean) => void): () => void {
    this.connectedListeners.add(fn);
    return () => {
      this.connectedListeners.delete(fn);
    };
  }

  private apply(next: ChannelSpec[]) {
    const frames = diffChannels(this.registry, next);
    this.registry = next;
    this.ensureSocket();
    // Frames are sent only while OPEN. If not open yet, onOpen sends the full registry.
    if (this.socket) for (const f of frames) this.socket.send(f);
  }

  private ensureSocket() {
    if (this.socket || typeof window === "undefined") return;
    this.socket = new ReconnectingSocket({
      urls: [MEXC_WS_URL],
      heartbeat: { ms: 15_000, payload: JSON.stringify({ method: "ping" }) },
      staleMs: 45_000,
      onOpen: (send) => {
        for (const c of this.registry) send(c.sub);
        const reconnect = this.opens++ > 0;
        for (const fn of this.connectedListeners) fn(reconnect);
      },
      onMessage: (raw) => {
        // Size-capped, prototype-key-stripping parse; undefined for "pong"-style or invalid frames.
        const msg = safeJsonParse(raw);
        if (typeof msg !== "object" || msg === null || Array.isArray(msg)) return;
        const m = msg as Record<string, unknown>;
        if (typeof m.channel !== "string" || m.channel.length > 64) return;
        for (const fn of this.listeners) {
          try {
            fn(m as MexcMessage);
          } catch {
            /* one consumer's failure must not starve the others (scanner board vs drawer feed) */
          }
        }
      },
      onStatus: (s) => {
        this.status = s;
        for (const fn of this.statusListeners) fn(s);
      },
    });
  }
}

/** App-wide singleton (browser only). */
export const mexcSocket = new MexcMultiplexer();
