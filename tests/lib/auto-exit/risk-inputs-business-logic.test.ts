import { describe, it, expect } from 'vitest';
import {
  computeUnrealizedPnlUsd,
  buildAutoExitInputs,
  resolveThresholds,
  type AutoExitConfig,
} from '@/lib/auto-exit/risk-inputs-business-logic';
import type { Position } from '@/types/position';
import type { HlPosition } from '@/lib/hyperliquid/hyperliquid-info-service';

const longPos: Position = {
  coin: 'ETH',
  side: 'long',
  sz: 2,
  avgEntryPx: 1000,
  realizedPnlUsd: 0,
  feesPaidUsd: 0,
};
const shortPos: Position = { ...longPos, side: 'short' };

const CONFIG: AutoExitConfig = {
  liqProximityPct: 0.03,
  maxLossUsd: 40,
  maxLossPctOfMargin: 0.6,
  minHealthScore: 15,
  hardExitAlerts: ['regime-flip-8h'],
  lockTtlMs: 120_000,
};

describe('computeUnrealizedPnlUsd', () => {
  it('long profits when mark rises', () => {
    expect(computeUnrealizedPnlUsd(longPos, 1100)).toBe(200); // (1100-1000)*2
  });
  it('long loses when mark falls', () => {
    expect(computeUnrealizedPnlUsd(longPos, 950)).toBe(-100);
  });
  it('short profits when mark falls', () => {
    expect(computeUnrealizedPnlUsd(shortPos, 900)).toBe(200); // (900-1000)*2*-1
  });
  it('flat is zero', () => {
    expect(computeUnrealizedPnlUsd({ ...longPos, side: 'flat' }, 1234)).toBe(0);
  });
});

describe('buildAutoExitInputs', () => {
  it('computes uPnL from the position when clearinghouse is absent (NaN margin, null liq)', () => {
    const inp = buildAutoExitInputs({ position: longPos, markPx: 950, healthScore: 50, alerts: ['x'] });
    expect(inp.unrealizedPnlUsd).toBe(-100);
    expect(inp.liquidationPx).toBeNull();
    expect(Number.isNaN(inp.marginUsd)).toBe(true);
    expect(inp.side).toBe('long');
    expect(inp.healthScore).toBe(50);
    expect(inp.alerts).toEqual(['x']);
  });

  it('prefers clearinghouse uPnL / liq / margin when present', () => {
    const hl: HlPosition = {
      coin: 'ETH', side: 'long', szi: 2, size: 2, entryPx: 1000, positionValue: 2000,
      unrealizedPnl: -123, returnOnEquity: -0.1, leverage: 5, leverageType: 'cross',
      liquidationPx: 880, marginUsed: 400, maxLeverage: 50,
    };
    const inp = buildAutoExitInputs({ position: longPos, markPx: 950, hlPosition: hl, healthScore: 30 });
    expect(inp.unrealizedPnlUsd).toBe(-123); // clearinghouse, not the -100 computed
    expect(inp.liquidationPx).toBe(880);
    expect(inp.marginUsd).toBe(400);
  });

  it('falls back to computed uPnL when clearinghouse uPnL is non-finite', () => {
    const hl = { coin: 'ETH', szi: 2, size: 2, entryPx: 1000, positionValue: 2000,
      unrealizedPnl: Number.NaN, returnOnEquity: null, leverage: 5, leverageType: 'cross',
      liquidationPx: 880, marginUsed: 400, maxLeverage: 50 } as HlPosition;
    const inp = buildAutoExitInputs({ position: longPos, markPx: 950, hlPosition: hl });
    expect(inp.unrealizedPnlUsd).toBe(-100);
  });
});

describe('resolveThresholds', () => {
  it('keeps all triggers with clearinghouse data', () => {
    const t = resolveThresholds(CONFIG, true);
    expect(t.liqProximityPct).toBe(0.03);
    expect(t.maxLossPctOfMargin).toBe(0.6);
    expect(t.maxLossUsd).toBe(40);
    expect(t.minHealthScore).toBe(15);
  });
  it('disables liq + margin-pct triggers without clearinghouse data', () => {
    const t = resolveThresholds(CONFIG, false);
    expect(t.liqProximityPct).toBe(0); // disabled (no liq px)
    expect(t.maxLossPctOfMargin).toBeNull(); // disabled (no margin)
    expect(t.maxLossUsd).toBe(40); // still active (computable)
    expect(t.minHealthScore).toBe(15); // still active
  });
});
