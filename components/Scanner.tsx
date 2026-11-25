"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useScanner } from "@/hooks/useScanner";
import { migrateLegacyAudio, useAudioVolume } from "@/hooks/useAppSettings";
import { prefetchUniverse } from "@/hooks/useContractUniverse";
import { useLeaderboardAlerts } from "@/hooks/useLeaderboardAlerts";
import { usePersistentState } from "@/hooks/usePersistentState";
import { playLeaderboardPing, unlockAudio } from "@/lib/audio";
import { TIMEFRAMES, type Timeframe } from "@/lib/types";
import { ContractDrawer } from "./ContractDrawer";
import { LeaderboardTable, type BoardRow } from "./LeaderboardTable";
import { StatusBar } from "./StatusBar";
import {
  MIN_VOLUMES,
  ROW_LIMITS,
  TerminalHeader,
  type MinVolume,
  type RowLimit,
  type Theme,
} from "./TerminalHeader";
import { Badge } from "./ui/primitives";

const THEMES = ["dark", "light"] as const satisfies readonly Theme[];
// One-time: carry an explicit old "Ping: OFF" over to a muted volume. Runs at module load, before
// any component reads the persisted volume.
if (typeof window !== "undefined") migrateLegacyAudio();

function normalize(q: string): string {
  return q.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function focusVisibleSearch(): void {
  const inputs = document.querySelectorAll<HTMLInputElement>("input[data-symbol-search]");
  for (const el of inputs) {
    if (el.offsetParent !== null) {
      el.focus();
      el.select();
      return;
    }
  }
}

export function Scanner() {
  const [tf, setTf] = usePersistentState<Timeframe>("mx-tf", "15M", TIMEFRAMES);
  const [minVol, setMinVol] = usePersistentState<MinVolume>("mx-minvol", "0", MIN_VOLUMES);
  const [limit, setLimit] = usePersistentState<RowLimit>("mx-limit", "25", ROW_LIMITS);
  const [theme, setTheme] = usePersistentState<Theme>("mx-theme", "dark", THEMES);
  const { volume, auditionVolume } = useAudioVolume();
  const [query, setQuery] = useState("");
  const [inspect, setInspect] = useState<string | null>(null);
  const closeDrawer = useCallback(() => setInspect(null), []);
  // Single-Coin Focus Mode while the drawer is open: see useScanner.
  const { snap, resyncing } = useScanner(inspect);

  // Freeze every leaderboard input while focused, so the hidden or stale boards never re-sort or
  // re-render (search typing, filter clicks and store snapshots included). React's "adjust state
  // during render" pattern: no effects, no refs.
  type BoardInputs = { rows: typeof snap.rows; tf: Timeframe; minVol: MinVolume; query: string; limit: RowLimit };
  const [frozen, setFrozen] = useState<BoardInputs | null>(null);
  if (inspect && !frozen) setFrozen({ rows: snap.rows, tf, minVol, query, limit });
  if (!inspect && frozen) setFrozen(null);
  const board: BoardInputs = frozen ?? { rows: snap.rows, tf, minVol, query, limit };

  // Lookup list: fetched once, after the first scanner bootstrap, never while focused.
  const hydrated = snap.bootstrapAt !== null;
  useEffect(() => {
    if (hydrated && !inspect) prefetchUniverse();
  }, [hydrated, inspect]);
  const [audioReady, setAudioReady] = useState(false);

  // The head script already set data-theme before first paint, so skip the first run.
  const themeMounted = useRef(false);
  useEffect(() => {
    if (!themeMounted.current) {
      themeMounted.current = true;
      return;
    }
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);
  const toggleTheme = useCallback(() => setTheme(theme === "dark" ? "light" : "dark"), [theme, setTheme]);

  // Browsers only start audio after a user gesture. If the volume is above 0, unlock audio on the first gesture.
  useEffect(() => {
    if (volume <= 0 || audioReady) return;
    const unlock = () => void unlockAudio().then(setAudioReady);
    window.addEventListener("pointerdown", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, [volume, audioReady]);

  // Test plays at the current volume, or at the remembered level while muted.
  const onTestPing = useCallback(async () => {
    setAudioReady(await unlockAudio());
    playLeaderboardPing(auditionVolume);
  }, [auditionVolume]);

  // Keyboard shortcuts: 1/2/3 timeframe, T theme, / focus search, Esc clear search.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target instanceof HTMLElement ? e.target : null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) {
        // The lookup calls preventDefault when its own Esc closed the result list.
        if (e.key === "Escape" && !e.defaultPrevented && el.hasAttribute("data-symbol-search")) {
          setQuery("");
          el.blur();
        }
        return;
      }
      if (e.key === "Escape") {
        setInspect(null);
        return;
      }
      if (e.key === "1" || e.key === "2" || e.key === "3") setTf(TIMEFRAMES[Number(e.key) - 1]);
      else if (e.key === "t" || e.key === "T") toggleTheme();
      else if (e.key === "/") {
        e.preventDefault();
        focusVisibleSearch();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setTf, toggleTheme]);

  // Ranks the contracts that pass the volume filter. Values for every timeframe are already in memory,
  // so switching timeframe is just a re-sort with no refetch.
  const ranked = useMemo(() => {
    const min = Number(board.minVol);
    const gainers: BoardRow[] = [];
    const losers: BoardRow[] = [];
    for (const r of board.rows) {
      if (r.amount24 < min) continue;
      const m = r.tf[board.tf];
      if (m.move === null) continue;
      const row: BoardRow = {
        rank: 0,
        symbol: r.symbol,
        price: r.price,
        tickDir: r.tickDir,
        tickSeq: r.tickSeq,
        move: m.move,
        volChange: m.volChange,
        turnover: m.turnover,
      };
      if (m.move > 0) gainers.push(row);
      else if (m.move < 0) losers.push(row);
    }
    gainers.sort((a, b) => b.move - a.move);
    losers.sort((a, b) => a.move - b.move);
    gainers.forEach((r, i) => (r.rank = i + 1));
    losers.forEach((r, i) => (r.rank = i + 1));
    return { gainers, losers, gSyms: gainers.map((r) => r.symbol), lSyms: losers.map((r) => r.symbol) };
  }, [board.rows, board.tf, board.minVol]);

  const alerts = useLeaderboardAlerts({
    gainers: ranked.gSyms,
    losers: ranked.lSyms,
    timeframe: board.tf,
    minVolume: board.minVol,
    live: snap.status === "CONNECTED",
    volume,
    isDrawerOpen: Boolean(inspect),
    resyncing,
    lastTickAt: snap.lastTickAt,
  });

  // Search and row count only change what is shown. Ranks stay the same.
  const view = useMemo(() => {
    const q = normalize(board.query);
    const n = board.limit === "all" ? Number.POSITIVE_INFINITY : Number(board.limit);
    const pick = (rows: BoardRow[]) => {
      const out: BoardRow[] = [];
      for (const r of rows) {
        if (out.length >= n) break;
        if (q && !normalize(r.symbol).includes(q)) continue;
        out.push(r);
      }
      return out;
    };
    return { gainers: pick(ranked.gainers), losers: pick(ranked.losers) };
  }, [ranked, board.query, board.limit]);

  const loading = snap.bootstrapAt === null;

  return (
    <div className="flex min-h-screen flex-col" data-leaderboard-muted={inspect ? "true" : "false"}>
      <TerminalHeader
        timeframe={tf}
        onTimeframe={setTf}
        minVolume={minVol}
        onMinVolume={setMinVol}
        limit={limit}
        onLimit={setLimit}
        query={query}
        onQuery={setQuery}
        theme={theme}
        onTheme={setTheme}
        onTestPing={onTestPing}
        onOpenContract={setInspect}
        focused={inspect !== null}
      />

      {snap.error && loading && (
        <div role="alert" className="flex items-center gap-2 border-b border-line bg-loss-tint px-3 py-1.5 text-[12px] text-loss">
          <Badge tone="loss">Error</Badge>
          {snap.error}. Retrying automatically.
        </div>
      )}

      <main className="grid flex-1 grid-cols-1 content-start gap-2 p-2 sm:p-3 lg:grid-cols-2">
        <LeaderboardTable
          title="Top Gainers"
          side="gain"
          rows={view.gainers}
          timeframe={board.tf}
          newBadges={alerts.gainersNew}
          now={snap.flushedAt}
          totalRanked={ranked.gainers.length}
          paused={inspect !== null}
          loading={loading}
          selectedSymbol={inspect}
          onSelectContract={setInspect}
        />
        <LeaderboardTable
          title="Top Losers"
          side="loss"
          rows={view.losers}
          timeframe={board.tf}
          newBadges={alerts.losersNew}
          now={snap.flushedAt}
          totalRanked={ranked.losers.length}
          paused={inspect !== null}
          loading={loading}
          selectedSymbol={inspect}
          onSelectContract={setInspect}
        />
      </main>

      <StatusBar
        focusSymbol={inspect}
        status={snap.status}
        tracked={snap.tracked}
        lastTickAt={snap.lastTickAt}
        syncedAt={snap.bootstrapAt}
        audioLocked={volume > 0 && !audioReady}
      />

      {/* Keyed by symbol: switching contracts tears down one feed (sending unsubs) and starts the next. */}
      {inspect && <ContractDrawer key={inspect} symbol={inspect} onClose={closeDrawer} />}
    </div>
  );
}
