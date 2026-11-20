"use client";

import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useScanner } from "@/hooks/useScanner";
import { useLeaderboardAlerts } from "@/hooks/useLeaderboardAlerts";
import { usePersistentState } from "@/hooks/usePersistentState";
import { isAudioUnlocked, playChime, unlockAudio } from "@/lib/audio";
import { fmtClock } from "@/lib/format";
import { TIMEFRAMES, type Timeframe } from "@/lib/types";
import { Leaderboard, type BoardRow } from "./Leaderboard";
import { Badge, Kbd, SegmentedControl, Switch, Tooltip, cx } from "./ui/primitives";

const MIN_VOL = ["0", "1000000", "5000000", "25000000"] as const;
type MinVol = (typeof MIN_VOL)[number];
const MIN_VOL_OPTS = [
  { value: "0", label: "All" },
  { value: "1000000", label: ">$1M" },
  { value: "5000000", label: ">$5M" },
  { value: "25000000", label: ">$25M" },
] as const;

const LIMITS = ["25", "50", "all"] as const;
type Limit = (typeof LIMITS)[number];
const LIMIT_OPTS = [
  { value: "25", label: "Top 25" },
  { value: "50", label: "Top 50" },
  { value: "all", label: "All" },
] as const;

const THEMES = ["dark", "light"] as const;
type Theme = (typeof THEMES)[number];
const PINGS = ["off", "on"] as const;
type Ping = (typeof PINGS)[number];

function normalize(q: string) {
  return q.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function Scanner() {
  const snap = useScanner();

  const [tf, setTf] = usePersistentState<Timeframe>("mx-tf", "15M", TIMEFRAMES);
  const [minVol, setMinVol] = usePersistentState<MinVol>("mx-minvol", "0", MIN_VOL);
  const [limit, setLimit] = usePersistentState<Limit>("mx-limit", "25", LIMITS);
  const [theme, setThemeState] = usePersistentState<Theme>("mx-theme", "dark", THEMES);
  const [ping, setPing] = usePersistentState<Ping>("mx-ping", "off", PINGS);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const searchRef = useRef<HTMLInputElement>(null);
  const [audioReady, setAudioReady] = useState(false);

  // Theme: the inline head script applies the stored theme before paint; keep the class in sync.
  const themeMounted = useRef(false);
  useEffect(() => {
    // Skip the first run: the head script already applied the persisted theme.
    if (!themeMounted.current) {
      themeMounted.current = true;
      return;
    }
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);
  const toggleTheme = useCallback(() => setThemeState(theme === "dark" ? "light" : "dark"), [theme, setThemeState]);

  // Unlock AudioContext on the first gesture when pings were persisted ON.
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

  const setPingOn = useCallback(
    (on: boolean) => {
      setPing(on ? "on" : "off");
      if (on) void unlockAudio().then(setAudioReady);
    },
    [setPing],
  );

  const testPing = useCallback(async () => {
    const ok = await unlockAudio();
    setAudioReady(ok);
    playChime();
  }, []);

  // Keyboard shortcuts: 1/2/3 timeframe, T theme, / focus search, Esc clear search.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      const typing = !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
      if (typing) {
        if (e.key === "Escape" && el === searchRef.current) {
          setQuery("");
          searchRef.current?.blur();
        }
        return;
      }
      if (e.key === "1" || e.key === "2" || e.key === "3") {
        setTf(TIMEFRAMES[Number(e.key) - 1]);
      } else if (e.key === "t" || e.key === "T") {
        toggleTheme();
      } else if (e.key === "/") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setTf, toggleTheme]);

  // Rank over the liquidity-filtered universe. Pure in-memory sort, no refetch.
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
    return {
      gainers,
      losers,
      gSyms: gainers.map((r) => r.symbol),
      lSyms: losers.map((r) => r.symbol),
    };
  }, [snap.rows, tf, minVol]);

  const alerts = useLeaderboardAlerts({
    gainers: ranked.gSyms,
    losers: ranked.lSyms,
    timeframe: tf,
    scopeKey: minVol,
    live: snap.status === "CONNECTED" && snap.bootstrapAt !== null,
    pingEnabled: ping === "on",
  });

  const view = useMemo(() => {
    const q = normalize(deferredQuery);
    const n = limit === "all" ? Infinity : Number(limit);
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
  }, [ranked, deferredQuery, limit]);

  const loading = snap.bootstrapAt === null;
  const connected = snap.status === "CONNECTED";

  return (
    <div className="mx-auto flex min-h-dvh max-w-[1400px] flex-col gap-3 px-3 py-3 sm:px-5 sm:py-4">
      {/* ---------------- Top bar ---------------- */}
      <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex items-center gap-2.5">
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden className="text-accent">
            <path d="M3 17l5-5 4 4 8-9" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M15 7h5v5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <div className="leading-tight">
            <h1 className="text-[15px] font-semibold tracking-tight">MEXC Futures Momentum Scanner</h1>
            <p className="text-[11px] text-subtle">USDT-M perpetuals · price &amp; volume surges · live</p>
          </div>
        </div>

        <div className="flex items-center gap-1 sm:gap-2">
          <Tooltip content="Toggle theme (T)">
            <button
              type="button"
              onClick={toggleTheme}
              aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1 text-xs font-medium text-muted hover:text-text"
            >
              {theme === "dark" ? (
                <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden fill="currentColor">
                  <path d="M6.2 1.5a6.5 6.5 0 1 0 8.3 8.3A5.5 5.5 0 0 1 6.2 1.5z" />
                </svg>
              ) : (
                <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.5">
                  <circle cx="8" cy="8" r="3" />
                  <path d="M8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M3 3l1 1M12 12l1 1M3 13l1-1M12 4l1-1" />
                </svg>
              )}
              {theme === "dark" ? "Dark" : "Light"}
            </button>
          </Tooltip>

          <div className="flex items-center rounded-md border border-border bg-surface pr-1">
            <Switch checked={ping === "on"} onChange={setPingOn} label="Top 10 audio alert">
              <span className="tabular-nums">
                Ping: <span className={ping === "on" ? "text-text" : ""}>{ping === "on" ? "ON" : "OFF"}</span>
              </span>
            </Switch>
            <button
              type="button"
              onClick={testPing}
              className="rounded border border-border px-1.5 py-0.5 text-[11px] font-medium text-muted hover:bg-surface-2 hover:text-text"
              title="Play test chime (also unlocks browser audio)"
            >
              Test
            </button>
          </div>
        </div>
      </header>

      {/* ---------------- Telemetry ---------------- */}
      <div
        role="status"
        aria-live="polite"
        className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border border-border bg-surface px-3 py-1.5 font-mono text-[11px] text-muted"
      >
        <span className="flex items-center gap-1.5">
          <span
            aria-hidden
            className={cx("h-1.5 w-1.5 rounded-full", connected ? "bg-up" : "pulse-dot bg-warn")}
          />
          <span className={cx("font-semibold", connected ? "text-up" : "text-warn")}>{snap.status}</span>
        </span>
        <span>
          Tracked <span className="tabular-nums text-text">{snap.tracked}</span>
        </span>
        <span>
          Last tick <span className="tabular-nums text-text">{fmtClock(snap.lastTickAt)}</span>
        </span>
        <span className="hidden sm:inline">
          Synced <span className="tabular-nums text-text">{fmtClock(snap.bootstrapAt)}</span>
        </span>
        {ping === "on" && !audioReady && (
          <span className="text-warn">Audio locked · click anywhere or press Test</span>
        )}
      </div>

      {/* ---------------- Controls ---------------- */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1.5">
          <SegmentedControl
            label="Timeframe"
            value={tf}
            onChange={setTf}
            options={TIMEFRAMES.map((t, i) => ({ value: t, label: t, hint: `${t} window (key ${i + 1})` }))}
          />
          <span className="hidden items-center gap-0.5 md:flex">
            <Kbd>1</Kbd>
            <Kbd>2</Kbd>
            <Kbd>3</Kbd>
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] text-subtle">24h Vol</span>
          <SegmentedControl label="Minimum 24h volume" value={minVol} onChange={setMinVol} options={MIN_VOL_OPTS} size="sm" />
        </div>
        <SegmentedControl label="Rows" value={limit} onChange={setLimit} options={LIMIT_OPTS} size="sm" />
        <label className="relative ml-auto flex min-w-[10rem] flex-1 items-center sm:max-w-xs">
          <span className="sr-only">Search symbol</span>
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden className="pointer-events-none absolute left-2.5 text-subtle" fill="none" stroke="currentColor" strokeWidth="1.6">
            <circle cx="7" cy="7" r="4.5" />
            <path d="M10.5 10.5L14 14" />
          </svg>
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search symbol…"
            autoComplete="off"
            spellCheck={false}
            className="h-8 w-full rounded-md border border-border bg-surface pl-8 pr-8 text-sm text-text placeholder:text-subtle focus:border-accent focus:outline-none"
          />
          <span className="pointer-events-none absolute right-2 hidden sm:block">
            <Kbd>/</Kbd>
          </span>
        </label>
      </div>

      {snap.error && loading && (
        <div role="alert" className="flex items-center gap-2 rounded-md border border-down/40 bg-down-soft px-3 py-2 text-sm text-down">
          <Badge tone="down">Error</Badge>
          {snap.error} — retrying automatically…
        </div>
      )}

      {/* ---------------- Boards ---------------- */}
      <main className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Leaderboard
          title="Top Gainers"
          side="up"
          rows={view.gainers}
          timeframe={tf}
          newTags={alerts.gainersNew}
          now={snap.flushedAt}
          totalRanked={ranked.gainers.length}
          loading={loading}
        />
        <Leaderboard
          title="Top Losers"
          side="down"
          rows={view.losers}
          timeframe={tf}
          newTags={alerts.losersNew}
          now={snap.flushedAt}
          totalRanked={ranked.losers.length}
          loading={loading}
        />
      </main>

      <footer className="mt-auto flex flex-wrap items-center justify-between gap-2 pt-2 text-[11px] text-subtle">
        <span>
          Top 150 USDT-M perps by 24h turnover · Min5 candles + live <code className="font-mono">sub.tickers</code> · Vol % vs.
          preceding baseline window
        </span>
        <span>
          Data: MEXC public API · <span className="hidden sm:inline">Not financial advice</span>
        </span>
      </footer>
    </div>
  );
}
