"use client";

import { useId, useMemo, useState, type KeyboardEvent } from "react";
import { searchUniverse, useContractUniverse } from "@/hooks/useContractUniverse";
import { fmtPct, fmtPrice, fmtUsd } from "@/lib/format";
import { normalizeSymbol } from "@/lib/symbol";
import { Kbd, cx } from "./ui/primitives";

/**
 * Top bar search that does two jobs: it filters the leaderboards as you type, and it is a
 * WAI-ARIA combobox over every active MEXC USDT-M perpetual, including contracts outside the
 * scanner's Top 150. Enter or a click opens the Contract Inspection Drawer.
 */
export function ContractLookup({
  query,
  onQuery,
  onOpenContract,
  focused,
  className,
}: {
  query: string;
  onQuery: (q: string) => void;
  onOpenContract: (symbol: string) => void;
  /** Drawer open: search only the in-memory list and never fetch /api/symbols. */
  focused: boolean;
  className?: string;
}) {
  const uni = useContractUniverse();
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  const results = useMemo(() => searchUniverse(uni.items, query), [uni.items, query]);
  const expanded = open && query.trim().length > 0;
  const activeIdx = Math.min(active, Math.max(0, results.length - 1));

  function choose(symbol: string, input: HTMLInputElement | null) {
    onOpenContract(symbol);
    setOpen(false);
    onQuery("");
    input?.blur();
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setOpen(true);
      if (results.length) setActive((activeIdx + (e.key === "ArrowDown" ? 1 : -1) + results.length) % results.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const pick = expanded && results[activeIdx] ? results[activeIdx].symbol : null;
      if (pick) return choose(pick, e.currentTarget);
      // No list match (or list not loaded yet): try the typed symbol directly. The drawer shows a 404 if it doesn't exist.
      const norm = normalizeSymbol(query);
      if (norm.ok) choose(norm.symbol, e.currentTarget);
    } else if (e.key === "Escape") {
      // First Esc closes the list, second clears the input. The Scanner's global handler ignores inputs.
      if (expanded) {
        e.preventDefault();
        setOpen(false);
      }
    }
  }

  return (
    <div className={cx("relative", className)}>
      <label className="relative flex h-7 items-center">
        <span className="sr-only">Search or look up any MEXC USDT-M contract</span>
        <svg
          viewBox="0 0 16 16"
          width="12"
          height="12"
          aria-hidden
          className="pointer-events-none absolute left-2 text-fg-3"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        >
          <circle cx="7" cy="7" r="4.5" />
          <path d="M10.5 10.5L14 14" />
        </svg>
        <input
          data-symbol-search
          type="search"
          role="combobox"
          aria-expanded={expanded}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={expanded && results.length ? `${listId}-${activeIdx}` : undefined}
          value={query}
          onChange={(e) => {
            onQuery(e.target.value);
            setOpen(true);
            setActive(0);
          }}
          onFocus={() => {
            if (!focused) uni.ensure(); // keystrokes never fetch; only focus does, outside focus mode
            setOpen(true);
          }}
          onBlur={() => setOpen(false)}
          onKeyDown={onKeyDown}
          placeholder="Symbol / lookup"
          autoComplete="off"
          spellCheck={false}
          className="num h-full w-full rounded-[3px] border border-line bg-canvas pl-6 pr-6 text-[12px] uppercase text-fg placeholder:normal-case placeholder:text-fg-3 focus:border-line-strong focus:outline-none"
        />
        <span className="pointer-events-none absolute right-1.5 hidden sm:block">
          <Kbd>/</Kbd>
        </span>
      </label>

      {expanded && (
        <ul
          id={listId}
          role="listbox"
          aria-label="Matching contracts"
          className="absolute left-0 right-0 top-full z-50 mt-1 min-w-[16rem] border border-line bg-panel"
        >
          {results.length === 0 ? (
            <li className="px-2 py-2 text-[11px] text-fg-3">
              {uni.status === "loading" || uni.status === "idle"
                ? "Loading contracts…"
                : uni.status === "error"
                  ? "Lookup unavailable. Press Enter to open the typed symbol."
                  : "No match. Press Enter to try the typed symbol."}
            </li>
          ) : (
            results.map((r, i) => {
              const chg = r.riseFallRate * 100;
              return (
                <li
                  key={r.symbol}
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={i === activeIdx}
                  data-symbol={r.symbol}
                  // mousedown (not click) fires before the input's blur closes the list
                  onMouseDown={(e) => {
                    e.preventDefault();
                    choose(r.symbol, null);
                  }}
                  onMouseEnter={() => setActive(i)}
                  className={cx(
                    "num grid h-7 cursor-pointer grid-cols-[minmax(0,1fr)_auto_3.6rem_3.6rem] items-center gap-x-2 px-2 text-[11.5px]",
                    i === activeIdx ? "bg-row-hover text-fg" : "text-fg-2",
                  )}
                >
                  <span className="truncate font-medium text-fg">
                    {r.symbol.replace(/_USDT$/, "")}
                    <span className="text-fg-3">_USDT</span>
                  </span>
                  <span className="text-right">{fmtPrice(r.lastPrice)}</span>
                  <span className={cx("text-right", chg >= 0 ? "text-gain" : "text-loss")}>{fmtPct(chg)}</span>
                  <span className="text-right text-fg-3">{fmtUsd(r.amount24)}</span>
                </li>
              );
            })
          )}
        </ul>
      )}
    </div>
  );
}
