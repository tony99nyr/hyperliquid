/**
 * Core Trading Types (vendored from iamrossi — self-contained subset).
 *
 * Only the types the vendored strategy engine + mocks reference. Money/position
 * types for the cockpit live in position.ts / fill.ts / cockpit.ts.
 */

/**
 * Data source for price candles. On-chain sources are authoritative; API
 * sources are gap-fill only. (Kept for parity with vendored candle code.)
 */
export type CandleSource =
  | 'uniswap-onchain'
  | 'chainlink'
  | 'binance'
  | 'cryptocompare'
  | 'coingecko'
  // Hyperliquid candle source (new in this repo)
  | 'hyperliquid';

export interface PriceCandle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** Data source for this candle (optional for backwards compatibility). */
  source?: CandleSource;
}

export type SignalAction = 'buy' | 'sell' | 'hold';

export interface TradingSignal {
  timestamp: number;
  signal: number; // -1 to +1
  confidence: number; // 0 to 1
  indicators: Record<string, number>;
  action: SignalAction;
}

/**
 * Trade — the vendored ATR stop-loss + risk-reward validator reference this.
 * Field names "ethPrice"/"ethAmount" are historical (hold the active asset's
 * price/amount regardless of symbol). Kept verbatim so vendored logic + its
 * tests pass unchanged.
 */
export interface Trade {
  id: string;
  timestamp: number;
  type: 'buy' | 'sell';
  /** Asset price in USD. Named "ethPrice" for historical reasons. */
  ethPrice: number;
  /** Trade amount in asset units. Named "ethAmount" for historical reasons. */
  ethAmount: number;
  usdcAmount: number;
  signal: number;
  confidence: number;
  portfolioValue: number;
  costBasis?: number;
  pnl?: number;
  fullySold?: boolean;
  exitReason?: string;
  executionState?: 'pending' | 'executing' | 'filled' | 'failed';
  executionAttempts?: number;
  executionError?: string;
  transactionHash?: string;
  tradeCosts?: {
    fee: number;
    slippage: number;
    gasCost: number;
    totalCost: number;
  };
}

/**
 * Minimal Portfolio / PortfolioSnapshot shapes referenced by the vendored
 * `trading-data.mock` test helper. Not used by cockpit runtime logic.
 */
export interface Portfolio {
  usdcBalance: number;
  ethBalance: number;
  totalValue: number;
  initialCapital: number;
  totalReturn: number;
  tradeCount: number;
  winCount: number;
}

export interface PortfolioSnapshot {
  timestamp: number;
  usdcBalance: number;
  ethBalance: number;
  totalValue: number;
  ethPrice: number;
}
