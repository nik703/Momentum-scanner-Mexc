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
