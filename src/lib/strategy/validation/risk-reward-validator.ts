/**
 * Risk/Reward Validator
 *
 * Centralized validation of trading signals against risk factors.
 * All functions are pure - no side effects, easy to test.
 *
 * Flow:
 * 1. Signal Generation Layer produces raw signals
 * 2. Risk/Reward Validator evaluates signal against all risk factors
 * 3. Trade Execution Layer acts on validated signals
 */

import type { PriceCandle } from '@/types';

// ============================================================================
// TYPES
// ============================================================================

/**
 * Market context for risk assessment
 */
export interface MarketContext {
  currentPrice: number;
  volatility: number; // Recent price volatility (std dev / mean)
  adx: number; // Average Directional Index (trend strength)
  regime: 'bullish' | 'bearish' | 'neutral';
  regimeConfidence: number;
}

/**
 * Price movement analysis over different timeframes
 */
export interface PriceMovement {
  singlePeriodChange: number; // Last candle change
  shortTermChange: number; // ~10 periods
  mediumTermChange: number; // ~20 periods
}

/**
 * Individual strategy signal result
 */
export interface StrategySignalInput {
  name: string;
  signal: number; // -1 to 1
  confidence: number; // 0 to 1
  action: 'buy' | 'sell' | 'hold';
  isActive: boolean;
  guardPassed: boolean;
}

/**
 * Aggregated signal to validate
 */
export interface SignalToValidate {
  action: 'buy' | 'sell' | 'hold';
  signal: number;
  confidence: number;
  strategyResults: StrategySignalInput[];
}

/**
 * Portfolio state for risk assessment
 */
export interface PortfolioState {
  currentDrawdown: number; // Current drawdown from peak (0-1)
  recentWinRate: number; // Win rate of recent trades (0-1)
  consecutiveLosses: number; // Number of consecutive losing trades
  periodsSinceLastTrade: number; // Candles since last trade
}

/**
 * Position context for exit validation (Fix #4 & #5)
 * Without this context, we can't make position-aware decisions.
 */
export interface PositionContext {
  hasPosition: boolean;
  positionType?: 'long' | 'short'; // For future short support
  entryPrice?: number;
  currentPrice?: number;
  unrealizedPnL?: number; // As percentage of entry (e.g., 0.05 = 5% profit)
  positionAge?: number; // Periods held
  positionSize?: number; // ETH amount
  distanceToStopLoss?: number; // Percentage distance to stop loss
}

/**
 * Configuration for the validator
 */
export interface RiskValidatorConfig {
  // Market risk thresholds
  crashDetection: {
    singlePeriodThreshold: number; // e.g., -0.05 (-5%)
    shortTermThreshold: number; // e.g., -0.10 (-10%)
    mediumTermThreshold: number; // e.g., -0.15 (-15%)
    recoveryPeriods: number; // Periods to wait after crash
  };
  maxVolatility: number; // Maximum allowed volatility
  minVolatility: number; // Minimum volatility (avoid flat markets)

  // Signal quality thresholds
  minConfidence: number; // Minimum confidence to trade
  minActiveStrategies: number; // Minimum strategies that must pass guards
  maxConflictRatio: number; // Maximum disagreement between strategies
  singleStrategyMinConfidence: number; // Higher confidence needed if only 1 strategy

  // Portfolio risk thresholds
  maxDrawdown: number; // Maximum drawdown before blocking
  minWinRate: number; // Minimum recent win rate
  maxConsecutiveLosses: number; // Maximum consecutive losses

  // Trend alignment (counter-trend protection)
  trendAlignment?: {
    minRegimeConfidence: number; // Minimum regime confidence to block counter-trend (default: 0.25)
  };

  // Momentum exhaustion (avoid chasing)
  momentumExhaustion?: {
    threshold: number; // Price change % to consider exhausted (default: 0.06 = 6%)
  };

  // Exit validation thresholds (Fix #4)
  exitValidation?: {
    minProfitToTakeProfit: number; // Minimum unrealized profit before allowing take-profit (default: 0.02 = 2%)
    maxLossToHold: number; // Maximum unrealized loss before suggesting exit (default: -0.05 = -5%)
    minPositionAgeToSell: number; // Minimum periods to hold before selling (default: 2)
    warnOnPartialProfit: boolean; // Warn when selling at small profit (default: true)
  };
}

/**
 * Individual risk assessment result
 */
export interface RiskAssessment {
  passed: boolean;
  score: number; // 0-1, higher = more risk
  reason?: string;
}

/**
 * Complete validation result
 */
export interface ValidationResult {
  approved: boolean;
  adjustedConfidence: number;
  riskScore: number; // 0-1, aggregate risk
  blockReason?: string;
  assessments: {
    marketRisk: RiskAssessment;
    signalQuality: RiskAssessment;
    portfolioRisk: RiskAssessment;
    conflictRisk: RiskAssessment;
    trendAlignment: RiskAssessment;
    momentumExhaustion: RiskAssessment;
    exitRisk: RiskAssessment; // Fix #4: Exit validation
  };
}

// ============================================================================
// DEFAULT CONFIGURATION
// ============================================================================

/**
 * v15.0 DEFAULT CONFIG
 *
 * Key changes from previous version:
 * - minConfidence: 0.40 → 0.30 (allow moderate confidence signals)
 * - singleStrategyMinConfidence: 0.55 → 0.45 (less conservative when 1 strategy)
 * - momentumExhaustion threshold: 6% → 12% (crypto rallies can extend further)
 * - trendAlignment: 0.25 → 0.50 (only block strong counter-trend)
 * - maxConflictRatio: 0.4 → 0.5 (allow more disagreement between strategies)
 *
 * Rationale: v14 was too conservative, blocking signals in bull markets.
 * Historical 2025 data showed strong outperformance, but synthetic data
 * showed under-performance due to over-blocking.
 */
export const DEFAULT_VALIDATOR_CONFIG: RiskValidatorConfig = {
  crashDetection: {
    singlePeriodThreshold: -0.05,
    shortTermThreshold: -0.10,
    mediumTermThreshold: -0.15,
    recoveryPeriods: 5,
  },
  maxVolatility: 0.10, // v15: 0.08 → 0.10 (more tolerant of volatility)
  minVolatility: 0.001, // 0.1% - lowered for synthetic data compatibility

  minConfidence: 0.30, // v15: 0.40 → 0.30 (allow moderate confidence signals)
  minActiveStrategies: 1,
  maxConflictRatio: 0.5, // v15: 0.4 → 0.5 (allow more disagreement)
  singleStrategyMinConfidence: 0.45, // v15: 0.55 → 0.45 (less restrictive)

  maxDrawdown: 0.25,
  minWinRate: 0.15, // v15: 0.20 → 0.15 (allow trading through losing streaks)
  maxConsecutiveLosses: 6, // v15: 5 → 6 (slightly more tolerant)

  trendAlignment: {
    minRegimeConfidence: 0.50, // v15: 0.25 → 0.50 (only block STRONG counter-trend)
  },

  momentumExhaustion: {
    threshold: 0.12, // v15: 0.06 → 0.12 (crypto can rally 12%+ and continue)
  },

  exitValidation: {
    minProfitToTakeProfit: 0.02, // Need at least 2% profit for take-profit
    maxLossToHold: -0.08, // Exit suggested if loss exceeds 8%
    minPositionAgeToSell: 2, // Hold at least 2 periods before selling
    warnOnPartialProfit: true, // Warn when selling at < 2% profit
  },
};

// ============================================================================
// PURE FUNCTIONS - MARKET RISK
// ============================================================================

/**
 * Calculate price movements over different timeframes
 * CRITICAL: Checks for timestamp gaps to avoid false crash detection on sparse data
 */
export function calculatePriceMovement(
  candles: PriceCandle[],
  currentIndex: number
): PriceMovement {
  const currentCandle = candles[currentIndex];
  const currentPrice = currentCandle?.close ?? 0;
  const currentTimestamp = currentCandle?.timestamp ?? 0;

  // Guard: If current price is invalid, return zero movements (no crash detection)
  if (currentPrice <= 0 || !Number.isFinite(currentPrice)) {
    return { singlePeriodChange: 0, shortTermChange: 0, mediumTermChange: 0 };
  }

  // 8h candles = 8 * 60 * 60 * 1000 = 28800000ms
  // Allow 2x expected gap as tolerance
  const maxSingleGapMs = 2 * 8 * 60 * 60 * 1000; // 16 hours for single period

  let singlePeriodChange = 0;
  if (currentIndex >= 1) {
    const prevCandle = candles[currentIndex - 1];
    const prevPrice = prevCandle?.close ?? currentPrice;
    const prevTimestamp = prevCandle?.timestamp ?? 0;
    const timestampGap = currentTimestamp - prevTimestamp;

    // Only calculate if gap is reasonable (not a data gap) and price is valid
    if (timestampGap <= maxSingleGapMs && prevPrice > 0 && Number.isFinite(prevPrice)) {
      singlePeriodChange = (currentPrice - prevPrice) / prevPrice;
    }
    // If gap too large or price invalid, leave as 0 (no crash detection for this candle)
  }

  let shortTermChange = 0;
  if (currentIndex >= 10) {
    const pastCandle = candles[currentIndex - 10];
    const price10Ago = pastCandle?.close ?? currentPrice;
    const pastTimestamp = pastCandle?.timestamp ?? 0;
    const timestampGap = currentTimestamp - pastTimestamp;
    const expectedGapMs = 10 * 8 * 60 * 60 * 1000; // ~80 hours

    // Only calculate if gap is within 2x expected and price is valid
    if (timestampGap <= 2 * expectedGapMs && price10Ago > 0 && Number.isFinite(price10Ago)) {
      shortTermChange = (currentPrice - price10Ago) / price10Ago;
    }
  }

  let mediumTermChange = 0;
  if (currentIndex >= 20) {
    const pastCandle = candles[currentIndex - 20];
    const price20Ago = pastCandle?.close ?? currentPrice;
    const pastTimestamp = pastCandle?.timestamp ?? 0;
    const timestampGap = currentTimestamp - pastTimestamp;
    const expectedGapMs = 20 * 8 * 60 * 60 * 1000; // ~160 hours

    // Only calculate if gap is within 2x expected and price is valid
    if (timestampGap <= 2 * expectedGapMs && price20Ago > 0 && Number.isFinite(price20Ago)) {
      mediumTermChange = (currentPrice - price20Ago) / price20Ago;
    }
  }

  return { singlePeriodChange, shortTermChange, mediumTermChange };
}

/**
 * Detect if market is in crash state
 */
export function detectCrash(
  priceMovement: PriceMovement,
  config: RiskValidatorConfig['crashDetection']
): { inCrash: boolean; severity: 'none' | 'single' | 'short' | 'medium'; change: number } {
  if (priceMovement.singlePeriodChange < config.singlePeriodThreshold) {
    return { inCrash: true, severity: 'single', change: priceMovement.singlePeriodChange };
  }
  if (priceMovement.shortTermChange < config.shortTermThreshold) {
    return { inCrash: true, severity: 'short', change: priceMovement.shortTermChange };
  }
  if (priceMovement.mediumTermChange < config.mediumTermThreshold) {
    return { inCrash: true, severity: 'medium', change: priceMovement.mediumTermChange };
  }
  return { inCrash: false, severity: 'none', change: 0 };
}

/**
 * Assess market risk based on price movements and volatility
 */
export function assessMarketRisk(
  priceMovement: PriceMovement,
  marketContext: MarketContext,
  config: RiskValidatorConfig
): RiskAssessment {
  // Check for crash
  const crash = detectCrash(priceMovement, config.crashDetection);
  if (crash.inCrash) {
    return {
      passed: false,
      score: 1.0,
      reason: `${crash.severity}-term crash: ${(crash.change * 100).toFixed(1)}%`,
    };
  }

  // Check volatility bounds
  if (marketContext.volatility > config.maxVolatility) {
    return {
      passed: false,
      score: 0.8,
      reason: `volatility too high: ${(marketContext.volatility * 100).toFixed(1)}% > ${(config.maxVolatility * 100).toFixed(1)}%`,
    };
  }

  if (marketContext.volatility < config.minVolatility) {
    return {
      passed: false,
      score: 0.3,
      reason: `volatility too low: ${(marketContext.volatility * 100).toFixed(1)}% < ${(config.minVolatility * 100).toFixed(1)}%`,
    };
  }

  // Calculate risk score based on how close we are to thresholds
  const crashProximity = Math.max(
    priceMovement.singlePeriodChange / config.crashDetection.singlePeriodThreshold,
    priceMovement.shortTermChange / config.crashDetection.shortTermThreshold,
    priceMovement.mediumTermChange / config.crashDetection.mediumTermThreshold
  );
  const riskScore = Math.min(1, Math.max(0, crashProximity * 0.5));

  return { passed: true, score: riskScore };
}

// ============================================================================
// PURE FUNCTIONS - SIGNAL QUALITY
// ============================================================================

/**
 * Count strategies by their signal direction
 */
export function countStrategyDirections(
  strategies: StrategySignalInput[]
): { buy: number; sell: number; hold: number; active: number } {
  const active = strategies.filter(s => s.isActive && s.guardPassed);
  return {
    buy: active.filter(s => s.action === 'buy').length,
    sell: active.filter(s => s.action === 'sell').length,
    hold: active.filter(s => s.action === 'hold').length,
    active: active.length,
  };
}

/**
 * Calculate conflict ratio between strategies
 * Higher ratio = more disagreement
 */
export function calculateConflictRatio(strategies: StrategySignalInput[]): number {
  const counts = countStrategyDirections(strategies);
  if (counts.active < 2) return 0;

  // Conflict is when we have both buy and sell signals
  const minDirectional = Math.min(counts.buy, counts.sell);
  return minDirectional / counts.active;
}

/**
 * Check for warning signals from blocked strategies
 * Returns the strongest opposing signal value
 */
export function findBlockedWarnings(
  signal: SignalToValidate,
  strategies: StrategySignalInput[]
): { hasWarning: boolean; warningStrength: number; warningSource?: string } {
  const blocked = strategies.filter(s => s.isActive && !s.guardPassed);

  for (const s of blocked) {
    // If we're buying but a blocked strategy is negative
    if (signal.action === 'buy' && s.signal < -0.05) {
      return {
        hasWarning: true,
        warningStrength: Math.abs(s.signal),
        warningSource: s.name,
      };
    }
    // If we're selling but a blocked strategy is positive
    if (signal.action === 'sell' && s.signal > 0.05) {
      return {
        hasWarning: true,
        warningStrength: s.signal,
        warningSource: s.name,
      };
    }
  }

  return { hasWarning: false, warningStrength: 0 };
}

/**
 * Assess signal quality based on confidence and strategy consensus
 */
export function assessSignalQuality(
  signal: SignalToValidate,
  config: RiskValidatorConfig
): RiskAssessment {
  if (signal.action === 'hold') {
    return { passed: true, score: 0 };
  }

  const counts = countStrategyDirections(signal.strategyResults);

  // Check minimum active strategies
  if (counts.active < config.minActiveStrategies) {
    return {
      passed: false,
      score: 0.7,
      reason: `insufficient active strategies: ${counts.active} < ${config.minActiveStrategies}`,
    };
  }

  // Check confidence threshold
  const requiredConfidence = counts.active === 1
    ? config.singleStrategyMinConfidence
    : config.minConfidence;

  if (signal.confidence < requiredConfidence) {
    return {
      passed: false,
      score: 0.5,
      reason: `confidence too low: ${(signal.confidence * 100).toFixed(0)}% < ${(requiredConfidence * 100).toFixed(0)}%`,
    };
  }

  // Calculate quality score (higher confidence = lower risk)
  const riskScore = 1 - signal.confidence;

  return { passed: true, score: riskScore };
}

/**
 * Assess conflict risk from disagreeing strategies
 */
export function assessConflictRisk(
  signal: SignalToValidate,
  config: RiskValidatorConfig
): RiskAssessment {
  if (signal.action === 'hold') {
    return { passed: true, score: 0 };
  }

  const conflictRatio = calculateConflictRatio(signal.strategyResults);

  if (conflictRatio > config.maxConflictRatio) {
    return {
      passed: false,
      score: conflictRatio,
      reason: `high strategy conflict: ${(conflictRatio * 100).toFixed(0)}% disagreement`,
    };
  }

  // Check for warnings from blocked strategies
  const warning = findBlockedWarnings(signal, signal.strategyResults);
  if (warning.hasWarning && warning.warningStrength > 0.15) {
    return {
      passed: false,
      score: warning.warningStrength,
      reason: `${warning.warningSource} warns against ${signal.action}: signal=${(-warning.warningStrength).toFixed(2)}`,
    };
  }

  return { passed: true, score: conflictRatio };
}

// ============================================================================
// PURE FUNCTIONS - TREND ALIGNMENT
// ============================================================================

/**
 * Assess trend alignment - block counter-trend signals in strong regimes
 *
 * Key insight from analysis: Selling in bullish regimes loses badly.
 * This function blocks counter-trend signals when the regime is confident.
 */
export function assessTrendAlignment(
  signal: SignalToValidate,
  marketContext: MarketContext,
  config: RiskValidatorConfig
): RiskAssessment {
  if (signal.action === 'hold') {
    return { passed: true, score: 0 };
  }

  const { regime, regimeConfidence } = marketContext;
  const minRegimeConfidenceToBlock = config.trendAlignment?.minRegimeConfidence ?? 0.25;

  // Check for counter-trend signals
  if (signal.action === 'sell' && regime === 'bullish' && regimeConfidence >= minRegimeConfidenceToBlock) {
    return {
      passed: false,
      score: regimeConfidence,
      reason: `counter-trend: selling in bullish regime (${(regimeConfidence * 100).toFixed(0)}% confidence)`,
    };
  }

  if (signal.action === 'buy' && regime === 'bearish' && regimeConfidence >= minRegimeConfidenceToBlock) {
    return {
      passed: false,
      score: regimeConfidence,
      reason: `counter-trend: buying in bearish regime (${(regimeConfidence * 100).toFixed(0)}% confidence)`,
    };
  }

  // Reward trend-aligned signals with lower risk score
  const isTrendAligned =
    (signal.action === 'buy' && regime === 'bullish') ||
    (signal.action === 'sell' && regime === 'bearish');

  if (isTrendAligned) {
    return { passed: true, score: 0.1 }; // Low risk for aligned signals
  }

  // Neutral regime - moderate risk
  return { passed: true, score: 0.3 };
}

// ============================================================================
// PURE FUNCTIONS - MOMENTUM EXHAUSTION
// ============================================================================

/**
 * Assess momentum exhaustion - avoid chasing extended moves
 *
 * Key insight: Buying after a big rally or selling after a big drop
 * often leads to mean reversion against your position.
 */
export function assessMomentumExhaustion(
  signal: SignalToValidate,
  priceMovement: PriceMovement,
  config: RiskValidatorConfig
): RiskAssessment {
  if (signal.action === 'hold') {
    return { passed: true, score: 0 };
  }

  const exhaustionThreshold = config.momentumExhaustion?.threshold ?? 0.06; // 6% move

  // Don't buy after big rally (price already up significantly)
  if (signal.action === 'buy' && priceMovement.shortTermChange > exhaustionThreshold) {
    return {
      passed: false,
      score: 0.7,
      reason: `momentum exhausted: price up ${(priceMovement.shortTermChange * 100).toFixed(1)}% in 10 periods`,
    };
  }

  // Don't sell after big drop (price already down significantly)
  if (signal.action === 'sell' && priceMovement.shortTermChange < -exhaustionThreshold) {
    return {
      passed: false,
      score: 0.7,
      reason: `momentum exhausted: price down ${(priceMovement.shortTermChange * 100).toFixed(1)}% in 10 periods`,
    };
  }

  return { passed: true, score: 0 };
}

// ============================================================================
// PURE FUNCTIONS - EXIT VALIDATION (Fix #4)
// ============================================================================

/**
 * Assess exit risk - validate sell signals against position state
 *
 * Key insight from architecture review: Entry signals are validated but
 * exit signals are not. Bad exits can turn winning trades into losers.
 *
 * This function validates:
 * - Don't sell too early (minimum position age)
 * - Don't take profit too small (minimum profit threshold)
 * - Do exit if loss is too large (stop loss override)
 * - Warn on selling at marginal profit
 */
export function assessExitRisk(
  signal: SignalToValidate,
  position: PositionContext,
  config: RiskValidatorConfig
): RiskAssessment {
  // Only applies to sell signals when we have a position
  if (signal.action !== 'sell' || !position.hasPosition) {
    return { passed: true, score: 0 };
  }

  const exitConfig = config.exitValidation ?? {
    minProfitToTakeProfit: 0.02,
    maxLossToHold: -0.08,
    minPositionAgeToSell: 2,
    warnOnPartialProfit: true,
  };

  const unrealizedPnL = position.unrealizedPnL ?? 0;
  const positionAge = position.positionAge ?? 0;

  // Check if position is too new to sell (unless at significant loss)
  if (positionAge < exitConfig.minPositionAgeToSell && unrealizedPnL > exitConfig.maxLossToHold) {
    return {
      passed: false,
      score: 0.4,
      reason: `position too young: ${positionAge} periods (min: ${exitConfig.minPositionAgeToSell})`,
    };
  }

  // If at significant loss, allow exit regardless (stop loss override)
  if (unrealizedPnL <= exitConfig.maxLossToHold) {
    return {
      passed: true,
      score: 0.3, // Still risky but allowed
      reason: `exit allowed: significant loss ${(unrealizedPnL * 100).toFixed(1)}%`,
    };
  }

  // Warn if taking very small profit (not blocking, just scoring)
  if (exitConfig.warnOnPartialProfit &&
      unrealizedPnL > 0 &&
      unrealizedPnL < exitConfig.minProfitToTakeProfit) {
    return {
      passed: true, // Allow but warn
      score: 0.5,
      reason: `small take-profit: ${(unrealizedPnL * 100).toFixed(1)}% < ${(exitConfig.minProfitToTakeProfit * 100).toFixed(0)}% threshold`,
    };
  }

  // Good exit - reasonable profit or loss within bounds
  if (unrealizedPnL >= exitConfig.minProfitToTakeProfit) {
    return {
      passed: true,
      score: 0.1, // Low risk exit
      reason: `good take-profit: ${(unrealizedPnL * 100).toFixed(1)}%`,
    };
  }

  return { passed: true, score: 0.2 };
}

// ============================================================================
// PURE FUNCTIONS - PORTFOLIO RISK
// ============================================================================

/**
 * Assess portfolio risk based on current state
 */
export function assessPortfolioRisk(
  portfolio: PortfolioState,
  config: RiskValidatorConfig
): RiskAssessment {
  // Check drawdown
  if (portfolio.currentDrawdown > config.maxDrawdown) {
    return {
      passed: false,
      score: 1.0,
      reason: `drawdown too high: ${(portfolio.currentDrawdown * 100).toFixed(0)}% > ${(config.maxDrawdown * 100).toFixed(0)}%`,
    };
  }

  // Check consecutive losses
  if (portfolio.consecutiveLosses >= config.maxConsecutiveLosses) {
    return {
      passed: false,
      score: 0.9,
      reason: `${portfolio.consecutiveLosses} consecutive losses (max: ${config.maxConsecutiveLosses})`,
    };
  }

  // Check win rate (only if we have enough trades)
  if (portfolio.recentWinRate < config.minWinRate && portfolio.periodsSinceLastTrade < 100) {
    // Don't block, but increase risk score
    const riskScore = (config.minWinRate - portfolio.recentWinRate) / config.minWinRate;
    return {
      passed: true,
      score: Math.min(0.7, riskScore),
      reason: `low win rate: ${(portfolio.recentWinRate * 100).toFixed(0)}%`,
    };
  }

  // Calculate risk score based on drawdown proximity
  const drawdownRisk = portfolio.currentDrawdown / config.maxDrawdown;
  const lossRisk = portfolio.consecutiveLosses / config.maxConsecutiveLosses;
  const riskScore = Math.max(drawdownRisk, lossRisk) * 0.5;

  return { passed: true, score: riskScore };
}

// ============================================================================
// MAIN VALIDATOR
// ============================================================================

/**
 * Validate a trading signal against all risk factors
 *
 * This is the main entry point. It composes all assessment functions
 * and returns a comprehensive validation result.
 *
 * @param position - Optional position context for exit validation (Fix #4 & #5)
 */
export function validateSignal(
  signal: SignalToValidate,
  candles: PriceCandle[],
  currentIndex: number,
  marketContext: MarketContext,
  portfolio: PortfolioState,
  config: RiskValidatorConfig = DEFAULT_VALIDATOR_CONFIG,
  position: PositionContext = { hasPosition: false }
): ValidationResult {
  // If it's a hold signal, always approve with no risk
  if (signal.action === 'hold') {
    return {
      approved: true,
      adjustedConfidence: signal.confidence,
      riskScore: 0,
      assessments: {
        marketRisk: { passed: true, score: 0 },
        signalQuality: { passed: true, score: 0 },
        portfolioRisk: { passed: true, score: 0 },
        conflictRisk: { passed: true, score: 0 },
        trendAlignment: { passed: true, score: 0 },
        momentumExhaustion: { passed: true, score: 0 },
        exitRisk: { passed: true, score: 0 },
      },
    };
  }

  // Calculate price movements
  const priceMovement = calculatePriceMovement(candles, currentIndex);

  // Run all assessments
  const marketRisk = assessMarketRisk(priceMovement, marketContext, config);
  const signalQuality = assessSignalQuality(signal, config);
  const portfolioRisk = assessPortfolioRisk(portfolio, config);
  const conflictRisk = assessConflictRisk(signal, config);
  const trendAlignment = assessTrendAlignment(signal, marketContext, config);
  const momentumExhaustion = assessMomentumExhaustion(signal, priceMovement, config);
  const exitRisk = assessExitRisk(signal, position, config); // Fix #4: Exit validation

  // Determine if approved (all must pass)
  const allPassed = marketRisk.passed && signalQuality.passed && portfolioRisk.passed &&
                    conflictRisk.passed && trendAlignment.passed && momentumExhaustion.passed &&
                    exitRisk.passed;

  // Find the blocking reason if any
  let blockReason: string | undefined;
  if (!marketRisk.passed) blockReason = `Market: ${marketRisk.reason}`;
  else if (!signalQuality.passed) blockReason = `Signal: ${signalQuality.reason}`;
  else if (!portfolioRisk.passed) blockReason = `Portfolio: ${portfolioRisk.reason}`;
  else if (!conflictRisk.passed) blockReason = `Conflict: ${conflictRisk.reason}`;
  else if (!trendAlignment.passed) blockReason = `Trend: ${trendAlignment.reason}`;
  else if (!momentumExhaustion.passed) blockReason = `Momentum: ${momentumExhaustion.reason}`;
  else if (!exitRisk.passed) blockReason = `Exit: ${exitRisk.reason}`;

  // Calculate aggregate risk score
  const riskScore = Math.max(
    marketRisk.score,
    signalQuality.score,
    portfolioRisk.score,
    conflictRisk.score,
    trendAlignment.score,
    momentumExhaustion.score,
    exitRisk.score
  );

  // Adjust confidence based on risk
  const adjustedConfidence = signal.confidence * (1 - riskScore * 0.3);

  return {
    approved: allPassed,
    adjustedConfidence,
    riskScore,
    blockReason,
    assessments: {
      marketRisk,
      signalQuality,
      portfolioRisk,
      conflictRisk,
      trendAlignment,
      momentumExhaustion,
      exitRisk,
    },
  };
}

/**
 * Deep partial type for nested config objects
 */
type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

/**
 * Create a validator config from an asset-specific configuration
 */
export function createValidatorConfig(
  overrides: DeepPartial<RiskValidatorConfig>
): RiskValidatorConfig {
  return {
    ...DEFAULT_VALIDATOR_CONFIG,
    ...overrides,
    crashDetection: {
      ...DEFAULT_VALIDATOR_CONFIG.crashDetection,
      ...overrides.crashDetection,
    },
  };
}
