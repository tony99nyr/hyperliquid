import { describe, it, expect } from 'vitest';
import {
  decideTick,
  computeThresholdAlerts,
  severityForAlertCode,
  formatAlertMessage,
  DEFAULT_WATCH_CONFIG,
  type WatchConfig,
} from '@/lib/watch/watch-business-logic';
import type { Position } from '@/types/position';
import type { HealthResult } from '@/lib/health/health-engine-types';

function pos(over: Partial<Position> = {}): Position {
  return {
    coin: 'ETH',
    side: 'long',
    sz: 2,
    avgEntryPx: 2000,
    realizedPnlUsd: 0,
    feesPaidUsd: 3,
    ...over,
  };
}

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

describe('decideTick — P&L computation', () => {
  it('computes unrealized + total P&L for a LONG correctly', () => {
    // long 2 @ 2000, mark 2100 ⇒ +$200 unrealized; total = 0 + 200 − 3 fees.
    const d = decideTick({ position: pos(), markPx: 2100, health: health(), lastAlertCodes: [] });
    expect(d.flat).toBe(false);
    expect(d.pnl.unrealizedPnlUsd).toBe(200);
    expect(d.pnl.totalPnlUsd).toBe(197);
    expect(d.pnl.markPx).toBe(2100);
  });

  it('computes unrealized P&L for a SHORT correctly (gains when price falls)', () => {
    // short 2 @ 2000, mark 1900 ⇒ +$200 unrealized.
    const d = decideTick({
      position: pos({ side: 'short' }),
      markPx: 1900,
      health: health(),
      lastAlertCodes: [],
    });
    expect(d.pnl.unrealizedPnlUsd).toBe(200);
    // mark rising hurts a short:
    const d2 = decideTick({
      position: pos({ side: 'short' }),
      markPx: 2100,
      health: health(),
      lastAlertCodes: [],
    });
    expect(d2.pnl.unrealizedPnlUsd).toBe(-200);
  });

  it('no-ops (flat) when the position is flat or zero-size', () => {
    const d = decideTick({
      position: pos({ side: 'flat', sz: 0, avgEntryPx: 0 }),
      markPx: 2100,
      health: health(),
      lastAlertCodes: ['drawdown'],
    });
    expect(d.flat).toBe(true);
    expect(d.snapshot.alerts).toEqual([]);
    expect(d.newAlerts).toEqual([]);
    expect(d.activeAlertCodes).toEqual([]);
    expect(d.pnl.unrealizedPnlUsd).toBe(0);
  });
});

describe('computeThresholdAlerts — drawdown + big-move', () => {
  const config: WatchConfig = { drawdownPctOfNotional: 0.05, bigMovePct: 0.05, timeStopDays: 5, timeStopMinProgressFracOfNotional: 0.01 };

  it('fires drawdown when unrealized loss exceeds % of notional', () => {
    // long 2 @ 2000 = $4000 notional; 5% = $200. mark 1850 ⇒ −$300 loss > $200.
    const uPnl = -300;
    const alerts = computeThresholdAlerts(pos(), 1850, uPnl, config);
    expect(alerts).toContain('drawdown');
  });

  it('does NOT fire drawdown for a small loss under the threshold', () => {
    const uPnl = -100; // < $200 threshold
    const alerts = computeThresholdAlerts(pos(), 1950, uPnl, config);
    expect(alerts).not.toContain('drawdown');
  });

  it('fires big-move when price moves ≥ bigMovePct from entry (either direction)', () => {
    // up 5%: 2000 → 2100
    expect(computeThresholdAlerts(pos(), 2100, 200, config)).toContain('big-move');
    // down 5%: 2000 → 1900
    expect(computeThresholdAlerts(pos(), 1900, -200, config)).toContain('big-move');
    // small move: no big-move
    expect(computeThresholdAlerts(pos(), 2020, 40, config)).not.toContain('big-move');
  });

  it('returns no threshold alerts for a flat position', () => {
    expect(computeThresholdAlerts(pos({ side: 'flat', sz: 0 }), 9999, -9999, config)).toEqual([]);
  });
});

describe('decideTick — alert dedup (state-change only)', () => {
  it('emits an alert the FIRST tick it appears, then suppresses it next tick', () => {
    const position = pos();
    // Health alert + a big move; lastAlertCodes empty ⇒ both are new.
    const first = decideTick({
      position,
      markPx: 2100,
      health: health({ alerts: ['bearish-divergence-1h'] }),
      lastAlertCodes: [],
    });
    const firstCodes = first.newAlerts.map((a) => a.code);
    expect(firstCodes).toContain('bearish-divergence-1h');
    expect(firstCodes).toContain('big-move');

    // Second tick: same alerts active, passed in as lastAlertCodes ⇒ none new.
    const second = decideTick({
      position,
      markPx: 2100,
      health: health({ alerts: ['bearish-divergence-1h'] }),
      lastAlertCodes: first.activeAlertCodes,
    });
    expect(second.newAlerts).toEqual([]);
    // But the snapshot still records the full active set (UI shows current state).
    expect(second.snapshot.alerts).toContain('bearish-divergence-1h');
    expect(second.snapshot.alerts).toContain('big-move');
  });

  it('emits only the NEWLY-added alert when one is added on top of an existing one', () => {
    const position = pos();
    const tick = decideTick({
      position,
      markPx: 2100, // big-move active
      health: health({ alerts: ['regime-flip-8h'] }), // newly added
      lastAlertCodes: ['big-move'], // big-move was already active last tick
    });
    const codes = tick.newAlerts.map((a) => a.code);
    expect(codes).toEqual(['regime-flip-8h']);
  });

  it('dedupes duplicate codes within a single tick', () => {
    const position = pos();
    const tick = decideTick({
      position,
      markPx: 2010, // no big move
      health: health({ alerts: ['decline-detected', 'decline-detected'] }),
      lastAlertCodes: [],
    });
    expect(tick.activeAlertCodes.filter((c) => c === 'decline-detected')).toHaveLength(1);
  });
});

describe('severityForAlertCode', () => {
  it('maps regime-flip + drawdown to danger, others to warn', () => {
    expect(severityForAlertCode('regime-flip-8h')).toBe('danger');
    expect(severityForAlertCode('drawdown')).toBe('danger');
    expect(severityForAlertCode('bearish-divergence-1h')).toBe('warn');
    expect(severityForAlertCode('big-move')).toBe('warn');
    expect(severityForAlertCode('decline-detected')).toBe('warn');
  });
});

describe('formatAlertMessage', () => {
  it('renders coin, code, signed uPnL, and mark', () => {
    const d = decideTick({ position: pos(), markPx: 2100, health: health(), lastAlertCodes: [] });
    const msg = formatAlertMessage('ETH', { code: 'big-move', severity: 'warn' }, d.pnl);
    expect(msg).toContain('ETH');
    expect(msg).toContain('big-move');
    expect(msg).toContain('+$200.00');
    expect(msg).toContain('2100');
  });
});

describe('DEFAULT_WATCH_CONFIG', () => {
  it('is used when no config is supplied to decideTick', () => {
    // 5% default big-move: 2000 → 2100 should fire big-move with defaults.
    const d = decideTick({ position: pos(), markPx: 2100, health: health(), lastAlertCodes: [] });
    expect(d.activeAlertCodes).toContain('big-move');
    expect(DEFAULT_WATCH_CONFIG.bigMovePct).toBe(0.05);
  });
});

describe('computeThresholdAlerts — time-stop advisory', () => {
  const NOW = 1_700_000_000_000;
  const cfg: WatchConfig = { ...DEFAULT_WATCH_CONFIG }; // 5 days, 1% progress bar

  it('fires when open past the day bar without reaching the progress bar', () => {
    // long 2 @ 2000 = $4000 notional; progress bar = $40. uPnl +$10 → stalling.
    const openedAt = NOW - 6 * 86_400_000;
    const alerts = computeThresholdAlerts(pos(), 2005, 10, cfg, openedAt, NOW);
    expect(alerts).toContain('time-stop');
  });

  it('silent when the trade is WORKING (progress ≥ bar) regardless of age', () => {
    const openedAt = NOW - 30 * 86_400_000;
    const alerts = computeThresholdAlerts(pos(), 2100, 200, cfg, openedAt, NOW);
    expect(alerts).not.toContain('time-stop');
  });

  it('silent before the day bar', () => {
    const openedAt = NOW - 2 * 86_400_000;
    const alerts = computeThresholdAlerts(pos(), 2005, 10, cfg, openedAt, NOW);
    expect(alerts).not.toContain('time-stop');
  });

  it('skipped entirely when openedAt/now are unknown (never guesses age)', () => {
    expect(computeThresholdAlerts(pos(), 2005, 10, cfg, null, NOW)).not.toContain('time-stop');
    expect(computeThresholdAlerts(pos(), 2005, 10, cfg, NOW - 10 * 86_400_000, undefined)).not.toContain('time-stop');
  });

  it('a stalling LOSING position fires time-stop too (loss also fails the progress bar)', () => {
    const openedAt = NOW - 6 * 86_400_000;
    const alerts = computeThresholdAlerts(pos(), 1980, -40, cfg, openedAt, NOW);
    expect(alerts).toContain('time-stop');
  });

  it('time-stop is warn severity (advisory, not danger)', () => {
    expect(severityForAlertCode('time-stop')).toBe('warn');
  });
});
