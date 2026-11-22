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
npm run verify     # bias engine + liquidation parser verification (tsx scripts/verify-features.ts)
npm run lint       # eslint, zero warnings allowed
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

**Muted while the drawer is open.** While the Contract Inspection Drawer is open, the Top 10 chime is muted, including a trailing chime already queued in the 1.5s window. Both sets still update on every rank tick, and NEW badges still appear. When you close the drawer, contracts that entered during the inspection don't chime late; only new entries from outside the Top 15 do. The decision logic is in `LeaderboardAlertEngine` in `lib/alerts.ts`.

## Sounds

Every sound is synthesized with Web Audio: sine oscillators with click-free exponential envelopes, no audio files. All of them follow the top bar **Ping** toggle.

| Sound | Contour | When |
| --- | --- | --- |
| `playLeaderboardPing()` | 880 → 1320 Hz, upward, 180ms per tone | A contract enters the Top 10 from outside the Top 15 (drawer closed) |
| `playShortLiqPing()` | 880 → 1245 Hz, ascending, 160ms | A live SHORT liquidation (forced buy, bullish squeeze) for the contract open in the drawer |
| `playLongLiqPing()` | 740 → 554 Hz, descending, 160ms | A live LONG liquidation (forced sell, bearish flush) for the contract open in the drawer |

- **90ms spacing.** Liquidation pings are spaced at least 90ms apart, so simultaneous fills from Binance, Bybit and OKX play in sequence instead of stacking. During a big cascade, at most about 0.72s of pings is queued and any extra are dropped.
- **Live events only.** Pings fire only for events the browser receives after the drawer opened. The check uses local receive time, not the exchange's timestamp, because exchange clocks differ from yours: a fill stamped just before you opened the drawer may arrive after it. Switching contracts remounts the drawer, which re-arms this check.
- **Preview buttons.** The `▼ Long` / `▲ Short` buttons in the drawer's Liquidations header play each ping; clicking one also unlocks browser audio.

## Theme

Colors are CSS variables switched by `data-theme="dark" | "light"` on `<html>`. Dark is the default. The choice is saved in `localStorage` and applied before first paint. Text uses Geist, and every number uses Geist Mono with `tabular-nums`.

## Contract Inspection Drawer

Click any leaderboard row, or look up **any** active MEXC USDT-M contract from the top bar (1,000+ contracts, not just the scanner's Top 150). Enter or a click opens the drawer. On desktop it is a 520px slide-over below the top bar; on mobile it is a full-screen sheet. `Esc` closes it. The scanner and its Top 10 alerts keep running underneath.

| Piece | File | Notes |
| --- | --- | --- |
| Contract API | `app/api/contract/[symbol]/route.ts` | Accepts `sol`, `SOLUSDT` or `SOL_USDT`. Fetches 60×Min1 klines, the ticker and contract detail (for contract size) in parallel, with one retry each. Returns 400 for malformed input and 404 for unknown or non-USDT contracts. Cached with `s-maxage=5, stale-while-revalidate=10`. |
| Lookup list | `app/api/symbols/route.ts` | Every active `*_USDT` perpetual, cached for 60s. |
| Live contract feed | `lib/contractFeed.ts` | `sub.kline` (Min1), `sub.deal` (`compress:false`) and `sub.ticker`. Sends `unsub.*` on symbol change or close. |
| Chart | `components/MicroChart.tsx`, `lib/chartViewport.ts` | Plain `<canvas>`, backing store scaled by DPR, crosshair with OHLCV readout. **1M** = 60 live Min1 candles. **1S** = trades bucketed into 1-second candles, last 120s. Zoom shows 10 to 60 bars on 1M and 10 to 120 on 1S, default 36, using the wheel, pinch, `−`/`+`/`100%` buttons or the `+`/`-` keys. Drag, horizontal scroll or the arrow keys pan into history, and `Live ⇥` or `End` returns to live. In follow mode the newest bar stays in the rightmost slot, 8px from the price scale. While panned, the view stays on the same bars as new ones arrive. The price range and volume scale come from the visible bars only. The **BG Price** watermark (`mexc_chart_bg_price`, default on) is drawn on the canvas after the gridlines and before the volume, candles, price line and crosshair. |
| Liquidations | `hooks/useCrossExchangeLiquidations.ts`, `lib/liquidations.ts`, `lib/liquidationFeed.ts` | Binance `!forceOrder@arr`, Bybit `allLiquidation.*`, OKX `liquidation-orders`. Rolling 15-minute window plus a session tape. |
| Bias | `lib/biasScore.ts`, `components/DirectionalBiasBar.tsx` | Score from −50 to +50: price action ±20, volume pressure ±15, liquidation imbalance ±15. |

Where this deliberately differs from the original spec, following exchange documentation and live data:

- **Bybit side mapping.** In `allLiquidation`, `S` is the *position* side. Bybit's docs say: "When you receive a `Buy` update, this means that a long position has been liquidated". So `Buy` maps to LONG LIQ. The spec had the reverse, which would have flipped the sign of every Bybit event.
- **OKX inverse swaps.** For `*-USD-SWAP` contracts, `ctVal` is already in USD, so notional is `sz × ctVal`. Applying `sz × bkPx × ctVal` would overstate BTC by about 60,000×. Linear swaps still use `sz × bkPx × ctVal`.
- **Flat-market CLV.** When the high–low range is zero, CLV is set to 0 (neutral). The raw formula returns −1 there, which would score a perfectly flat market as −5 bearish.
- **MEXC trade volume is in contracts.** For the 1S chart, turnover is computed as `p × v × contractSize`. The Min1 kline push sends volume as `q`, not `v`.
- **OKX connects on `:443` first** and falls back to `:8443`, because many firewalls block `:8443`.
- **One shared Binance connection.** The all-market stream is reused when you switch contracts and closes 1.5s after the drawer closes.
- **Binance silence warning.** Binance blocks some regions, including the US (HTTP 451). There the socket still opens but sends nothing, so 120s of silence turns the BN dot red with an explanatory tooltip.
- **No sockets for unknown contracts.** A 404 contract never opens liquidation sockets, and its MEXC socket is closed as soon as the 404 arrives.

## Keyboard shortcuts

`1` `2` `3` switch the timeframe · `T` toggles the theme · `/` focuses search · `Enter` opens the highlighted contract · `Esc` closes the lookup list, then clears search, then closes the drawer
