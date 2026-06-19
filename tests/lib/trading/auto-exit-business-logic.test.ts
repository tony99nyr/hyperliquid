/**
 * Pins the PURE auto-exit decision (Layer 1). Each trigger fires; a healthy
 * position does not; EXIT-ONLY (the function only ever says exit/no-exit).
 */

import { describe, it, expect } from 'vitest';
import {
  shouldAutoExit,
  type AutoExitInputs,
  type AutoExitThresholds,
} from '@/lib/trading/auto-exit-business-logic';

const T: AutoExitThresholds = {
  liqProximityPct: 0.025,
  maxLossUsd: 50,
  maxLossPctOfMargin: 0.5,
  minHealthScore: 20,
  hardExitAlerts: ['regime-flip-8h'],
};

// A healthy short, far from liq, in profit, good health, no alerts.
const HEALTHY: AutoExitInputs = {
  coin: 'ETH',
  side: 'short',
  markPx: 1700,
  liquidationPx: 1900, // ~11.8% away
  unrealizedPnlUsd: 5,
  marginUsd: 100,
  healthScore: 70,
  alerts: [],
};

describe('shouldAutoExit', () => {
  it('does NOT exit a healthy position', () => {
    expect(shouldAutoExit(HEALTHY, T)).toEqual({ exit: false, reason: null });
  });

  it('exits on liquidation proximity (within 2.5%)', () => {
    const d = shouldAutoExit({ ...HEALTHY, liquidationPx: 1740 }, T); // ~2.35% away
    expect(d.exit).toBe(true);
    expect(d.reason).toMatch(/liq-proximity/);
  });

  it('does NOT exit when liq is just outside the band', () => {
    expect(shouldAutoExit({ ...HEALTHY, liquidationPx: 1755 }, T).exit).toBe(false); // ~3.2% away
  });

  it('exits on max-loss USD', () => {
    const d = shouldAutoExit({ ...HEALTHY, unrealizedPnlUsd: -60 }, T);
    expect(d.exit).toBe(true);
    expect(d.reason).toMatch(/max-loss-usd/);
  });

  it('exits on max-loss as % of margin', () => {
    // uPnL -$30 on $50 margin = 60% loss ≥ 50%; keep under the $50 USD floor.
    const d = shouldAutoExit({ ...HEALTHY, unrealizedPnlUsd: -30, marginUsd: 50 }, { ...T, maxLossUsd: null });
    expect(d.exit).toBe(true);
    expect(d.reason).toMatch(/max-loss-pct/);
  });

  it('exits when health is below the floor', () => {
    const d = shouldAutoExit({ ...HEALTHY, healthScore: 12 }, T);
    expect(d.exit).toBe(true);
    expect(d.reason).toMatch(/unhealthy/);
  });

  it('exits on a hard adverse alert', () => {
    const d = shouldAutoExit({ ...HEALTHY, alerts: ['regime-flip-8h'] }, T);
    expect(d.exit).toBe(true);
    expect(d.reason).toMatch(/hard-alert/);
  });

  it('ignores a non-hard alert', () => {
    expect(shouldAutoExit({ ...HEALTHY, alerts: ['bearish-divergence-1h'] }, T).exit).toBe(false);
  });

  it('null thresholds disable their triggers (no liq, no health) → no exit', () => {
    const d = shouldAutoExit(
      { ...HEALTHY, liquidationPx: null, healthScore: null, unrealizedPnlUsd: -10 },
      { ...T, maxLossUsd: null, maxLossPctOfMargin: null, minHealthScore: null },
    );
    expect(d.exit).toBe(false);
  });

  it('liq proximity takes priority (reason is liq even if also unhealthy)', () => {
    const d = shouldAutoExit({ ...HEALTHY, liquidationPx: 1730, healthScore: 5 }, T);
    expect(d.reason).toMatch(/liq-proximity/);
  });
});
