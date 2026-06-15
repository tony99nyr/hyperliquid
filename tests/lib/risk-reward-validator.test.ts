import { describe, it, expect } from 'vitest';
import {
  calculatePriceMovement,
  detectCrash,
  assessMarketRisk,
  countStrategyDirections,
  calculateConflictRatio,
  findBlockedWarnings,
  assessSignalQuality,
  assessConflictRisk,
  assessPortfolioRisk,
  assessTrendAlignment,
  assessMomentumExhaustion,
  assessExitRisk,
  validateSignal,
  createValidatorConfig,
  DEFAULT_VALIDATOR_CONFIG,
  type PriceMovement,
  type MarketContext,
  type PortfolioState,
  type PositionContext,
  type SignalToValidate,
  type StrategySignalInput,
} from '@/lib/strategy/validation/risk-reward-validator';
import type { PriceCandle } from '@/types';

// ============================================================================
// TEST HELPERS
// ============================================================================

function createCandles(prices: number[]): PriceCandle[] {
  return prices.map((price, i) => ({
    timestamp: Date.now() + i * 8 * 60 * 60 * 1000,
    open: price,
    high: price * 1.01,
    low: price * 0.99,
    close: price,
    volume: 1000,
  }));
}

function createMarketContext(overrides: Partial<MarketContext> = {}): MarketContext {
  return {
    currentPrice: 100,
    volatility: 0.03,
    adx: 25,
    regime: 'neutral',
    regimeConfidence: 0.5,
    ...overrides,
  };
}

function createPortfolio(overrides: Partial<PortfolioState> = {}): PortfolioState {
  return {
    currentDrawdown: 0.05,
    recentWinRate: 0.5,
    consecutiveLosses: 0,
    periodsSinceLastTrade: 10,
    ...overrides,
  };
}

function createStrategy(
  name: string,
  signal: number,
  action: 'buy' | 'sell' | 'hold',
  confidence: number = Math.abs(signal),
  isActive: boolean = true,
  guardPassed: boolean = true
): StrategySignalInput {
  return { name, signal, confidence, action, isActive, guardPassed };
}

function createSignal(
  action: 'buy' | 'sell' | 'hold',
  signal: number,
  confidence: number,
  strategies: StrategySignalInput[]
): SignalToValidate {
  return { action, signal, confidence, strategyResults: strategies };
}

// ============================================================================
// PRICE MOVEMENT TESTS
// ============================================================================

describe('calculatePriceMovement', () => {
  it('calculates single period change correctly', () => {
    const candles = createCandles([100, 95]); // -5% drop
    const movement = calculatePriceMovement(candles, 1);
    expect(movement.singlePeriodChange).toBeCloseTo(-0.05, 4);
  });

  it('calculates short term change over 10 periods', () => {
    const prices = Array(11).fill(100);
    prices[10] = 90; // -10% from 10 periods ago
    const candles = createCandles(prices);
    const movement = calculatePriceMovement(candles, 10);
    expect(movement.shortTermChange).toBeCloseTo(-0.10, 4);
  });

  it('calculates medium term change over 20 periods', () => {
    const prices = Array(21).fill(100);
    prices[20] = 85; // -15% from 20 periods ago
    const candles = createCandles(prices);
    const movement = calculatePriceMovement(candles, 20);
    expect(movement.mediumTermChange).toBeCloseTo(-0.15, 4);
  });

  it('returns zero for insufficient data', () => {
    const candles = createCandles([100]);
    const movement = calculatePriceMovement(candles, 0);
    expect(movement.singlePeriodChange).toBe(0);
    expect(movement.shortTermChange).toBe(0);
    expect(movement.mediumTermChange).toBe(0);
  });
});

// ============================================================================
// CRASH DETECTION TESTS
// ============================================================================

describe('detectCrash', () => {
  const config = DEFAULT_VALIDATOR_CONFIG.crashDetection;

  it('detects single period crash', () => {
    const movement: PriceMovement = {
      singlePeriodChange: -0.06,
      shortTermChange: -0.02,
      mediumTermChange: -0.01,
    };
    const result = detectCrash(movement, config);
    expect(result.inCrash).toBe(true);
    expect(result.severity).toBe('single');
  });

  it('detects short term crash', () => {
    const movement: PriceMovement = {
      singlePeriodChange: -0.02,
      shortTermChange: -0.12,
      mediumTermChange: -0.05,
    };
    const result = detectCrash(movement, config);
    expect(result.inCrash).toBe(true);
    expect(result.severity).toBe('short');
  });

  it('detects medium term crash', () => {
    const movement: PriceMovement = {
      singlePeriodChange: -0.02,
      shortTermChange: -0.05,
      mediumTermChange: -0.18,
    };
    const result = detectCrash(movement, config);
    expect(result.inCrash).toBe(true);
    expect(result.severity).toBe('medium');
  });

  it('returns no crash for normal movements', () => {
    const movement: PriceMovement = {
      singlePeriodChange: -0.02,
      shortTermChange: -0.05,
      mediumTermChange: -0.08,
    };
    const result = detectCrash(movement, config);
    expect(result.inCrash).toBe(false);
    expect(result.severity).toBe('none');
  });
});

// ============================================================================
// MARKET RISK TESTS
// ============================================================================

describe('assessMarketRisk', () => {
  const config = DEFAULT_VALIDATOR_CONFIG;

  it('fails on crash detection', () => {
    const movement: PriceMovement = {
      singlePeriodChange: -0.06,
      shortTermChange: 0,
      mediumTermChange: 0,
    };
    const context = createMarketContext();
    const result = assessMarketRisk(movement, context, config);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('crash');
  });

  it('fails on high volatility', () => {
    const movement: PriceMovement = {
      singlePeriodChange: 0,
      shortTermChange: 0,
      mediumTermChange: 0,
    };
    // v15 maxVolatility is 0.10, so use 0.12 to trigger failure
    const context = createMarketContext({ volatility: 0.12 });
    const result = assessMarketRisk(movement, context, config);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('volatility too high');
  });

  it('fails on low volatility', () => {
    const movement: PriceMovement = {
      singlePeriodChange: 0,
      shortTermChange: 0,
      mediumTermChange: 0,
    };
    const context = createMarketContext({ volatility: 0.0005 }); // Below 0.001 threshold
    const result = assessMarketRisk(movement, context, config);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('volatility too low');
  });

  it('passes with normal conditions', () => {
    const movement: PriceMovement = {
      singlePeriodChange: -0.01,
      shortTermChange: -0.03,
      mediumTermChange: -0.05,
    };
    const context = createMarketContext({ volatility: 0.03 });
    const result = assessMarketRisk(movement, context, config);
    expect(result.passed).toBe(true);
  });
});

// ============================================================================
// STRATEGY DIRECTION TESTS
// ============================================================================

describe('countStrategyDirections', () => {
  it('counts active strategies correctly', () => {
    const strategies = [
      createStrategy('a', 0.5, 'buy'),
      createStrategy('b', -0.3, 'sell'),
      createStrategy('c', 0.1, 'hold'),
      createStrategy('d', 0.4, 'buy', 0.4, false), // inactive
    ];
    const counts = countStrategyDirections(strategies);
    expect(counts.buy).toBe(1);
    expect(counts.sell).toBe(1);
    expect(counts.hold).toBe(1);
    expect(counts.active).toBe(3);
  });

  it('excludes strategies that failed guards', () => {
    const strategies = [
      createStrategy('a', 0.5, 'buy', 0.5, true, true),
      createStrategy('b', -0.3, 'sell', 0.3, true, false), // guard failed
    ];
    const counts = countStrategyDirections(strategies);
    expect(counts.active).toBe(1);
    expect(counts.buy).toBe(1);
    expect(counts.sell).toBe(0);
  });
});

describe('calculateConflictRatio', () => {
  it('returns 0 for single strategy', () => {
    const strategies = [createStrategy('a', 0.5, 'buy')];
    expect(calculateConflictRatio(strategies)).toBe(0);
  });

  it('returns 0 for unanimous direction', () => {
    const strategies = [
      createStrategy('a', 0.5, 'buy'),
      createStrategy('b', 0.3, 'buy'),
    ];
    expect(calculateConflictRatio(strategies)).toBe(0);
  });

  it('calculates conflict when strategies disagree', () => {
    const strategies = [
      createStrategy('a', 0.5, 'buy'),
      createStrategy('b', -0.3, 'sell'),
    ];
    expect(calculateConflictRatio(strategies)).toBe(0.5); // 1/2 conflict
  });

  it('calculates partial conflict', () => {
    const strategies = [
      createStrategy('a', 0.5, 'buy'),
      createStrategy('b', 0.4, 'buy'),
      createStrategy('c', -0.3, 'sell'),
    ];
    expect(calculateConflictRatio(strategies)).toBeCloseTo(0.333, 2); // 1/3 conflict
  });
});

// ============================================================================
// BLOCKED WARNINGS TESTS
// ============================================================================

describe('findBlockedWarnings', () => {
  it('finds warning from blocked negative signal on buy', () => {
    const strategies = [
      createStrategy('volume', 0.5, 'buy'),
      createStrategy('momentum', -0.15, 'hold', 0.1, true, false), // blocked
    ];
    const signal = createSignal('buy', 0.5, 0.5, strategies);
    const warning = findBlockedWarnings(signal, strategies);
    expect(warning.hasWarning).toBe(true);
    expect(warning.warningSource).toBe('momentum');
  });

  it('no warning if blocked signal is weak', () => {
    const strategies = [
      createStrategy('volume', 0.5, 'buy'),
      createStrategy('momentum', -0.03, 'hold', 0.03, true, false), // weak
    ];
    const signal = createSignal('buy', 0.5, 0.5, strategies);
    const warning = findBlockedWarnings(signal, strategies);
    expect(warning.hasWarning).toBe(false);
  });

  it('no warning if all strategies passed guards', () => {
    const strategies = [
      createStrategy('volume', 0.5, 'buy'),
      createStrategy('momentum', 0.3, 'buy'),
    ];
    const signal = createSignal('buy', 0.4, 0.4, strategies);
    const warning = findBlockedWarnings(signal, strategies);
    expect(warning.hasWarning).toBe(false);
  });
});

// ============================================================================
// SIGNAL QUALITY TESTS
// ============================================================================

describe('assessSignalQuality', () => {
  const config = DEFAULT_VALIDATOR_CONFIG;

  it('passes hold signals', () => {
    const signal = createSignal('hold', 0, 0, []);
    const result = assessSignalQuality(signal, config);
    expect(result.passed).toBe(true);
  });

  it('fails on low confidence', () => {
    const strategies = [createStrategy('a', 0.35, 'buy', 0.35)];
    const signal = createSignal('buy', 0.35, 0.35, strategies);
    const result = assessSignalQuality(signal, config);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('confidence too low');
  });

  it('requires higher confidence for single strategy', () => {
    // v15 singleStrategyMinConfidence is 45%, so 40% should fail
    const strategies = [createStrategy('a', 0.40, 'buy', 0.40)];
    const signal = createSignal('buy', 0.40, 0.40, strategies);
    const result = assessSignalQuality(signal, config);
    expect(result.passed).toBe(false);
  });

  it('passes with sufficient confidence', () => {
    const strategies = [
      createStrategy('a', 0.5, 'buy', 0.5),
      createStrategy('b', 0.4, 'buy', 0.4),
    ];
    const signal = createSignal('buy', 0.45, 0.45, strategies);
    const result = assessSignalQuality(signal, config);
    expect(result.passed).toBe(true);
  });
});

// ============================================================================
// CONFLICT RISK TESTS
// ============================================================================

describe('assessConflictRisk', () => {
  const config = DEFAULT_VALIDATOR_CONFIG;

  it('passes hold signals', () => {
    const signal = createSignal('hold', 0, 0, []);
    const result = assessConflictRisk(signal, config);
    expect(result.passed).toBe(true);
  });

  it('fails on high conflict ratio', () => {
    const strategies = [
      createStrategy('a', 0.5, 'buy'),
      createStrategy('b', -0.5, 'sell'),
    ];
    const signal = createSignal('buy', 0.5, 0.5, strategies);
    // Use stricter config to test conflict detection (v15 default is 0.5)
    const strictConfig = { ...config, maxConflictRatio: 0.4 };
    const result = assessConflictRisk(signal, strictConfig);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('conflict');
  });

  it('fails on strong blocked warning', () => {
    const strategies = [
      createStrategy('volume', 0.5, 'buy'),
      createStrategy('momentum', -0.20, 'hold', 0.1, true, false),
    ];
    const signal = createSignal('buy', 0.5, 0.5, strategies);
    const result = assessConflictRisk(signal, config);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('warns against');
  });

  it('passes with unanimous agreement', () => {
    const strategies = [
      createStrategy('a', 0.5, 'buy'),
      createStrategy('b', 0.4, 'buy'),
    ];
    const signal = createSignal('buy', 0.45, 0.45, strategies);
    const result = assessConflictRisk(signal, config);
    expect(result.passed).toBe(true);
  });
});

// ============================================================================
// PORTFOLIO RISK TESTS
// ============================================================================

describe('assessPortfolioRisk', () => {
  const config = DEFAULT_VALIDATOR_CONFIG;

  it('fails on high drawdown', () => {
    const portfolio = createPortfolio({ currentDrawdown: 0.30 });
    const result = assessPortfolioRisk(portfolio, config);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('drawdown');
  });

  it('fails on consecutive losses', () => {
    const portfolio = createPortfolio({ consecutiveLosses: 6 });
    const result = assessPortfolioRisk(portfolio, config);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('consecutive losses');
  });

  it('passes with healthy portfolio', () => {
    const portfolio = createPortfolio({
      currentDrawdown: 0.10,
      consecutiveLosses: 1,
      recentWinRate: 0.5,
    });
    const result = assessPortfolioRisk(portfolio, config);
    expect(result.passed).toBe(true);
  });
});

// ============================================================================
// TREND ALIGNMENT TESTS
// ============================================================================

describe('assessTrendAlignment', () => {
  const config = DEFAULT_VALIDATOR_CONFIG;

  it('blocks selling in bullish regime', () => {
    const strategies = [createStrategy('a', -0.5, 'sell', 0.5)];
    const signal = createSignal('sell', -0.5, 0.5, strategies);
    // v15 requires regimeConfidence >= 0.5 to block counter-trend
    const context = createMarketContext({ regime: 'bullish', regimeConfidence: 0.6 });
    const result = assessTrendAlignment(signal, context, config);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('counter-trend');
    expect(result.reason).toContain('selling in bullish');
  });

  it('blocks buying in bearish regime', () => {
    const strategies = [createStrategy('a', 0.5, 'buy', 0.5)];
    const signal = createSignal('buy', 0.5, 0.5, strategies);
    // v15 requires regimeConfidence >= 0.5 to block counter-trend
    const context = createMarketContext({ regime: 'bearish', regimeConfidence: 0.6 });
    const result = assessTrendAlignment(signal, context, config);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('counter-trend');
    expect(result.reason).toContain('buying in bearish');
  });

  it('allows selling in bearish regime', () => {
    const strategies = [createStrategy('a', -0.5, 'sell', 0.5)];
    const signal = createSignal('sell', -0.5, 0.5, strategies);
    const context = createMarketContext({ regime: 'bearish', regimeConfidence: 0.4 });
    const result = assessTrendAlignment(signal, context, config);
    expect(result.passed).toBe(true);
    expect(result.score).toBe(0.1); // Low risk for aligned signals
  });

  it('allows buying in bullish regime', () => {
    const strategies = [createStrategy('a', 0.5, 'buy', 0.5)];
    const signal = createSignal('buy', 0.5, 0.5, strategies);
    const context = createMarketContext({ regime: 'bullish', regimeConfidence: 0.4 });
    const result = assessTrendAlignment(signal, context, config);
    expect(result.passed).toBe(true);
    expect(result.score).toBe(0.1);
  });

  it('allows counter-trend when regime confidence is low', () => {
    const strategies = [createStrategy('a', -0.5, 'sell', 0.5)];
    const signal = createSignal('sell', -0.5, 0.5, strategies);
    const context = createMarketContext({ regime: 'bullish', regimeConfidence: 0.1 }); // Low confidence
    const result = assessTrendAlignment(signal, context, config);
    expect(result.passed).toBe(true); // Allowed because regime confidence is low
  });

  it('allows any direction in neutral regime', () => {
    const strategies = [createStrategy('a', 0.5, 'buy', 0.5)];
    const signal = createSignal('buy', 0.5, 0.5, strategies);
    const context = createMarketContext({ regime: 'neutral', regimeConfidence: 0.5 });
    const result = assessTrendAlignment(signal, context, config);
    expect(result.passed).toBe(true);
    expect(result.score).toBe(0.3); // Moderate risk for neutral
  });
});

// ============================================================================
// MOMENTUM EXHAUSTION TESTS
// ============================================================================

describe('assessMomentumExhaustion', () => {
  const config = DEFAULT_VALIDATOR_CONFIG;

  it('blocks buying after big rally', () => {
    const strategies = [createStrategy('a', 0.5, 'buy', 0.5)];
    const signal = createSignal('buy', 0.5, 0.5, strategies);
    // v15 threshold is 12%, so use 15% to trigger exhaustion
    const priceMovement: PriceMovement = {
      singlePeriodChange: 0.02,
      shortTermChange: 0.15, // 15% rally (above v15's 12% threshold)
      mediumTermChange: 0.18,
    };
    const result = assessMomentumExhaustion(signal, priceMovement, config);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('momentum exhausted');
    expect(result.reason).toContain('up');
  });

  it('blocks selling after big drop', () => {
    const strategies = [createStrategy('a', -0.5, 'sell', 0.5)];
    const signal = createSignal('sell', -0.5, 0.5, strategies);
    // v15 threshold is 12%, so use 15% to trigger exhaustion
    const priceMovement: PriceMovement = {
      singlePeriodChange: -0.02,
      shortTermChange: -0.15, // 15% drop (above v15's 12% threshold)
      mediumTermChange: -0.18,
    };
    const result = assessMomentumExhaustion(signal, priceMovement, config);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('momentum exhausted');
    expect(result.reason).toContain('down');
  });

  it('allows buying after small move', () => {
    const strategies = [createStrategy('a', 0.5, 'buy', 0.5)];
    const signal = createSignal('buy', 0.5, 0.5, strategies);
    const priceMovement: PriceMovement = {
      singlePeriodChange: 0.01,
      shortTermChange: 0.03, // Only 3%
      mediumTermChange: 0.05,
    };
    const result = assessMomentumExhaustion(signal, priceMovement, config);
    expect(result.passed).toBe(true);
  });

  it('allows selling after small move', () => {
    const strategies = [createStrategy('a', -0.5, 'sell', 0.5)];
    const signal = createSignal('sell', -0.5, 0.5, strategies);
    const priceMovement: PriceMovement = {
      singlePeriodChange: -0.01,
      shortTermChange: -0.03, // Only -3%
      mediumTermChange: -0.05,
    };
    const result = assessMomentumExhaustion(signal, priceMovement, config);
    expect(result.passed).toBe(true);
  });
});

// ============================================================================
// MAIN VALIDATOR TESTS
// ============================================================================

describe('validateSignal', () => {
  const config = DEFAULT_VALIDATOR_CONFIG;

  it('approves hold signals', () => {
    const signal = createSignal('hold', 0, 0, []);
    const candles = createCandles(Array(50).fill(100));
    const context = createMarketContext();
    const portfolio = createPortfolio();

    const result = validateSignal(signal, candles, 49, context, portfolio, config);
    expect(result.approved).toBe(true);
    expect(result.riskScore).toBe(0);
  });

  it('blocks during crash', () => {
    const strategies = [createStrategy('a', 0.5, 'buy', 0.5)];
    const signal = createSignal('buy', 0.5, 0.5, strategies);

    // Create crash scenario: price drops 6% in last candle
    const prices = Array(50).fill(100);
    prices[49] = 94; // -6%
    const candles = createCandles(prices);

    const context = createMarketContext();
    const portfolio = createPortfolio();

    const result = validateSignal(signal, candles, 49, context, portfolio, config);
    expect(result.approved).toBe(false);
    expect(result.blockReason).toContain('Market');
    expect(result.blockReason).toContain('crash');
  });

  it('blocks low confidence signals', () => {
    const strategies = [createStrategy('a', 0.2, 'buy', 0.2)];
    const signal = createSignal('buy', 0.2, 0.2, strategies);
    const candles = createCandles(Array(50).fill(100));
    const context = createMarketContext();
    const portfolio = createPortfolio();

    const result = validateSignal(signal, candles, 49, context, portfolio, config);
    expect(result.approved).toBe(false);
    expect(result.blockReason).toContain('Signal');
  });

  it('approves good signals in healthy conditions', () => {
    const strategies = [
      createStrategy('a', 0.5, 'buy', 0.5),
      createStrategy('b', 0.4, 'buy', 0.4),
    ];
    const signal = createSignal('buy', 0.45, 0.45, strategies);
    const candles = createCandles(Array(50).fill(100));
    const context = createMarketContext({ volatility: 0.03 });
    const portfolio = createPortfolio();

    const result = validateSignal(signal, candles, 49, context, portfolio, config);
    expect(result.approved).toBe(true);
    // Risk score is 1 - confidence = 0.55, which is acceptable for trading
    expect(result.riskScore).toBeLessThan(0.7);
  });

  it('reduces confidence based on risk', () => {
    const strategies = [
      createStrategy('a', 0.5, 'buy', 0.5),
      createStrategy('b', 0.4, 'buy', 0.4),
    ];
    const signal = createSignal('buy', 0.45, 0.45, strategies);

    // Create slightly risky conditions (approaching crash threshold)
    const prices = Array(50).fill(100);
    prices[49] = 96; // -4% (close to -5% threshold)
    const candles = createCandles(prices);

    const context = createMarketContext({ volatility: 0.03 });
    const portfolio = createPortfolio();

    const result = validateSignal(signal, candles, 49, context, portfolio, config);
    expect(result.adjustedConfidence).toBeLessThan(signal.confidence);
  });
});

// ============================================================================
// CONFIG CREATION TESTS
// ============================================================================

describe('createValidatorConfig', () => {
  it('uses defaults when no overrides', () => {
    const config = createValidatorConfig({});
    expect(config.minConfidence).toBe(DEFAULT_VALIDATOR_CONFIG.minConfidence);
  });

  it('merges top-level overrides', () => {
    const config = createValidatorConfig({ minConfidence: 0.5 });
    expect(config.minConfidence).toBe(0.5);
    expect(config.maxVolatility).toBe(DEFAULT_VALIDATOR_CONFIG.maxVolatility);
  });

  it('merges nested crash detection overrides', () => {
    const config = createValidatorConfig({
      crashDetection: { singlePeriodThreshold: -0.10 },
    });
    expect(config.crashDetection.singlePeriodThreshold).toBe(-0.10);
    expect(config.crashDetection.shortTermThreshold).toBe(
      DEFAULT_VALIDATOR_CONFIG.crashDetection.shortTermThreshold
    );
  });
});

// ============================================================================
// EXIT RISK ASSESSMENT TESTS (Fix #4)
// ============================================================================

describe('assessExitRisk', () => {
  const config = DEFAULT_VALIDATOR_CONFIG;

  function createSignal(action: 'buy' | 'sell' | 'hold'): SignalToValidate {
    return {
      action,
      signal: action === 'buy' ? 0.5 : action === 'sell' ? -0.5 : 0,
      confidence: 0.6,
      strategyResults: [],
    };
  }

  function createPosition(overrides: Partial<PositionContext> = {}): PositionContext {
    return {
      hasPosition: true,
      entryPrice: 100,
      currentPrice: 105,
      unrealizedPnL: 0.05, // 5% profit
      positionAge: 5,
      positionSize: 1.0,
      ...overrides,
    };
  }

  it('passes for non-sell signals', () => {
    const result = assessExitRisk(createSignal('buy'), createPosition(), config);
    expect(result.passed).toBe(true);
    expect(result.score).toBe(0);
  });

  it('passes when no position', () => {
    const result = assessExitRisk(createSignal('sell'), { hasPosition: false }, config);
    expect(result.passed).toBe(true);
    expect(result.score).toBe(0);
  });

  it('blocks sell if position too young', () => {
    const youngPosition = createPosition({ positionAge: 1, unrealizedPnL: 0.01 });
    const result = assessExitRisk(createSignal('sell'), youngPosition, config);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('too young');
  });

  it('allows sell of young position if at significant loss', () => {
    const youngLossPosition = createPosition({ positionAge: 1, unrealizedPnL: -0.10 });
    const result = assessExitRisk(createSignal('sell'), youngLossPosition, config);
    expect(result.passed).toBe(true);
    expect(result.reason).toContain('exit allowed');
  });

  it('warns on small take-profit', () => {
    const smallProfitPosition = createPosition({ unrealizedPnL: 0.01 }); // 1% profit
    const result = assessExitRisk(createSignal('sell'), smallProfitPosition, config);
    expect(result.passed).toBe(true); // Passes but with warning
    expect(result.score).toBeGreaterThan(0.3);
    expect(result.reason).toContain('small take-profit');
  });

  it('approves good take-profit with low risk', () => {
    const goodProfitPosition = createPosition({ unrealizedPnL: 0.05 }); // 5% profit
    const result = assessExitRisk(createSignal('sell'), goodProfitPosition, config);
    expect(result.passed).toBe(true);
    expect(result.score).toBeLessThan(0.2);
    expect(result.reason).toContain('good take-profit');
  });

  it('handles hold signal', () => {
    const result = assessExitRisk(createSignal('hold'), createPosition(), config);
    expect(result.passed).toBe(true);
    expect(result.score).toBe(0);
  });
});
