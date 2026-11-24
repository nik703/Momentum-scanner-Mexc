"use client";

import { memo } from "react";
import { fmtPrice, fmtUsd } from "@/lib/format";
import { EXCHANGES, type LiquidationSnapshot } from "@/lib/liquidationFeed";
import type { LiqEvent } from "@/lib/liquidations";
import type { SocketStatus } from "@/lib/reconnectingSocket";
import { cx } from "./ui/primitives";

function hms(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const STATUS_TONE: Record<SocketStatus, string> = {
  open: "bg-gain",
  connecting: "blink bg-alert",
  reconnecting: "blink bg-alert",
  error: "bg-loss",
  closed: "bg-fg-3",
};

const TapeRow = memo(function TapeRow({ e }: { e: LiqEvent }) {
  const long = e.side === "LONG";
  return (
    <div
      role="row"
      className="grid h-8 grid-cols-[2.6rem_4.6rem_minmax(0,1fr)_minmax(0,1fr)_3.9rem] items-center gap-x-2 border-b border-line px-2 text-[11px] last:border-b-0 sm:px-3"
      title={e.instrument}
    >
      <span role="cell" className="num rounded-[2px] border border-line px-1 text-center text-[9.5px] text-fg-2">
        {e.exchange}
      </span>
      <span role="cell" className={cx("num text-[10.5px] font-semibold", long ? "text-loss" : "text-gain")}>
        {long ? "LONG LIQ" : "SHORT LIQ"}
      </span>
      <span role="cell" className="num text-right text-fg">
        {fmtUsd(e.usd)}
      </span>
      <span role="cell" className="num truncate text-right text-fg-2">
        {fmtPrice(e.price)}
      </span>
      <span role="cell" className="num text-right text-fg-3">
        {hms(e.ts)}
      </span>
    </div>
  );
});

export function LiquidationsPanel({ snap }: { snap: LiquidationSnapshot }) {
  const { window15m: w } = snap;
  const total = w.longUsd + w.shortUsd;
  const longShare = total > 0 ? (w.longUsd / total) * 100 : 50;

  return (
    <section aria-labelledby="liq-title" className="border border-line" data-testid="liquidations">
      <header className="flex h-8 items-center gap-2 border-b border-line px-2 sm:px-3">
        <h3 id="liq-title" className="min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-wider">
          <span className="sm:hidden">Liqs</span>
          <span className="hidden sm:inline">Liquidations</span> · <span className="num text-fg-2">{snap.base}</span>
        </h3>
        <div className="flex shrink-0 items-center gap-2" aria-label="Exchange connection status">
          {EXCHANGES.map((ex) => (
            <span key={ex} className="num flex items-center gap-1 text-[10px] text-fg-2" title={snap.notes[ex] ?? `${ex}: ${snap.status[ex]}`}>
              <span aria-hidden className={cx("h-1.5 w-1.5", STATUS_TONE[snap.status[ex]])} />
              {ex}
            </span>
          ))}
        </div>
      </header>

      <div className="grid grid-cols-2 border-b border-line">
        <div className="border-r border-line px-2 py-1.5 sm:px-3">
          <div className="text-[9.5px] font-medium uppercase tracking-wider text-fg-3">15M Long Liqs</div>
          <div className="num text-[14px] font-semibold text-loss">{fmtUsd(w.longUsd)}</div>
        </div>
        <div className="px-2 py-1.5 text-right sm:px-3">
          <div className="text-[9.5px] font-medium uppercase tracking-wider text-fg-3">15M Short Liqs</div>
          <div className="num text-[14px] font-semibold text-gain">{fmtUsd(w.shortUsd)}</div>
        </div>
      </div>
      <div className="flex h-1" aria-hidden>
        <span className="bg-loss" style={{ width: `${total > 0 ? longShare : 0}%` }} />
        <span className="flex-1 bg-gain" style={{ opacity: total > 0 ? 1 : 0 }} />
      </div>

      <div role="table" aria-label="Liquidation tape" className="max-h-[256px] overflow-y-auto overscroll-contain">
        <div
          role="row"
          className="sticky top-0 grid h-6 grid-cols-[2.6rem_4.6rem_minmax(0,1fr)_minmax(0,1fr)_3.9rem] items-center gap-x-2 border-b border-line bg-panel px-2 text-[9.5px] font-medium uppercase tracking-wider text-fg-3 sm:px-3"
        >
          <span role="columnheader">Ex</span>
          <span role="columnheader">Side</span>
          <span role="columnheader" className="text-right">Size</span>
          <span role="columnheader" className="text-right">Price</span>
          <span role="columnheader" className="text-right">Time</span>
        </div>
        {snap.tape.length === 0 ? (
          <p className="px-3 py-5 text-center text-[11px] text-fg-3">
            Waiting for {snap.base} liquidations on Binance, Bybit and OKX. Session started; events stream live.
          </p>
        ) : (
          snap.tape.map((e) => <TapeRow key={e.id} e={e} />)
        )}
      </div>
      <footer className="num flex h-6 items-center justify-between border-t border-line px-2 text-[10px] text-fg-3 sm:px-3">
        <span>
          Session {snap.session.count} · L {fmtUsd(snap.session.longUsd)} · S {fmtUsd(snap.session.shortUsd)}
        </span>
        <span>15M n={w.count}</span>
      </footer>
    </section>
  );
}
