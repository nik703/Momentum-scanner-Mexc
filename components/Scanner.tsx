"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useScanner } from "@/hooks/useScanner";
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
const PING_STATES = ["off", "on"] as const;
type PingState = (typeof PING_STATES)[number];

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
  const snap = useScanner();

  const [tf, setTf] = usePersistentState<Timeframe>("mx-tf", "15M", TIMEFRAMES);
  const [minVol, setMinVol] = usePersistentState<MinVolume>("mx-minvol", "0", MIN_VOLUMES);
  const [limit, setLimit] = usePersistentState<RowLimit>("mx-limit", "25", ROW_LIMITS);
  const [theme, setTheme] = usePersistentState<Theme>("mx-theme", "dark", THEMES);
  const [ping, setPing] = usePersistentState<PingState>("mx-ping", "off", PING_STATES);
  const [query, setQuery] = useState("");
  const [inspect, setInspect] = useState<string | null>(null);
  const closeDrawer = useCallback(() => setInspect(null), []);
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

  // Browsers only start audio after a user gesture. If Ping was saved as ON, unlock audio on the first gesture.
  useEffect(() => {
    if (ping !== "on" || audioReady) return;
    const unlock = () => void unlockAudio().then(setAudioReady);
    window.addEventListener("pointerdown", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, [ping, audioReady]);

  const onPing = useCallback(
    (on: boolean) => {
      setPing(on ? "on" : "off");
      if (on) void unlockAudio().then(setAudioReady);
    },
    [setPing],
  );

  const onTestPing = useCallback(async () => {
    setAudioReady(await unlockAudio());
    playLeaderboardPing();
  }, []);

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
    const min = Number(minVol);
    const gainers: BoardRow[] = [];
    const losers: BoardRow[] = [];
    for (const r of snap.rows) {
      if (r.amount24 < min) continue;
      const m = r.tf[tf];
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
  }, [snap.rows, tf, minVol]);

  const alerts = useLeaderboardAlerts({
    gainers: ranked.gSyms,
    losers: ranked.lSyms,
    timeframe: tf,
    minVolume: minVol,
    live: snap.status === "CONNECTED",
    pingEnabled: ping === "on",
    isDrawerOpen: Boolean(inspect),
  });

  // Search and row count only change what is shown. Ranks stay the same.
  const view = useMemo(() => {
    const q = normalize(query);
    const n = limit === "all" ? Number.POSITIVE_INFINITY : Number(limit);
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
  }, [ranked, query, limit]);

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
        onToggleTheme={toggleTheme}
        pingOn={ping === "on"}
        onPing={onPing}
        onTestPing={onTestPing}
        onOpenContract={setInspect}
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
          timeframe={tf}
          newBadges={alerts.gainersNew}
          now={snap.flushedAt}
          totalRanked={ranked.gainers.length}
          loading={loading}
          selectedSymbol={inspect}
          onSelect={setInspect}
        />
        <LeaderboardTable
          title="Top Losers"
          side="loss"
          rows={view.losers}
          timeframe={tf}
          newBadges={alerts.losersNew}
          now={snap.flushedAt}
          totalRanked={ranked.losers.length}
          loading={loading}
          selectedSymbol={inspect}
          onSelect={setInspect}
        />
      </main>

      <StatusBar
        status={snap.status}
        tracked={snap.tracked}
        lastTickAt={snap.lastTickAt}
        syncedAt={snap.bootstrapAt}
        audioLocked={ping === "on" && !audioReady}
      />

      {/* Keyed by symbol: switching contracts tears down one feed (sending unsubs) and starts the next. */}
      {inspect && <ContractDrawer key={inspect} symbol={inspect} onClose={closeDrawer} soundEnabled={ping === "on"} />}
    </div>
  );
}
