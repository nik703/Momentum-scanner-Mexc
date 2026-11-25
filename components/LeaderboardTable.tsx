"use client";

import { Fragment, memo, useMemo, useState } from "react";
import { ALERT_ZONE } from "@/lib/alerts";
import { fmtPct, fmtPrice, fmtUsd } from "@/lib/format";
import type { Timeframe } from "@/lib/types";
import { applyVolSort, nextVolSort, type VolSortMode } from "@/lib/volSort";
import { Badge, cx } from "./ui/primitives";

export interface BoardRow {
  rank: number;
  symbol: string;
  price: number;
  tickDir: -1 | 0 | 1;
  tickSeq: number;
  move: number;
  volChange: number | null;
  turnover: number;
}

/* rank | contract | price | move % | vol % | window turnover (sm+; stacked under vol % on mobile) */
const GRID =
  "grid items-center gap-x-2 px-2 sm:px-3 " +
  "grid-cols-[1.5rem_minmax(0,1fr)_auto_4.4rem_4.6rem] " +
  "sm:grid-cols-[1.75rem_minmax(0,1fr)_minmax(5.5rem,auto)_5.25rem_5rem_4.25rem]";

interface RowProps {
  row: BoardRow;
  side: "gain" | "loss";
  isNew: boolean;
  /** 0..1 share of the largest |move| shown on this board, sets the magnitude bar width. */
  magnitude: number;
  selected: boolean;
  onSelectContract: (symbol: string) => void;
}

/**
 * One leaderboard row. The WHOLE row is a single click/tap target that opens the Contract
 * Inspection Drawer. There is deliberately no external link (or other nested control) on the main
 * page, so a tap can never open a MEXC tab by accident. The MEXC link and copy action live in
 * the drawer header.
 */
const Row = memo(
  function Row({ row, side, isNew, magnitude, selected, onSelectContract }: RowProps) {
    const vol = row.volChange;
    const volTone = vol === null ? "text-fg-3" : vol >= 100 ? "text-alert" : vol >= 0 ? "text-fg" : "text-fg-2";
    const base = row.symbol.replace(/_USDT$/, "");

    return (
      <div
        role="row"
        tabIndex={0}
        aria-selected={selected}
        aria-label={`Open ${row.symbol} details`}
        data-row-symbol={row.symbol}
        onClick={() => onSelectContract(row.symbol)}
        onKeyDown={(e) => {
          if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) {
            e.preventDefault();
            onSelectContract(row.symbol);
          }
        }}
        className={cx(
          GRID,
          "group relative h-9 cursor-pointer border-b border-line last:border-b-0 hover:bg-row-hover focus-visible:bg-row-hover focus-visible:outline-none",
          selected && "bg-row-hover shadow-[inset_2px_0_0_var(--fg-2)]",
        )}
      >
        {row.tickSeq > 0 && (
          <span
            key={row.tickSeq}
            aria-hidden
            className={cx("pointer-events-none absolute inset-0", row.tickDir > 0 ? "flash-gain" : "flash-loss")}
          />
        )}

        <span role="cell" className="num relative text-[11px] text-fg-3">
          {row.rank}
        </span>

        <span role="cell" className="relative flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 truncate font-medium text-fg group-hover:underline group-hover:decoration-fg-3 group-hover:underline-offset-2">
            {base}
            <span className="hidden text-fg-3 sm:inline">_USDT</span>
          </span>
          {isNew && (
            <Badge tone="alert" className="shrink-0">
              New
            </Badge>
          )}
        </span>

        <span role="cell" className="num relative text-right text-[12px] text-fg">
          {fmtPrice(row.price)}
        </span>

        <span role="cell" className="relative flex h-6 items-center justify-end">
          <span
            aria-hidden
            className={cx("absolute inset-y-0 right-0 rounded-[1px]", side === "gain" ? "bg-gain-tint" : "bg-loss-tint")}
            style={{ width: `${Math.max(4, Math.round(magnitude * 100))}%` }}
          />
          <span className={cx("num relative pr-1 text-[12px] font-semibold", side === "gain" ? "text-gain" : "text-loss")}>
            {fmtPct(row.move)}
          </span>
        </span>

        <span role="cell" className="relative flex flex-col items-end leading-[13px]">
          <span className={cx("num text-[12px]", volTone)}>{fmtPct(vol, 1)}</span>
          <span className="num text-[10px] text-fg-3 sm:hidden">{fmtUsd(row.turnover)}</span>
        </span>

        <span role="cell" className="num relative hidden text-right text-[11.5px] text-fg-2 sm:block">
          {fmtUsd(row.turnover)}
        </span>
      </div>
    );
  },
  (a, b) =>
    a.isNew === b.isNew &&
    a.selected === b.selected &&
    a.onSelectContract === b.onSelectContract &&
    a.side === b.side &&
    a.magnitude === b.magnitude &&
    a.row.rank === b.row.rank &&
    a.row.symbol === b.row.symbol &&
    a.row.price === b.row.price &&
    a.row.tickSeq === b.row.tickSeq &&
    a.row.move === b.row.move &&
    a.row.volChange === b.row.volChange &&
    a.row.turnover === b.row.turnover,
);

function AlertDivider() {
  return (
    <div role="presentation" className="relative h-0 border-t border-dashed border-line-strong">
      <span className="num absolute -top-[7px] right-2 bg-panel px-1 text-[9px] uppercase leading-[13px] tracking-widest text-fg-3">
        Top {ALERT_ZONE} · alert line
      </span>
    </div>
  );
}

export function LeaderboardTable({
  title,
  side,
  rows,
  timeframe,
  newBadges,
  now,
  totalRanked,
  loading,
  selectedSymbol,
  onSelectContract,
  paused = false,
}: {
  title: string;
  side: "gain" | "loss";
  rows: BoardRow[];
  timeframe: Timeframe;
  newBadges: ReadonlyMap<string, number>;
  now: number;
  totalRanked: number;
  loading: boolean;
  selectedSymbol: string | null;
  onSelectContract: (symbol: string) => void;
  /** Focus mode: the board is frozen (no re-sort or re-render) until the drawer closes. */
  paused?: boolean;
}) {
  const headId = `${side}-board-title`;
  // Per-table Vol % sort. Display order only: ranks, alerts and NEW badges stay on the price ranking.
  const [volSort, setVolSort] = useState<VolSortMode>("default");
  const shown = useMemo(() => applyVolSort(rows, volSort), [rows, volSort]);
  const sortArrow = volSort === "vol_desc" ? "↓" : volSort === "vol_asc" ? "↑" : "";
  let maxAbs = 0;
  for (const r of rows) maxAbs = Math.max(maxAbs, Math.abs(r.move));

  return (
    <section aria-labelledby={headId} className="flex min-w-0 flex-col rounded-[3px] border border-line bg-panel">
      {/* Sticks under the 44px top bar. The section can't use overflow-hidden, or sticky stops working. */}
      <div className="sticky top-[44px] z-10 rounded-t-[3px] bg-panel">
        <div className="flex h-8 items-center justify-between border-b border-line px-2 sm:px-3">
          <h2 id={headId} className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-wide">
            <span aria-hidden className={cx("h-2 w-[3px]", side === "gain" ? "bg-gain" : "bg-loss")} />
            {title}
            <Badge>{timeframe}</Badge>
            {paused && (
              <Badge tone="alert" className="normal-case" >
                Paused
              </Badge>
            )}
          </h2>
          <span className="num text-[11px] text-fg-3">
            {rows.length}/{totalRanked}
          </span>
        </div>
        <div
          role="row"
          className={cx(GRID, "h-8 border-b border-line text-[10px] font-medium uppercase tracking-wider text-fg-3")}
        >
          <span role="columnheader">#</span>
          <span role="columnheader">Contract</span>
          <span role="columnheader" className="text-right">Price</span>
          <span role="columnheader" className="text-right">{timeframe} %</span>
          <button
            type="button"
            role="columnheader"
            aria-sort={volSort === "vol_desc" ? "descending" : volSort === "vol_asc" ? "ascending" : "none"}
            aria-label={`${timeframe} volume change: ${volSort === "default" ? "sorted by price move" : volSort === "vol_desc" ? "highest first" : "lowest first"}. Tap to change sort.`}
            title="Sort by volume change: highest first → lowest first → price move"
            data-testid={`${side}-volsort`}
            data-sort={volSort}
            onClick={() => setVolSort(nextVolSort)}
            className={cx(
              "-my-px flex h-8 cursor-pointer select-none items-center justify-end gap-0.5 whitespace-nowrap uppercase tracking-wider hover:text-fg",
              volSort !== "default" && "text-fg",
            )}
          >
            {timeframe} Vol %
            <span aria-hidden className="num inline-block w-[1ch] text-center text-[11px] leading-none">
              {sortArrow}
            </span>
          </button>
          <span role="columnheader" className="hidden text-right sm:block">{timeframe} Vol $</span>
        </div>
      </div>

      <div role="table" aria-label={`${title} ${timeframe}`} className="min-w-0">
        {loading && rows.length === 0 ? (
          <div aria-busy="true">
            {Array.from({ length: 12 }, (_, i) => (
              <div key={i} className="flex h-9 items-center border-b border-line px-3 last:border-b-0">
                <span className="h-2 w-full max-w-[60%] bg-row-hover" />
              </div>
            ))}
          </div>
        ) : rows.length === 0 ? (
          <p className="px-3 py-6 text-center text-[12px] text-fg-3">
            No {side === "gain" ? "gainers" : "losers"} match the current filters.
          </p>
        ) : (
          shown.map((r, i) => {
            const exp = newBadges.get(r.symbol);
            const prev = shown[i - 1];
            return (
              <Fragment key={r.symbol}>
                {volSort === "default" && prev && prev.rank === ALERT_ZONE && r.rank === ALERT_ZONE + 1 && <AlertDivider />}
                <Row
                  row={r}
                  side={side}
                  isNew={exp !== undefined && exp > now}
                  magnitude={maxAbs > 0 ? Math.round((Math.abs(r.move) / maxAbs) * 50) / 50 : 0}
                  selected={r.symbol === selectedSymbol}
                  onSelectContract={onSelectContract}
                />
              </Fragment>
            );
          })
        )}
      </div>
    </section>
  );
}
