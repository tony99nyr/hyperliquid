import { describe, it, expect } from 'vitest';
import {
  evaluateCircuitBreaker,
  rollCircuitBreakerState,
  DEFAULT_CIRCUIT_BREAKER_CONFIG,
  type CircuitBreakerState,
} from '@/lib/risk/circuit-breaker-business-logic';

describe('evaluateCircuitBreaker', () => {
  it('ok when within limits', () => {
    const d = evaluateCircuitBreaker({ equityUsd: 990, dayStartEquityUsd: 1000, peakEquityUsd: 1000 });
    expect(d.blockNewEntries).toBe(false);
    expect(d.tripped).toBeNull();
  });

  it('blocks new entries on a daily-loss trip (≥5%)', () => {
    const d = evaluateCircuitBreaker({ equityUsd: 940, dayStartEquityUsd: 1000, peakEquityUsd: 1000 });
    expect(d.tripped).toBe('daily-loss');
    expect(d.blockNewEntries).toBe(true);
    expect(d.flattenRecommended).toBe(false); // daily loss blocks but doesn't flatten
  });

  it('hard-halts + recommends flatten on a drawdown trip (≥15%)', () => {
    const d = evaluateCircuitBreaker({ equityUsd: 840, dayStartEquityUsd: 845, peakEquityUsd: 1000 });
    expect(d.tripped).toBe('drawdown');
    expect(d.blockNewEntries).toBe(true);
    expect(d.flattenRecommended).toBe(true);
  });

  it('drawdown takes priority over daily-loss in the trip label', () => {
    // down 16% on the day AND 16% from peak → reports drawdown (the more severe)
    const d = evaluateCircuitBreaker({ equityUsd: 840, dayStartEquityUsd: 1000, peakEquityUsd: 1000 });
    expect(d.tripped).toBe('drawdown');
  });

  it('does not flatten on drawdown when flattenOnDrawdownHalt is off', () => {
    const d = evaluateCircuitBreaker({ equityUsd: 800, dayStartEquityUsd: 805, peakEquityUsd: 1000 }, { ...DEFAULT_CIRCUIT_BREAKER_CONFIG, flattenOnDrawdownHalt: false });
    expect(d.blockNewEntries).toBe(true);
    expect(d.flattenRecommended).toBe(false);
  });

  it('handles zero/degenerate equity without NaN', () => {
    const d = evaluateCircuitBreaker({ equityUsd: 0, dayStartEquityUsd: 0, peakEquityUsd: 0 });
    expect(Number.isFinite(d.dailyLossPct)).toBe(true);
    expect(d.blockNewEntries).toBe(false);
  });
});

describe('rollCircuitBreakerState', () => {
  const DAY = 86_400_000;
  it('seeds from the first reading', () => {
    expect(rollCircuitBreakerState(null, 1000, 5 * DAY)).toEqual({ peakEquityUsd: 1000, dayStartEquityUsd: 1000, dayStartAtMs: 5 * DAY });
  });

  it('lifts the peak, holds day-start within the same UTC day', () => {
    const prev: CircuitBreakerState = { peakEquityUsd: 1000, dayStartEquityUsd: 1000, dayStartAtMs: 5 * DAY };
    const next = rollCircuitBreakerState(prev, 1050, 5 * DAY + 3_600_000); // same day, +1h
    expect(next.peakEquityUsd).toBe(1050);
    expect(next.dayStartEquityUsd).toBe(1000); // unchanged within the day
  });

  it('re-anchors day-start equity at the first reading of a new UTC day', () => {
    const prev: CircuitBreakerState = { peakEquityUsd: 1050, dayStartEquityUsd: 1000, dayStartAtMs: 5 * DAY };
    const next = rollCircuitBreakerState(prev, 1030, 6 * DAY + 1000); // next day
    expect(next.dayStartEquityUsd).toBe(1030); // re-anchored to the new day's open
    expect(next.peakEquityUsd).toBe(1050); // peak persists across days
  });
});
