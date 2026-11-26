import { MAX_FRAME_CHARS } from "./sanitize.ts";

export type SocketStatus = "connecting" | "open" | "reconnecting" | "error" | "closed";

export interface ReconnectingSocketOptions {
  /** URLs tried in rotation. A fallback port helps behind firewalls that block :8443. */
  urls: readonly string[];
  /** Runs on every (re)connect: subscribe here. */
  onOpen: (send: (data: string) => void) => void;
  onMessage: (data: string) => void;
  onStatus?: (s: SocketStatus) => void;
  /** Heartbeat payload sent every `heartbeatMs` while open. */
  heartbeat?: { ms: number; payload: string };
  /** Reconnect if nothing is received for this long (default 60s). */
  staleMs?: number;
}

const BACKOFF_BASE = 1_000;
const BACKOFF_MAX = 30_000;

/**
 * Small, dependency-free WebSocket wrapper: heartbeat, stale detection, jittered
 * exponential backoff and URL rotation. `close()` is final: it clears every timer
 * and detaches all handlers, so nothing can fire after the owner unmounts.
 */
export class ReconnectingSocket {
  private ws: WebSocket | null = null;
  private attempts = 0;
  private urlIndex = 0;
  private hbTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private lastMsgAt = 0;
  private closed = false;
  private status: SocketStatus = "connecting";

  constructor(private readonly opts: ReconnectingSocketOptions) {
    this.open();
  }

  /** Sends only while the socket is OPEN. Returns whether it was sent. */
  send = (data: string): boolean => {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(data);
      return true;
    }
    return false;
  };

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
      try {
        ws.close(1000, "closed by client");
      } catch {
        /* already closing */
      }
    }
    this.setStatus("closed");
  }

  private setStatus(s: SocketStatus) {
    if (this.status === s) return;
    this.status = s;
    this.opts.onStatus?.(s);
  }

  private open() {
    if (this.closed) return;
    this.clearTimers();
    const url = this.opts.urls[this.urlIndex % this.opts.urls.length];
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.attempts = 0;
      this.lastMsgAt = Date.now();
      this.setStatus("open");
      this.opts.onOpen(this.send);
      const hb = this.opts.heartbeat;
      const stale = this.opts.staleMs ?? 60_000;
      this.hbTimer = setInterval(
        () => {
          if (Date.now() - this.lastMsgAt > stale) {
            this.restart();
            return;
          }
          if (hb) this.send(hb.payload);
        },
        hb?.ms ?? 15_000,
      );
    };
    ws.onmessage = (ev: MessageEvent) => {
      this.lastMsgAt = Date.now();
      // Text frames only (binary blobs are ignored), and oversized frames are dropped unparsed.
      if (typeof ev.data !== "string" || ev.data.length > MAX_FRAME_CHARS) return;
      try {
        this.opts.onMessage(ev.data);
      } catch {
        /* a malformed frame must never escape into the event loop or stop later frames */
      }
    };
    ws.onerror = () => {
      /* onclose follows */
    };
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      this.scheduleRetry();
    };
  }

  private restart() {
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
    this.scheduleRetry();
  }

  private scheduleRetry() {
    this.clearTimers();
    if (this.closed) return;
    this.setStatus(this.attempts >= 3 ? "error" : "reconnecting");
    this.urlIndex++;
    const exp = Math.min(BACKOFF_MAX, BACKOFF_BASE * 2 ** this.attempts);
    this.attempts++;
    this.retryTimer = setTimeout(() => this.open(), exp / 2 + Math.random() * (exp / 2));
  }

  private clearTimers() {
    if (this.hbTimer) clearInterval(this.hbTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.hbTimer = null;
    this.retryTimer = null;
  }
}
