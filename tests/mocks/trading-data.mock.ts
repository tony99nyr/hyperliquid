/**
 * Mock trading data for testing
 * Provides synthetic price candles, trades, and portfolios for consistent testing
 */

import type { PriceCandle, Trade, Portfolio, PortfolioSnapshot } from '@/types';

/**
 * Generate synthetic price candles with various patterns
 */
export function generatePriceCandles(
  pattern: 'trending-up' | 'trending-down' | 'sideways' | 'volatile' | 'bull-run' | 'bear-market',
  count: number,
  startPrice: number = 2500,
  startTimestamp: number = Date.now() - (count * 24 * 60 * 60 * 1000) // Default: daily candles
): PriceCandle[] {
  const candles: PriceCandle[] = [];
  let currentPrice = startPrice;
  const baseTimestamp = startTimestamp;

  for (let i = 0; i < count; i++) {
    const timestamp = baseTimestamp + (i * 24 * 60 * 60 * 1000); // Daily candles by default
    let open: number;
    let close: number;
    let high: number;
    let low: number;
    const volume = 1000000 + Math.random() * 500000;

    switch (pattern) {
      case 'trending-up':
        open = currentPrice;
        close = currentPrice * (1 + 0.01 + Math.random() * 0.02); // 1-3% gain
        high = close * (1 + Math.random() * 0.01);
        low = open * (1 - Math.random() * 0.01);
        currentPrice = close;
        break;

      case 'trending-down':
        open = currentPrice;
        close = currentPrice * (1 - 0.01 - Math.random() * 0.02); // 1-3% loss
        high = open * (1 + Math.random() * 0.01);
        low = close * (1 - Math.random() * 0.01);
        currentPrice = close;
        break;

      case 'sideways':
        open = currentPrice;
        close = currentPrice * (1 + (Math.random() - 0.5) * 0.02); // -1% to +1%
        high = Math.max(open, close) * (1 + Math.random() * 0.005);
        low = Math.min(open, close) * (1 - Math.random() * 0.005);
        currentPrice = close;
        break;

      case 'volatile':
        open = currentPrice;
        const change = (Math.random() - 0.5) * 0.1; // -5% to +5%
        close = currentPrice * (1 + change);
        high = Math.max(open, close) * (1 + Math.abs(change) * 0.5);
        low = Math.min(open, close) * (1 - Math.abs(change) * 0.5);
        currentPrice = close;
        break;

      case 'bull-run':
        open = currentPrice;
        close = currentPrice * (1 + 0.02 + Math.random() * 0.05); // 2-7% gain
        high = close * (1 + Math.random() * 0.02);
        low = open * (1 - Math.random() * 0.01);
        currentPrice = close;
        break;

      case 'bear-market':
        open = currentPrice;
        close = currentPrice * (1 - 0.02 - Math.random() * 0.05); // 2-7% loss
        high = open * (1 + Math.random() * 0.01);
        low = close * (1 - Math.random() * 0.02);
        currentPrice = close;
        break;
    }

    candles.push({
      timestamp,
      open,
      high,
      low,
      close,
      volume,
    });
  }

  return candles;
}

/**
 * Create a mock trade
 */
export function createMockTrade(
  type: 'buy' | 'sell',
  price: number,
  amount: number,
  timestamp: number = Date.now(),
  signal: number = type === 'buy' ? 0.5 : -0.5,
  confidence: number = 0.7,
  pnl?: number
): Trade {
  return {
    id: `trade-${timestamp}`,
    timestamp,
    type,
    ethPrice: price,
    ethAmount: amount,
    usdcAmount: price * amount,
    signal,
    confidence,
    portfolioValue: 1000, // Will be updated by test
    costBasis: type === 'buy' ? price * amount : undefined,
    pnl: type === 'sell' ? pnl : undefined,
  };
}

/**
 * Create a mock portfolio
 */
export function createMockPortfolio(
  usdcBalance: number = 1000,
  ethBalance: number = 0,
  initialCapital: number = 1000
): Portfolio {
  return {
    usdcBalance,
    ethBalance,
    totalValue: usdcBalance + ethBalance * 2500, // Assume ETH price of 2500
    initialCapital,
    totalReturn: 0,
    tradeCount: 0,
    winCount: 0,
  };
}

/**
 * Create mock portfolio snapshots
 */
export function createMockPortfolioSnapshots(
  candles: PriceCandle[],
  initialCapital: number = 1000
): PortfolioSnapshot[] {
  return candles.map(candle => ({
    timestamp: candle.timestamp,
    usdcBalance: initialCapital * 0.5, // Example: 50% in USDC
    ethBalance: (initialCapital * 0.5) / candle.close, // 50% in ETH
    totalValue: initialCapital * 0.5 + (initialCapital * 0.5 / candle.close) * candle.close,
    ethPrice: candle.close,
  }));
}

/**
 * Generate a sequence of trades for testing
 */
export function generateTradeSequence(
  candles: PriceCandle[],
  buyIndices: number[],
  sellIndices: number[]
): Trade[] {
  const trades: Trade[] = [];
  let ethHeld = 0;
  let costBasis = 0;

  // Process buy trades
  for (const index of buyIndices) {
    if (index >= candles.length) continue;
    const candle = candles[index];
    const amount = 0.1; // Buy 0.1 ETH
    const cost = candle.close * amount;
    ethHeld += amount;
    costBasis += cost;

    trades.push(createMockTrade('buy', candle.close, amount, candle.timestamp, 0.5, 0.7));
  }

  // Process sell trades
  for (const index of sellIndices) {
    if (index >= candles.length) continue;
    const candle = candles[index];
    if (ethHeld <= 0) continue;

    const amount = Math.min(ethHeld, 0.1); // Sell up to 0.1 ETH
    const revenue = candle.close * amount;
    // Average cost per ETH = total cost basis / total ETH held
    const avgCostPerEth = costBasis / ethHeld;
    const pnl = revenue - (avgCostPerEth * amount);

    ethHeld -= amount;
    costBasis -= avgCostPerEth * amount;

    trades.push(createMockTrade('sell', candle.close, amount, candle.timestamp, -0.5, 0.7, pnl));
  }

  return trades;
}

