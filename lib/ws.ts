import type { WsStatus } from "./types.ts";
import type { WsTicker } from "./store.ts";

const WS_URL = "wss://contract.mexc.com/edge";
const PING_MS = 15_000;
const STALE_MS = 45_000;
const BACKOFF_BASE = 1_000;
const BACKOFF_MAX = 30_000;

export interface WsHandlers {
  onTickers: (ticks: WsTicker[]) => void;
  onStatus: (s: WsStatus) => void;
  onReconnected?: () => void;
}

/**
 * Single-stream MEXC futures ticker feed (`sub.tickers`) with keep-alive pings,
 * stale-socket detection and jittered exponential-backoff reconnects.
 */
export class MexcTickerSocket {
  private ws: WebSocket | null = null;
  private attempts = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private lastMsgAt = 0;
  private closed = false;
  private everConnected = false;

  constructor(private h: WsHandlers) {}

  connect() {
    this.closed = false;
    this.open();
  }

  close() {
    this.closed = true;
    this.clearTimers();
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
    }
    this.ws = null;
  }

  /** Force an immediate reconnect (e.g. tab became visible with a dead socket). */
  nudge() {
    if (this.closed) return;
    const dead = !this.ws || this.ws.readyState > WebSocket.OPEN;
    const stale = Date.now() - this.lastMsgAt > STALE_MS;
    if (dead || stale) {
      this.attempts = 0;
      this.restart();
    }
  }

  private open() {
    this.clearTimers();
    this.h.onStatus(this.everConnected ? "RECONNECTING" : "CONNECTING");
    let ws: WebSocket;
    try {
      ws = new WebSocket(WS_URL);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.lastMsgAt = Date.now();
      ws.send(JSON.stringify({ method: "sub.tickers", param: {}, gzip: false }));
      this.pingTimer = setInterval(() => {
        if (Date.now() - this.lastMsgAt > STALE_MS) return this.restart();
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ method: "ping" }));
      }, PING_MS);
    };

    ws.onmessage = (ev) => {
      this.lastMsgAt = Date.now();
      if (typeof ev.data !== "string") return;
      let msg: { channel?: string; data?: unknown };
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (Array.isArray(msg.data)) {
        if (this.attempts > 0 || !this.everConnected) {
          const wasReconnect = this.everConnected;
          this.attempts = 0;
          this.everConnected = true;
          if (wasReconnect) this.h.onReconnected?.();
        }
        this.h.onStatus("CONNECTED");
        this.h.onTickers(msg.data as WsTicker[]);
      } else if (msg.channel === "rs.sub.tickers") {
        this.h.onStatus("CONNECTED");
      }
    };

    ws.onerror = () => {
      /* onclose follows and handles the retry */
    };

    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      if (!this.closed) this.scheduleRetry();
    };
  }

  private restart() {
    if (this.ws) {
      this.ws.onclose = null;
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    this.scheduleRetry();
  }

  private scheduleRetry() {
    this.clearTimers();
    if (this.closed) return;
    this.h.onStatus(this.everConnected ? "RECONNECTING" : "CONNECTING");
    const exp = Math.min(BACKOFF_MAX, BACKOFF_BASE * 2 ** this.attempts);
    const delay = exp / 2 + Math.random() * (exp / 2);
    this.attempts++;
    this.retryTimer = setTimeout(() => this.open(), delay);
  }

  private clearTimers() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.pingTimer = null;
    this.retryTimer = null;
  }
}
