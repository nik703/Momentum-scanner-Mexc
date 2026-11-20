# MEXC Futures Momentum Scanner

Real-time scanner for **MEXC USDT-M perpetual futures**. It shows the top gainers and losers over rolling **15M / 30M / 1H** windows, along with volume-surge figures for the same window.

- No database and no environment variables. It deploys to Vercel as-is.
- Runtime dependencies are only `next`, `react` and `react-dom`, with no chart library or UI suite.
- On load it pulls a snapshot from a CDN-cached API route. Live prices then come straight from the MEXC WebSocket in the browser.

## Deploy

```bash
npm i -g vercel   # or import the repo at vercel.com/new
vercel --prod
```

No configuration is needed.

## Local development

```bash
npm install
npm run dev        # http://localhost:3000
npm test           # calc + hysteresis unit tests (node --test)
npm run build
```

## Architecture

```
Browser ──GET /api/scanner (CDN: s-maxage=12, swr=24)──► Vercel fn ──► MEXC REST
   │                                                        ticker + 150× kline Min5 (15 concurrent)
   └──wss://contract.mexc.com/edge  sub.tickers ──► ScannerStore (mutable, O(1) per tick)
                                                       │ 250ms flush (only when dirty)
                                                       ▼
                                          React (useSyncExternalStore, memoized rows)
```

| File | Role |
| --- | --- |
| `app/api/scanner/route.ts` | Bootstrap endpoint. Picks the top 150 `*_USDT` contracts by `amount24` and loads 24×Min5 klines for each. Concurrent requests that reach the same warm instance share one upstream fetch. |
| `lib/mexc.ts` | MEXC fetch helpers, `mapLimit` concurrency helper, one retry per kline. |
| `lib/calculator.ts` | Live turnover delta, Min5 rollover, timeframe metrics (pure, unit-tested). |
| `lib/store.ts` | External store. Ticks change symbol state in place, and a 250ms flush rebuilds the rows. |
| `lib/ws.ts` | WebSocket client: `sub.tickers`, `ping` every 15s, stale-socket detection, exponential-backoff reconnect with jitter. |
| `hooks/useScanner.ts` | Bootstrap, then WebSocket, then a silent re-sync every 60s and when the tab becomes visible or the connection comes back. |
| `hooks/useLeaderboardAlerts.ts` + `lib/alerts.ts` | Top 10 entry alerts with Top 15 hysteresis. |
| `lib/audio.ts` | Web Audio chime: 880Hz then 1320Hz sine, 180ms exponential envelope. |
| `components/TerminalHeader.tsx` | Sticky 44px control bar: timeframe, volume filter, rows, search, theme, ping. |
| `components/LeaderboardTable.tsx` | 36px rows, sticky headers, magnitude bars on the move cell, Top 10 alert line. |
| `components/StatusBar.tsx` | Live status bar: socket state, tracked count, last tick, last sync. |

## Metrics

`L` is the index of the newest (still-forming) Min5 candle. Current turnover includes the live WebSocket delta, `max(0, ws.amount24 − snapshot.amount24)`.

| TF | Price move base | Current turnover | Baseline |
| --- | --- | --- | --- |
| 15M | open of `L-2` | Σ last 3 | Σ `L-11..L-3` ÷ 3 |
| 30M | open of `L-5` | Σ last 6 | Σ `L-11..L-6` |
| 1H | open of `L-11` | Σ last 12 | Σ `L-23..L-12` |

`Vol % = (current − baseline) / max(baseline, 1) × 100`

When the 5-minute bucket rolls over, the live delta is added to the closing candle and the snapshot point moves to the current 24h figures. A new empty candle then opens. Values for every timeframe are computed on each flush, so switching timeframes only re-sorts data already in memory.

## Alert rules

Each board keeps a `Set<string>` of known Top 15 symbols for the active timeframe (`gainersKnownTop15` / `losersKnownTop15`).

1. **Silent reset.** On first load, and whenever the timeframe or the 24h volume filter changes, each set is filled with the current Ranks 1–15. No sound plays.
2. **Live check.** Any symbol in Ranks 1–10 that is not in the set triggers a chime and gets a `NEW` badge for 15s. A symbol moving up from Ranks 11–15 is already in the set, so it stays silent. Chimes are spaced at least 1.5s apart, and entries that arrive inside that window share one follow-up chime.
3. **Hysteresis.** After each check, Ranks 1–15 are added to the set. A symbol is removed only when its rank goes above 15 or it gets filtered out, so a contract bouncing between Rank 9 and Rank 13 never re-triggers.

While the socket is not `CONNECTED`, the sets keep updating but no sound plays, so a reconnect doesn't cause a burst of chimes. Search and the row-count setting never affect rankings.

## Theme

Colors are CSS variables switched by `data-theme="dark" | "light"` on `<html>`. Dark is the default. The choice is saved in `localStorage` and applied before first paint. Text uses Geist, and every number uses Geist Mono with `tabular-nums`.

## Keyboard shortcuts

`1` `2` `3` switch the timeframe · `T` toggles the theme · `/` focuses search · `Esc` clears search
