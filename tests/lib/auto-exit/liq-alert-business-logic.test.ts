import { describe, it, expect } from 'vitest';
import {
  liqDistancePct,
  liqTier,
  shouldAlert,
  liqLogLine,
  parseLogTier,
  formatLiqDiscord,
  DEFAULT_LIQ_ALERT_CONFIG,
} from '@/lib/auto-exit/liq-alert-business-logic';

describe('liqDistancePct', () => {
  it('is |mark − liq| / mark as a percent', () => {
    expect(liqDistancePct(100, 95)).toBeCloseTo(5, 6); // 5% away
    expect(liqDistancePct(100, 104)).toBeCloseTo(4, 6); // short: liq above mark
  });
  it('null on missing/zero inputs', () => {
    expect(liqDistancePct(null, 95)).toBeNull();
    expect(liqDistancePct(100, null)).toBeNull();
    expect(liqDistancePct(0, 95)).toBeNull();
  });
});

describe('liqTier', () => {
  const cfg = DEFAULT_LIQ_ALERT_CONFIG; // warn 8, crit 4
  it('critical ≤4%, warn ≤8%, none above', () => {
    expect(liqTier(3, cfg)).toBe('critical');
    expect(liqTier(4, cfg)).toBe('critical');
    expect(liqTier(6, cfg)).toBe('warn');
    expect(liqTier(8, cfg)).toBe('warn');
    expect(liqTier(12, cfg)).toBe('none');
    expect(liqTier(null, cfg)).toBe('none');
  });
});

describe('shouldAlert (escalation dedup)', () => {
  it('never alerts for none', () => {
    expect(shouldAlert('none', 'none')).toBe(false);
  });
  it('alerts when the new tier is higher than what was sent in the window', () => {
    expect(shouldAlert('warn', 'none')).toBe(true); // first warn
    expect(shouldAlert('critical', 'warn')).toBe(true); // escalation
    expect(shouldAlert('critical', 'none')).toBe(true);
  });
  it('suppresses same-or-lower tier within the window', () => {
    expect(shouldAlert('warn', 'warn')).toBe(false); // already warned
    expect(shouldAlert('warn', 'critical')).toBe(false); // de-escalation never re-pings
    expect(shouldAlert('critical', 'critical')).toBe(false);
  });
});

describe('log line round-trip', () => {
  it('parses coin + tier back out', () => {
    const line = liqLogLine('sol', 'critical', 3.7, 84.6, 71.6);
    expect(line).toMatch(/^LIQ\[critical\] SOL/);
    expect(parseLogTier(line)).toEqual({ coin: 'SOL', tier: 'critical' });
  });
  it('parseLogTier null on a non-liq line', () => {
    expect(parseLogTier('some other analysis message')).toBeNull();
  });
});

describe('formatLiqDiscord', () => {
  it('critical message says add margin / near liquidation', () => {
    const m = formatLiqDiscord({ coin: 'SOL', side: 'short', tier: 'critical', distPct: 3.7, liqPx: 84.6, markPx: 71.6 });
    expect(m).toMatch(/NEAR LIQUIDATION/i);
    expect(m).toMatch(/SHORT SOL/);
    expect(m).toMatch(/3\.7% away/);
    expect(m).toMatch(/Add margin/i);
  });
  it('warn message is the softer nudge', () => {
    const m = formatLiqDiscord({ coin: 'ETH', side: 'long', tier: 'warn', distPct: 7.2, liqPx: 1500, markPx: 1617 });
    expect(m).toMatch(/nearing liquidation/i);
    expect(m).toMatch(/de-risk/i);
  });
});
