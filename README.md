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
| `lib/mexcSocket.ts` | The app's **only** MEXC WebSocket: one 15s `ping` heartbeat, one reconnect loop with backoff, and a registry of the channels the current mode needs. That registry is re-sent after every reconnect. |
| `hooks/useScanner.ts` | Scanner data: bootstrap, then `sub.tickers`, then a silent re-sync every 60s and when the tab becomes visible or the connection returns. Pauses entirely in Single-Coin Focus Mode. |
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

## Single-Coin Focus Mode (drawer open)

Opening a contract switches the app to that one coin. `useScanner` sets the mode on the shared socket with `mexcSocket.setFocus(symbol)`, and each change sends its unsubscribes before its subscribes.

| Transition | Frames on the single MEXC socket |
| --- | --- |
| Open | `unsub.tickers` → `sub.ticker`, `sub.kline` (Min1), `sub.deal` (`compress:false, reduce:false`) for the symbol |
| Switch coin | `unsub.ticker/kline/deal` for the previous coin → `sub.ticker/kline/deal` for the next |
| Close | `unsub.ticker/kline/deal` → `sub.tickers` |

While a coin is open:

- **`/api/scanner` is never called.** The 60s interval is cleared, any sync already in flight is aborted, and the visibility, online and reconnect syncs are skipped.
- **The leaderboards are frozen.** The store's 250ms flush stops, and the board inputs (rows, timeframe, filter, search, row count) are held, so nothing re-sorts or re-renders. The boards show a `Paused` badge and the status bar shows `FOCUS … · SCANNER PAUSED`.
- **Only these requests and streams run:**
  - one `GET /api/contract/{symbol}`;
  - the coin's three MEXC channels;
  - liquidation streams for that coin's base asset:
    - Binance per-symbol `…@forceOrder` streams (one combined socket);
    - Bybit `allLiquidation.{BASE}USDT`, exactly one topic;
    - OKX metadata fetched only for `{BASE}-USDT-SWAP` and `{BASE}-USD-SWAP`, with no OKX socket if OKX doesn't list the coin.
- **Search makes no requests.** The lookup list is fetched once while the scanner is showing, and searching inside the drawer filters it in memory.

Closing the drawer resubscribes `sub.tickers`. If the last `/api/scanner` sync is more than 45s old, it runs one immediate sync, then restarts the 60s interval. For 3s after closing, and while that catch-up sync runs plus 1.5s after it lands, each new ranking frame silently re-seeds the known Top 15 sets, so closing never causes a burst of late Top 10 chimes.

Limits set by the exchanges, not by this app:

- **OKX.** The `liquidation-orders` channel only accepts `instType`; per-coin filters are ignored (checked live), so OKX events are filtered in the browser.
- **Bybit.** Subscribing to exactly one topic means coins Bybit lists only with a `1000` prefix (e.g. `1000PEPEUSDT`) get no Bybit events.

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
| Chart | `components/MicroChart.tsx`, `lib/chartViewport.ts` | Plain `<canvas>`, backing store scaled by DPR, crosshair with OHLCV readout. **1M** = 60 live Min1 candles. **10S** = 10-second candles (up to 90, 15 minutes). **1S** = 1-second candles (up to 180, 3 minutes). Both come from the last 100 REST trades plus live `sub.deal` trades (`compress:false, reduce:false`), deduplicated by trade id. The **Smooth** toggle (`mexc_chart_smooth`, default on) applies to 10S and 1S. It anchors each candle to the previous close so there are no gaps, applies Heikin-Ashi smoothing, and draws bodies at least 3px tall. The live price line, axis tags and OHLCV readout always show the exact market fills, and the readout shows a `SMOOTH` tag while it is on. Zoom shows 10 bars up to the buffer size (60 on 1M, 90 on 10S, 180 on 1S), default 36, using the wheel, pinch, `−`/`+`/`100%` buttons or the `+`/`-` keys. Drag, horizontal scroll or the arrow keys pan into history, and `Live ⇥` or `End` returns to live. In follow mode the newest bar stays in the rightmost slot, 8px from the price scale. While panned, the view stays on the same bars as new ones arrive. The price range and volume scale come from the visible bars only. The **BG Price** watermark (`mexc_chart_bg_price`, default on) is drawn on the canvas after the gridlines and before the volume, candles, price line and crosshair. |
| Liquidations | `hooks/useCrossExchangeLiquidations.ts`, `lib/liquidations.ts`, `lib/liquidationFeed.ts` | Binance `!forceOrder@arr`, Bybit `allLiquidation.*`, OKX `liquidation-orders`. Rolling 15-minute window plus a session tape. |
| Bias | `lib/biasScore.ts`, `components/DirectionalBiasBar.tsx` | A 4-factor orderflow model scored from −50 to +50, with a regime label and a tug-of-war gauge (see below). |

Where this deliberately differs from the original spec, following exchange documentation and live data:

- **Bybit side mapping.** In `allLiquidation`, `S` is the *position* side. Bybit's docs say: "When you receive a `Buy` update, this means that a long position has been liquidated". So `Buy` maps to LONG LIQ. The spec had the reverse, which would have flipped the sign of every Bybit event.
- **OKX inverse swaps.** For `*-USD-SWAP` contracts, `ctVal` is already in USD, so notional is `sz × ctVal`. Applying `sz × bkPx × ctVal` would overstate BTC by about 60,000×. Linear swaps still use `sz × bkPx × ctVal`.
- **Flat-market CLV.** When the high–low range is zero, CLV is set to 0 (neutral). The raw formula returns −1 there, which would score a perfectly flat market as −5 bearish.
- **MEXC trade volume is in contracts.** For the 1S chart, turnover is computed as `p × v × contractSize`. The Min1 kline push sends volume as `q`, not `v`.
- **OKX connects on `:443` first** and falls back to `:8443`, because many firewalls block `:8443`.
- **One shared Binance connection.** The all-market stream is reused when you switch contracts and closes 1.5s after the drawer closes.
- **Binance silence warning.** Binance blocks some regions, including the US (HTTP 451). There the socket still opens but sends nothing, so 120s of silence turns the BN dot red with an explanatory tooltip.
- **No sockets for unknown contracts.** A 404 contract never opens liquidation sockets, and its MEXC socket is closed as soon as the 404 arrives.

## 15M flow bias

`calculateBiasScore` is pure and deterministic. It combines three factors, each fed from data the drawer already streams (no extra requests):

| Factor | Range | Inputs |
| --- | --- | --- |
| **CVD** (taker flow) | ±20 | Trailing-15m trades, kept with their MEXC side (`T`: 1 buy, 2 sell) and open/close intent (`O`). Notional = price × quantity × contract size, with the size derived from the candles as the median of turnover / (contracts × close). Trades that open positions count ×1.25 and trades that close them count ×0.75. Minutes before the first known trade are backfilled from intrabar close-location delta. The result is multiplied by a 15m-vs-60m volume pace factor, clamped to 0.65–1.5. |
| **VWAP** (price) | ±15 | `15·tanh(0.45·netZ + 0.35·vwapZ + 0.30·CLV)`. netZ and vwapZ are the net 15m move and the distance from the 15m VWAP, both divided by 15-minute ATR. |
| **LIQ** (liquidations) | ±15 | `15·(short − long) / max(short + long, max($5k, 0.05% of 24h turnover))`. Damped ×0.2 when price has reclaimed above the liquidation VWAP after a long flush, or rejected below it after a short squeeze. |

The net score is the sum of the rounded factors. The regime is the first rule that matches, in order: `SHORT SQUEEZE`, `LONG CASCADE`, `BEAR DIVERGENCE`, `BULL DIVERGENCE`, `BULL TREND`, `BEAR TREND`, `CHOP`.

**The gauge** has a center-zero track. Each positive factor stacks rightward from 0 and each negative factor stacks leftward, in CVD → VWAP → LIQ order, with 1 point = 1% of the track width. That keeps opposing forces visible instead of cancelling out: price up while takers sell shows both, plus a `BEAR DIVERGENCE` badge. A 2px needle marks the exact net.

**Two guards beyond the formulas:**

- When the 15m turnover is zero, VWAP is treated as equal to the current price. The `max(Σamount, 1)` floor would otherwise make VWAP 0 and score an untraded market +15 bullish.
- A perfectly flat 15m range gives CLV = 0. The raw formula gives −1.

## Settings (⚙)

All toggles live in a top-right cog: a 28px button that opens a 240px panel. Click outside to close it. **Escape closes the panel first**: it is caught in the capture phase, so it never also closes the drawer. A second Escape closes the drawer.

| Main page cog | Drawer cog (next to ×) |
| --- | --- |
| Theme (Dark / Light, `T`) | Theme (shared with the main page) |
| Alert volume + `Test` | The same alert volume + `▼ Long` / `▲ Short` previews |
| Leaderboard depth: Top 25 / 50 / All (`mx-limit`) | Chart liquidation overlay (`mexc_chart_liq_overlay`, default on) |
| | Candle smoothing (`mexc_chart_smooth`, default on) |
| | Background price (`mexc_chart_bg_price`, default on) |

The header keeps only the live filters (timeframe, 24h volume, search). The chart toolbar keeps only zoom and `1M | 10S | 1S`, which fits on one line at 375px.

### Alert volume

Both cogs show one shared volume control. It is stored as `mexc_audio_volume` (0–100, default 75) and `mexc_audio_prev_volume` (the last non-zero level). The control has three parts:

- **Mute button.** Remembers the current level and sets 0; pressing it again restores the remembered level.
- **0–100 slider.** Any level above 0 also becomes the new remembered level.
- **Live number readout.**

The volume drives the Top 10 chime and the live liquidation pings. 0 plays nothing. Anything above 0 scales each tone's envelope peak by `(v/100)²` (perceptual), using the same click-free ramps. The `Test`, `Long` and `Short` previews still play while muted, at the remembered level. One upgrade case: if you had explicitly switched the old Top 10 ping off, you start muted.

### Leaderboard interactions

- **Row click.** The entire row opens the Contract Inspection Drawer. The main page has no external links; the MEXC link and copy button live in the drawer header.
- **Vol % sort.** The `Vol %` column header cycles: **↓** highest volume change first, **↑** lowest first, then back to the normal Price Move % order. Each board sorts independently. Contracts without enough history yet sort last. Rank numbers, Top 10 alerts and NEW badges always follow the Price Move % ranking, so re-sorting never triggers a chime.

### Chart liquidation overlay

Liquidations from Binance, Bybit and OKX, both from the rolling 15-minute window and from this session, are summed per candle in the chart's own buckets: `floor(ts / 60000)` on 1M, `/ 10000` on 10S, `/ 1000` on 1S. They are drawn on the canvas:

- **Volume bars** use a neutral fill: `max(4, floor(slot × 0.74))` wide, never wider than the candle slot.
- **Liquidation bars** are drawn on top of them and are thinner. A candle with only longs or only shorts gets one centred bar, `max(2, floor(volW × 0.32))` wide. A candle with both gets two bars side by side, each `max(2, floor(volW × 0.26))` wide with a 1px gap.
- **Colours:** purple is long positions liquidated (`#A855F7` dark / `#9333EA` light), yellow is short positions liquidated (`#FACC15` / `#CA8A04`).
- **Height** is scaled against the visible USD volume (minimum 3px), so a bar never reaches into the candle area.

A legend pill appears in the chart corner, and the OHLCV readout adds `L-Liq` / `S-Liq` for any bar that has liquidations.

## Security

**HTTP headers** (`next.config.ts`, every route):
- A strict CSP:
  - `default-src 'self'`.
  - `connect-src` lists only the endpoints the browser actually uses:
    - `wss://contract.mexc.com`
    - `wss://fstream.binance.com`
    - `wss://stream.bybit.com`
    - `wss://ws.okx.com` (ports 443 and 8443)
    - `https://www.okx.com`
  - `'unsafe-inline'` is allowed for scripts and styles, because Next streams inline bootstrap scripts.
  - `'unsafe-eval'` is allowed only under `next dev`.
  - `object-src 'none'` and `frame-ancestors 'none'`.
- `X-Frame-Options: DENY`, `nosniff`, `strict-origin-when-cross-origin`, a locked-down `Permissions-Policy` and a 2-year HSTS with `preload`.

**API routes** (`app/api/*`, `lib/server/*`):
- **Symbols.**
  - `/api/contract/[symbol]` accepts only `^[A-Z0-9]{1,20}_USDT$`, exactly as given. It never lowercases, never accepts aliases, and never percent-decodes a second time.
  - Anything else gets a `400` before any outbound request.
  - Valid-looking symbols that MEXC doesn't list get a `404` from a cached allowlist of active contracts, so random symbols cost no upstream calls.
- **No query strings.** Every route rejects them with a `400`, so `?cb=N` cache-busting can't bypass the CDN cache.
- **Coalescing.**
  - `/api/scanner` concurrent misses share one in-flight build, and that build is memoized for 10s.
  - Contract detail is memoized for 2s per symbol, and the symbol list for 60s.
- **Rate limits.** A per-client token bucket on each instance returns `429` with `Retry-After`.
- **Outbound fetches** (`lib/server/upstream.ts`):
  - A 5s `AbortSignal.timeout` that also covers the response body.
  - Redirects are not followed.
  - The response must have a JSON `Content-Type`.
  - The body is streamed with a 4MB cap.
  - The bootstrap as a whole has a 20s budget, well under the function's `maxDuration`.
- **Errors.** Error bodies contain only the app's own messages, never stack traces.

**Untrusted exchange data** (`lib/sanitize.ts`, all parsers):
- **Numbers.**
  - Prices must be finite and in `(0, 1e9]`.
  - A notional larger than $100B is dropped. This includes `1e200 × 1e200`.
  - Timestamps must fall between 2015 and 5 minutes in the future. Liquidations with absurd timestamps are re-stamped with the time they were received.
  - A future-dated kline or trade can no longer freeze the chart.
- **Parsing.**
  - Frames larger than 4MB and binary frames are dropped.
  - JSON is parsed with `__proto__`, `constructor` and `prototype` keys stripped.
  - A parser that throws can't stop the frames that follow it, and a crashed listener can't starve the others.
- **Bounded buffers**, so memory stays flat under a flood of 10k messages a second:

  | Buffer | Cap |
  | --- | --- |
  | Liquidations window (`MAX_LIQUIDATIONS`) | 500 |
  | Liquidation tape | 200 |
  | Raw trades (`MAX_DEALS`) | 2,000 |
  | 1S candles (`MAX_1S_CANDLES`) | 180 |
  | 10S candles | 90 |
  | Min1 candles | 60 |

  - Liquidation totals stay exact past the cap: they come from per-second buckets.
  - Trades evicted from the raw log are folded into 10-second aggregates, so 15-minute CVD stays exact.
- **Storage and rendering.**
  - Every `localStorage` value is checked against an allowlist when it is read. Corrupt or unexpected values fall back to defaults, and blocked storage falls back to memory.
  - All exchange strings render as React text or canvas `fillText`. There are no `eval` calls, `new Function` calls or `javascript:` URLs.
  - The only `dangerouslySetInnerHTML` is the constant pre-paint theme script.
  - Error boundaries contain render crashes: one around the drawer and one for the whole route (`app/error.tsx`).

## Keyboard shortcuts

`1` `2` `3` switch the timeframe · `T` toggles the theme · `/` focuses search · `Enter` opens the highlighted contract · `Esc` closes the lookup list, then clears search, then closes the drawer
