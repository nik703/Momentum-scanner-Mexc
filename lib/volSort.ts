/** 3-state Vol % column sort: default (Price Move % rank) -> Vol % descending -> Vol % ascending -> default. */
export type VolSortMode = "default" | "vol_desc" | "vol_asc";

export function nextVolSort(m: VolSortMode): VolSortMode {
  return m === "default" ? "vol_desc" : m === "vol_desc" ? "vol_asc" : "default";
}

/**
 * Re-orders the rows already on screen by Volume Change %. It never changes the canonical Price
 * Move % ranking (rank numbers, Top 10 alerts and NEW badges are computed before this).
 * Rows without a volume figure yet (null: not enough history) always sort last, and ties keep
 * their price-move rank, so the order is stable. Returns the input array unchanged in "default".
 */
export function applyVolSort<T extends { rank: number; volChange: number | null }>(rows: readonly T[], mode: VolSortMode): readonly T[] {
  if (mode === "default") return rows;
  const dir = mode === "vol_desc" ? -1 : 1;
  return [...rows].sort((a, b) => {
    const av = a.volChange;
    const bv = b.volChange;
    if (av === null || !Number.isFinite(av)) return bv === null || !Number.isFinite(bv) ? a.rank - b.rank : 1;
    if (bv === null || !Number.isFinite(bv)) return -1;
    return av === bv ? a.rank - b.rank : dir * (av - bv);
  });
}
