import { describe, it, expect } from 'vitest';
import { buildOpenProposal, type OpenSetupInput } from '@/lib/skills/open-position-business-logic';

function setup(over: Partial<OpenSetupInput> = {}): OpenSetupInput {
  return {
    sessionId: 'sess-1',
    coin: 'eth',
    side: 'buy',
    entryPx: 2000,
    riskUsd: 100,
    stopDistanceFrac: 0.05,
    clientIntentId: 'intent-1',
    now: 1000,
    thesis: 'higher-TF bullish alignment with 1h pullback',
    ...over,
  };
}

describe('buildOpenProposal — risk-based sizing', () => {
  it('sizes so that hitting the stop loses ~riskUsd (long)', () => {
    const p = buildOpenProposal(setup());
    // riskPerCoin = 2000 * 0.05 = 100; sz = 100 / 100 = 1.
    expect(p.intent.sz).toBeCloseTo(1, 6);
    expect(p.dollarRisk).toBeCloseTo(100, 2);
    expect(p.warnings).toHaveLength(0);
  });

  it('places the long stop BELOW entry', () => {
    const p = buildOpenProposal(setup({ side: 'buy', entryPx: 2000, stopDistanceFrac: 0.05 }));
    expect(p.stopPx).toBeCloseTo(1900, 6);
  });

  it('places the short stop ABOVE entry', () => {
    const p = buildOpenProposal(setup({ side: 'sell', entryPx: 2000, stopDistanceFrac: 0.05 }));
    expect(p.stopPx).toBeCloseTo(2100, 6);
  });

  it('never marks an open intent reduce-only and normalizes the coin', () => {
    const p = buildOpenProposal(setup());
    expect(p.intent.reduceOnly).toBe(false);
    expect(p.intent.coin).toBe('ETH');
    expect(p.intent.createdAt).toBe(1000);
    expect(p.intent.clientIntentId).toBe('intent-1');
  });

  it('warns (does not throw) on invalid inputs', () => {
    const p = buildOpenProposal(setup({ entryPx: 0, riskUsd: -5, stopDistanceFrac: 2, thesis: '' }));
    expect(p.warnings.length).toBeGreaterThan(0);
  });

  it('warns when a buy limit is below the entry price', () => {
    const p = buildOpenProposal(setup({ side: 'buy', entryPx: 2000, limitPx: 1900 }));
    expect(p.warnings.some((w) => w.includes('Buy limit'))).toBe(true);
  });

  it('embeds the thesis in the rationale', () => {
    const p = buildOpenProposal(setup({ thesis: 'my thesis' }));
    expect(p.rationale).toContain('my thesis');
    expect(p.rationale).toContain('LONG');
  });
});
