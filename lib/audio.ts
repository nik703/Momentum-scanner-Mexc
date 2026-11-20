/** Zero-asset Web Audio chime: 880Hz -> 1320Hz sine, 180ms exponential envelope per tone. */
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

function tone(c: AudioContext, freq: number, at: number, peak: number) {
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(freq, at);
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(peak, at + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.18);
  osc.connect(gain).connect(c.destination);
  osc.start(at);
  osc.stop(at + 0.2);
}

export function playChime() {
  const c = getCtx();
  if (!c || c.state !== "running") return;
  const t = c.currentTime + 0.01;
  tone(c, 880, t, 0.18);
  tone(c, 1320, t + 0.09, 0.16);
}
