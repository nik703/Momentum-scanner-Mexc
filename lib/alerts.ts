export const ALERT_ZONE = 10;
export const HYSTERESIS_ZONE = 15;

/**
 * Top-15 hysteresis registry for one leaderboard. A symbol only "enters" when
 * it reaches the Top 10 without having been in the previous Top 15, so
 * contracts oscillating around rank 10 never re-trigger. To re-arm, a contract
 * must fall out of the Top 15 first.
 */
export class Top15Tracker {
  private known = new Set<string>();
  private seeded = false;

  reset() {
    this.known.clear();
    this.seeded = false;
  }

  get isSeeded() {
    return this.seeded;
  }

  /** Returns symbols that freshly entered the Top 10 from outside the Top 15. */
  update(ranked: readonly string[]): string[] {
    const top15 = ranked.slice(0, HYSTERESIS_ZONE);
    if (!this.seeded) {
      this.known = new Set(top15);
      this.seeded = ranked.length > 0;
      return [];
    }
    const entered: string[] = [];
    for (let i = 0; i < Math.min(ALERT_ZONE, ranked.length); i++) {
      if (!this.known.has(ranked[i])) entered.push(ranked[i]);
    }
    this.known = new Set(top15);
    return entered;
  }
}
