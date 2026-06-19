/**
 * Pins the PURE auto-exit decision (Layer 1). Each trigger fires; a healthy
 * position does not; EXIT-ONLY (the function only ever says exit/no-exit); and
 * — critically — bad/missing data never SILENTLY disables every trigger.
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

// A healthy short, far from liq (liq ABOVE mark = the loss side for a short), in
// profit, good health, no alerts.
const HEALTHY: AutoExitInputs = {
  coin: 'ETH',
  side: 'short',
  markPx: 1700,
  liquidationPx: 1900, // ~11.8% away, above the mark
  unrealizedPnlUsd: 5,
  marginUsd: 100,
  healthScore: 70,
  alerts: [],
};

describe('shouldAutoExit', () => {
  it('does NOT exit a healthy position', () => {
    expect(shouldAutoExit(HEALTHY, T)).toEqual({ exit: false, reason: null });
  });

  it('exits on liquidation proximity (within 2.5%, loss side)', () => {
    const d = shouldAutoExit({ ...HEALTHY, liquidationPx: 1740 }, T); // ~2.35% above
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
    // uPnL -$30 on $50 margin = 60% loss ≥ 50%; disable the $ floor to isolate.
    const d = shouldAutoExit({ ...HEALTHY, unrealizedPnlUsd: -30, marginUsd: 50 }, { ...T, maxLossUsd: null });
    expect(d.exit).toBe(true);
    expect(d.reason).toMatch(/max-loss-pct/);
  });

  it('exits when margin is fully eroded while losing', () => {
    const d = shouldAutoExit({ ...HEALTHY, unrealizedPnlUsd: -5, marginUsd: 0 }, { ...T, maxLossUsd: null });
    expect(d.exit).toBe(true);
    expect(d.reason).toMatch(/margin-eroded/);
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

  // --- Side-awareness: a bogus liq on the PROFITABLE side must not close a winner ---

  it('exits a LONG when liq is below the mark within the band', () => {
    const d = shouldAutoExit({ ...HEALTHY, side: 'long', markPx: 1700, liquidationPx: 1680 }, T); // ~1.2% below
    expect(d.exit).toBe(true);
    expect(d.reason).toMatch(/liq-proximity/);
  });

  it('does NOT close a LONG on a bogus liq sitting ABOVE the mark (profitable side)', () => {
    const d = shouldAutoExit({ ...HEALTHY, side: 'long', markPx: 1700, liquidationPx: 1705 }, T);
    expect(d.exit).toBe(false);
  });

  it('does NOT close a SHORT on a bogus liq sitting BELOW the mark (profitable side)', () => {
    const d = shouldAutoExit({ ...HEALTHY, side: 'short', markPx: 1700, liquidationPx: 1695 }, T);
    expect(d.exit).toBe(false);
  });

  // --- Fail-safe: bad data flags dataDegraded, never silently disables everything ---

  it('flags dataDegraded on a non-finite mark and does not silently no-op', () => {
    const d = shouldAutoExit({ ...HEALTHY, markPx: Number.NaN, unrealizedPnlUsd: 5 }, T);
    expect(d.exit).toBe(false);
    expect(d.dataDegraded).toBe(true);
  });

  it('still evaluates health when the mark is bad (NaN does not poison the health trigger)', () => {
    const d = shouldAutoExit({ ...HEALTHY, markPx: Number.NaN, healthScore: 5 }, T);
    expect(d.exit).toBe(true);
    expect(d.reason).toMatch(/unhealthy/);
  });

  it('flags dataDegraded on a NaN P&L (loss trigger cannot evaluate)', () => {
    const d = shouldAutoExit({ ...HEALTHY, unrealizedPnlUsd: Number.NaN }, T);
    expect(d.dataDegraded).toBe(true);
  });

  it('liqProximityPct ≤ 0 disables the liq trigger (no false exit, no degraded)', () => {
    const d = shouldAutoExit({ ...HEALTHY, liquidationPx: 1700.01 }, { ...T, liqProximityPct: 0 });
    expect(d.exit).toBe(false);
    expect(d.dataDegraded).toBeUndefined();
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
