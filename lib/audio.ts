/**
 * Asset-free Web Audio alert sounds. Every alert uses the same timbre: a sine oscillator with a
 * click-free exponential gain envelope (setValueAtTime -> exponentialRamp to peak ->
 * exponentialRampToValueAtTime(0.0001)).
 *
 *   playLeaderboardPing()  880 -> 1320 Hz, upward, 180ms per tone   (Top 10 entry)
 *   playShortLiqPing()     880 -> 1245 Hz, ascending, 160ms total   (short squeezed: forced buy, bullish)
 *   playLongLiqPing()      740 ->  554 Hz, descending, 160ms total  (long flushed: forced sell, bearish)
 *
 * Liquidation pings go through a 90ms cadence scheduler, so simultaneous fills across
 * Binance, Bybit and OKX play in sequence instead of stacking and clipping.
 */
let ctx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
  }
  return ctx;
}

/** Must be called from a user gesture at least once to satisfy autoplay policies. */
export async function unlockAudio(): Promise<boolean> {
  const c = getCtx();
  if (!c) return false;
  if (c.state === "suspended") {
    try {
      await c.resume();
    } catch {
      return false;
    }
  }
  return c.state === "running";
}

export function isAudioUnlocked(): boolean {
  return ctx?.state === "running";
}

const ATTACK_S = 0.008;
const SILENCE = 0.0001;

/** One sine note with a click-free exponential attack and decay. `decay` is the note length in seconds. */
function tone(c: AudioContext, freq: number, at: number, peak: number, decay: number) {
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(freq, at);
  gain.gain.setValueAtTime(SILENCE, at);
  gain.gain.exponentialRampToValueAtTime(peak, at + ATTACK_S);
  gain.gain.exponentialRampToValueAtTime(SILENCE, at + decay);
  osc.connect(gain).connect(c.destination);
  osc.start(at);
  osc.stop(at + decay + 0.02);
}

function runningCtx(): AudioContext | null {
  const c = getCtx();
  return c && c.state === "running" ? c : null;
}

/** Top 10 leaderboard entry: crisp upward two-tone (880 -> 1320 Hz), 180ms envelope per tone. */
export function playLeaderboardPing(): void {
  const c = runningCtx();
  if (!c) return;
  const t = c.currentTime + 0.01;
  tone(c, 880, t, 0.18, 0.18);
  tone(c, 1320, t + 0.09, 0.16, 0.18);
}

/* ------------------------------------------------------------------ */
/* Liquidation pings + 90ms cadence limiter                            */
/* ------------------------------------------------------------------ */

export const LIQ_PING_SPACING_S = 0.09;
/** Most queued lag allowed (8 pings). Past it, extra fills in a cascade are dropped, not queued. */
export const LIQ_PING_MAX_BACKLOG_S = 0.72;
const LIQ_NOTE_S = 0.09; // note 1 at 0ms, note 2 at 70ms; each lasts 90ms, so 160ms total
const LIQ_NOTE2_OFFSET_S = 0.07;
const LIQ_PEAK = 0.13; // lower than the leaderboard ping: two overlapping liq pings stay under 0.5 gain

/**
 * Pure cadence scheduler. Given the audio clock and the next free slot, it returns when to play
 * and the following free slot, or null when the backlog is already too long.
 */
export function nextPingSlot(
  now: number,
  nextFree: number,
  spacing = LIQ_PING_SPACING_S,
  maxBacklog = LIQ_PING_MAX_BACKLOG_S,
): { at: number; nextFree: number } | null {
  const at = Math.max(now, nextFree);
  if (at - now > maxBacklog) return null;
  return { at, nextFree: at + spacing };
}

let liqNextFree = 0;

function playLiq(f1: number, f2: number): boolean {
  const c = runningCtx();
  if (!c) return false;
  const slot = nextPingSlot(c.currentTime + 0.005, liqNextFree);
  if (!slot) return false;
  liqNextFree = slot.nextFree;
  tone(c, f1, slot.at, LIQ_PEAK, LIQ_NOTE_S);
  tone(c, f2, slot.at + LIQ_NOTE2_OFFSET_S, LIQ_PEAK, LIQ_NOTE_S);
  return true;
}

/** Short liquidated (forced buy, upward squeeze): ascending 880 -> 1245 Hz. */
export function playShortLiqPing(): boolean {
  return playLiq(880, 1245);
}

/** Long liquidated (forced sell, downward flush): descending 740 -> 554 Hz. */
export function playLongLiqPing(): boolean {
  return playLiq(740, 554);
}
