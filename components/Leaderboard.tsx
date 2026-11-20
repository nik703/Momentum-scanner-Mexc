"use client";

import { memo, useCallback, useState } from "react";
import { fmtPct, fmtPrice, fmtUsd } from "@/lib/format";
import type { Timeframe } from "@/lib/types";
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

const GRID =
  "grid grid-cols-[1.4rem_minmax(0,1fr)_auto_3.9rem_4.4rem] sm:grid-cols-[2.25rem_minmax(0,1fr)_minmax(5.5rem,auto)_5rem_6.5rem] items-center gap-x-1.5 sm:gap-x-2 px-2 sm:px-3";

function CopyIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      <rect x="5" y="5" width="8.5" height="8.5" rx="1.5" />
      <path d="M10.5 5V3.5A1.5 1.5 0 0 0 9 2H3.5A1.5 1.5 0 0 0 2 3.5V9a1.5 1.5 0 0 0 1.5 1.5H5" />
    </svg>
  );
}
function CheckIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <path d="M3 8.5l3 3 7-7" />
    </svg>
  );
}
function ExternalIcon() {
  return (
    <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      <path d="M9 2h5v5M14 2L7.5 8.5M12 9.5V13a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3.5" />
    </svg>
  );
}

const Row = memo(function Row({
  row,
  isNew,
}: {
  row: BoardRow;
  isNew: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(row.symbol);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard blocked */
    }
  }, [row.symbol]);

  const up = row.move >= 0;
  const vol = row.volChange;
  const volTone = vol === null ? "text-subtle" : vol >= 100 ? "text-warn" : vol >= 0 ? "text-text" : "text-muted";

  return (
    <div role="row" className={cx(GRID, "relative h-10 border-b border-border/60 text-[13px] last:border-b-0 hover:bg-surface-2/70")}>
      {row.tickSeq > 0 && (
        <span
          key={row.tickSeq}
          aria-hidden
          className={cx("pointer-events-none absolute inset-0", row.tickDir > 0 ? "flash-up" : "flash-down")}
        />
      )}
      <span role="cell" className="relative flex flex-col items-start justify-center leading-none">
        <span className="font-mono text-xs tabular-nums text-subtle">{row.rank}</span>
        {isNew && (
          <Badge tone="accent" className="mt-0.5 px-1 text-[8px] leading-3">
            New
          </Badge>
        )}
      </span>
      <span role="cell" className="relative flex min-w-0 items-center gap-1">
        <a
          href={`https://futures.mexc.com/exchange/${row.symbol}`}
          target="_blank"
          rel="noopener noreferrer"
          className="group/link inline-flex min-w-0 items-center gap-1 truncate font-semibold hover:text-accent"
          title={`Open ${row.symbol} on MEXC Futures`}
        >
          <span className="truncate">
            {row.symbol.replace(/_USDT$/, "")}
            <span className="hidden font-normal text-subtle sm:inline">_USDT</span>
          </span>
          <span className="shrink-0 text-subtle opacity-0 transition-opacity group-hover/link:opacity-100 group-focus-visible/link:opacity-100">
            <ExternalIcon />
          </span>
        </a>
        <button
          type="button"
          onClick={copy}
          aria-label={copied ? `Copied ${row.symbol}` : `Copy ${row.symbol}`}
          title={copied ? "Copied" : "Copy symbol"}
          className={cx(
            "shrink-0 rounded p-1 transition-colors hover:bg-surface-2 hover:text-text",
            copied ? "text-up" : "text-subtle",
          )}
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
        </button>
      </span>
      <span role="cell" className="relative text-right font-mono text-[11.5px] tabular-nums sm:text-[12.5px]">
        {fmtPrice(row.price)}
      </span>
      <span role="cell" className={cx("relative text-right font-mono font-semibold tabular-nums", up ? "text-up" : "text-down")}>
        {fmtPct(row.move)}
      </span>
      <span role="cell" className="relative flex flex-col items-end justify-center leading-tight">
        <span className={cx("font-mono text-[12.5px] font-medium tabular-nums", volTone)}>{fmtPct(vol, 1)}</span>
        <span className="font-mono text-[10.5px] tabular-nums text-subtle">{fmtUsd(row.turnover)}</span>
      </span>
    </div>
  );
}, (a, b) =>
  a.isNew === b.isNew &&
  a.row.rank === b.row.rank &&
  a.row.symbol === b.row.symbol &&
  a.row.price === b.row.price &&
  a.row.tickSeq === b.row.tickSeq &&
  a.row.move === b.row.move &&
  a.row.volChange === b.row.volChange &&
  a.row.turnover === b.row.turnover,
);

export function Leaderboard({
  title,
  side,
  rows,
  timeframe,
  newTags,
  now,
  totalRanked,
  loading,
}: {
  title: string;
  side: "up" | "down";
  rows: BoardRow[];
  timeframe: Timeframe;
  newTags: ReadonlyMap<string, number>;
  now: number;
  totalRanked: number;
  loading: boolean;
}) {
  const headId = `${side}-board-title`;
  return (
    <section aria-labelledby={headId} className="flex min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-surface">
      <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-2.5">
        <h2 id={headId} className="flex items-center gap-2 text-sm font-semibold">
          <span aria-hidden className={cx("h-2 w-2 rounded-full", side === "up" ? "bg-up" : "bg-down")} />
          {title}
          <Badge>{timeframe}</Badge>
        </h2>
        <span className="text-xs tabular-nums text-subtle">
          {rows.length} / {totalRanked}
        </span>
      </header>
      <div role="table" aria-label={`${title} ${timeframe}`} className="min-w-0">
        <div
          role="row"
          className={cx(GRID, "h-8 border-b border-border bg-surface-2/60 text-[10.5px] font-medium uppercase tracking-wide text-subtle")}
        >
          <span role="columnheader">#</span>
          <span role="columnheader">Contract</span>
          <span role="columnheader" className="text-right">Price</span>
          <span role="columnheader" className="text-right">{timeframe} %</span>
          <span role="columnheader" className="text-right">{timeframe} Vol %</span>
        </div>
        {loading && rows.length === 0 ? (
          <div className="space-y-px p-1" aria-busy="true">
            {Array.from({ length: 8 }, (_, i) => (
              <div key={i} className="h-9 animate-pulse rounded bg-surface-2/70" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <p className="px-3 py-8 text-center text-sm text-subtle">
            No {side === "up" ? "gainers" : "losers"} match the current filters.
          </p>
        ) : (
          rows.map((r) => {
            const exp = newTags.get(r.symbol);
            return <Row key={r.symbol} row={r} isNew={exp !== undefined && exp > now && r.rank <= 10} />;
          })
        )}
      </div>
    </section>
  );
}
