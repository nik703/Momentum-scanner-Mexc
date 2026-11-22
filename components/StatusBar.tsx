"use client";

import { fmtClock } from "@/lib/format";
import type { WsStatus } from "@/lib/types";
import { Kbd, cx } from "./ui/primitives";

export function StatusBar({
  status,
  tracked,
  lastTickAt,
  syncedAt,
  audioLocked,
  focusSymbol,
}: {
  status: WsStatus;
  tracked: number;
  lastTickAt: number | null;
  syncedAt: number | null;
  audioLocked: boolean;
  /** Single-coin focus mode: market-wide stream and scanner sync are paused. */
  focusSymbol: string | null;
}) {
  const ok = status === "CONNECTED";
  return (
    <footer
      role="status"
      aria-live="polite"
      className="num sticky bottom-0 z-20 flex h-7 items-center gap-x-4 overflow-x-auto whitespace-nowrap border-t border-line bg-panel px-2 text-[10.5px] text-fg-2 sm:px-3"
    >
      <span className="flex items-center gap-1.5">
        <span aria-hidden className={cx("h-1.5 w-1.5", ok ? "bg-gain" : "blink bg-alert")} />
        <span className={cx("font-semibold", ok ? "text-gain" : "text-alert")}>{status}</span>
      </span>
      <span>
        TRACKED <span className="text-fg">{tracked}</span>
      </span>
      <span>
        LAST TICK <span className="text-fg">{fmtClock(lastTickAt)}</span>
      </span>
      <span className="hidden sm:inline">
        SYNC <span className="text-fg">{fmtClock(syncedAt)}</span>
      </span>
      {focusSymbol && (
        <span className="text-alert" data-testid="focus-mode">
          FOCUS {focusSymbol.replace(/_USDT$/, "")} · SCANNER PAUSED
        </span>
      )}
      {audioLocked && <span className="text-alert">AUDIO LOCKED · CLICK ANYWHERE OR PRESS TEST</span>}
      <span className="ml-auto hidden items-center gap-1.5 text-fg-3 lg:flex">
        <Kbd>1</Kbd>
        <Kbd>2</Kbd>
        <Kbd>3</Kbd> timeframe
        <Kbd>T</Kbd> theme
        <Kbd>/</Kbd> search
      </span>
    </footer>
  );
}
