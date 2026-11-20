/** Ranks 1..ALERT_ZONE are the alert zone. */
export const ALERT_ZONE = 10;
/** Ranks 1..HYSTERESIS_ZONE stay in the known set (the re-arm band). */
export const HYSTERESIS_ZONE = 15;

/** Silent seeding: replace the registry with the current Ranks 1–15. */
export function seedKnownTop15(known: Set<string>, ranked: readonly string[]): void {
  known.clear();
  for (let i = 0; i < Math.min(HYSTERESIS_ZONE, ranked.length); i++) known.add(ranked[i]);
}

/**
 * Live evaluation + hysteresis eviction for one board.
 *
 * 1. Every symbol in Ranks 1–10 that is NOT in `known` is a fresh entry. A move
 *    up from Ranks 11–15 is already known, so it does not count.
 * 2. Then all current Ranks 1–15 are added to `known`. A symbol is removed only
 *    once its rank is above 15 or it is filtered out of the ranking. This stops
 *    a contract bouncing between Rank 9 and Rank 13 from re-triggering.
 *
 * Mutates `known` in place and returns the fresh entries in rank order.
 */
export function evaluateTop10Entries(known: Set<string>, ranked: readonly string[]): string[] {
  const entered: string[] = [];
  for (let i = 0; i < Math.min(ALERT_ZONE, ranked.length); i++) {
    if (!known.has(ranked[i])) entered.push(ranked[i]);
  }
  const top15 = new Set(ranked.slice(0, HYSTERESIS_ZONE));
  for (const s of known) if (!top15.has(s)) known.delete(s);
  for (const s of top15) known.add(s);
  return entered;
}
