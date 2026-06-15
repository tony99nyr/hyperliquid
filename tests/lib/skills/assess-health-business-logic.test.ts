import { describe, it, expect } from 'vitest';
import { recommendFromHealth } from '@/lib/skills/assess-health-business-logic';
import type { HealthResult } from '@/lib/health/health-engine-types';

function health(over: Partial<HealthResult> = {}): HealthResult {
  return {
    score: 70,
    pContinuation: 0.6,
    pAdverse: 0.3,
    alerts: [],
    timeframeReads: [],
    ...over,
  };
}

describe('recommendFromHealth (advisory only)', () => {
  it('holds a healthy position', () => {
    expect(recommendFromHealth(health({ score: 75 })).action).toBe('hold');
  });
  it('exits below the exit floor', () => {
    expect(recommendFromHealth(health({ score: 20 })).action).toBe('exit');
  });
  it('exits on a regime flip against the position', () => {
    expect(recommendFromHealth(health({ score: 90, alerts: ['regime-flip-8h'] })).action).toBe('exit');
  });
  it('trims in the mid band', () => {
    expect(recommendFromHealth(health({ score: 50 })).action).toBe('trim');
  });
  it('trims on a warning alert even at a healthy score', () => {
    expect(recommendFromHealth(health({ score: 75, alerts: ['bearish-divergence-1h'] })).action).toBe('trim');
  });
  it('echoes the score and probabilities', () => {
    const r = recommendFromHealth(health({ score: 75 }));
    expect(r.score).toBe(75);
    expect(r.pContinuation).toBe(0.6);
  });
});
