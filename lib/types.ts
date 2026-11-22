/** Wire format returned by GET /api/scanner. */
export interface BootstrapCandles {
  /** Candle open time, epoch ms. */
  t: number[];
  /** Open price. */
  o: number[];
  /** Close price. */
  c: number[];
  /** Turnover in USDT (MEXC `amount`). */
  a: number[];
}

export interface BootstrapSymbol {
  symbol: string;
  lastPrice: number;
  /** 24h turnover in USDT. */
  amount24: number;
  /** 24h volume in contracts. */
  volume24: number;
  /** Up to 24 x Min5 candles, oldest first. Last candle is the in-progress one. */
  k: BootstrapCandles;
}

export interface BootstrapPayload {
  generatedAt: number;
  interval: "Min5";
  symbols: BootstrapSymbol[];
  /** Symbols whose kline fetch failed (they are omitted from `symbols`). */
  failed: number;
}

export type Timeframe = "15M" | "30M" | "1H";

export const TIMEFRAMES: readonly Timeframe[] = ["15M", "30M", "1H"] as const;

/** Number of Min5 candles in each timeframe window. */
export const TF_CANDLES: Record<Timeframe, number> = { "15M": 3, "30M": 6, "1H": 12 };

export interface TfMetrics {
  /** % price move over the window, null when history is too short. */
  move: number | null;
  /** Current window USDT turnover (including live delta). */
  turnover: number;
  /** % change of window turnover vs baseline, null when baseline history is missing. */
  volChange: number | null;
}

export interface ScannerRow {
  symbol: string;
  price: number;
  amount24: number;
  /** -1 / 0 / 1 direction of the latest price change. */
  tickDir: -1 | 0 | 1;
  /** Increments whenever the price changes; used to retrigger the flash animation. */
  tickSeq: number;
  tf: Record<Timeframe, TfMetrics>;
}

export type WsStatus = "CONNECTING" | "CONNECTED" | "RECONNECTING";

/* ------------------------------------------------------------------ */
/* Contract Inspection Drawer                                          */
/* ------------------------------------------------------------------ */

/** One Min1 candle as returned by GET /api/contract/[symbol]. */
export interface ContractKline {
  /** Candle open time, epoch ms. */
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Volume in contracts. */
  vol: number;
  /** Turnover in USDT. */
  amount: number;
}

export interface ContractTicker {
  lastPrice: number;
  fairPrice: number;
  indexPrice: number;
  /** Funding rate as a fraction (0.0001 = 0.01%). */
  fundingRate: number;
  amount24: number;
  volume24: number;
  /** 24h change as a fraction. */
  riseFallRate: number;
  high24Price: number;
  lower24Price: number;
  holdVol: number;
  timestamp: number;
}

/** One recent trade from GET /api/contract/[symbol] (oldest first). */
export interface ContractTrade {
  /** MEXC trade id, used to dedupe REST history against the live sub.deal stream. */
  id: string;
  price: number;
  /** Quantity in contracts. */
  vol: number;
  /** Taker side. */
  side: "buy" | "sell";
  timestampMs: number;
}

export interface ContractDetail {
  symbol: string;
  baseCoin: string;
  /** Base units per contract (e.g. 0.0001 BTC). Null if the detail endpoint failed. */
  contractSize: number | null;
  priceScale: number | null;
  ticker: ContractTicker;
  /** Up to 60 Min1 candles, oldest first; the last one is still forming. */
  klines: ContractKline[];
  /**
   * Up to 100 most recent trades, oldest first. MEXC caps this endpoint at 100 whatever `limit`
   * is: about 7s of BTC, minutes of mid-caps. [] if unavailable. Hydrates the 10S and 1S charts.
   */
  trades: ContractTrade[];
  generatedAt: number;
}

export interface ApiError {
  error: string;
  detail?: string;
}

/** Item in GET /api/symbols (every active *_USDT perpetual). */
export interface UniverseItem {
  symbol: string;
  lastPrice: number;
  amount24: number;
  /** 24h change as a fraction. */
  riseFallRate: number;
}

/** Internal chart candle (epoch-ms open time; v = contracts, a = USDT turnover). */
export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  a: number;
}
