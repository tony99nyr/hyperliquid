import { describe, it, expect } from 'vitest';
import { expiryAlertVerdict, EXPIRY_ALERT_WINDOW_MS } from '@/lib/ladder/ladder-expiry-alert-business-logic';
import type { LadderRung } from '@/lib/ladder/ladder-types';

const NOW = 1_700_000_000_000;

function rung(over: Partial<LadderRung>): LadderRung {
  return {
    id: 'r', ladderId: 'L', seq: 1, coin: 'HYPE', side: 'long', action: 'open',
    triggerKind: 'price_above', triggerPx: 66, triggerMeta: null,
    sizeCoins: null, reduceFrac: null, riskUsd: 6, stopFrac: 0.1, leverage: 2,
    stopPx: null, targetPx: null, status: 'pending', cloid: null, ...over,
  };
}

function subject(over: Partial<Parameters<typeof expiryAlertVerdict>[0]> = {}) {
  return {
    id: 'aaaa1111-2222', title: 'HYPE long', status: 'armed' as const,
    expiresAt: new Date(NOW + 6 * 3_600_000).toISOString(), // 6h out — inside the window
    expiryAlertAt: null, rungs: [rung({})], ...over,
  };
}

describe('expiryAlertVerdict', () => {
  it('alerts once for an armed ladder inside the window with pending entries', () => {
    const v = expiryAlertVerdict(subject(), NOW);
    expect(v.shouldAlert).toBe(true);
    expect(v.message).toMatch(/expires in ~6\.0h/);
    expect(v.message).toMatch(/die unfired/);
  });

  it('dedupes: already-stamped never re-alerts', () => {
    expect(expiryAlertVerdict(subject({ expiryAlertAt: new Date(NOW - 1000).toISOString() }), NOW).shouldAlert).toBe(false);
  });

  it('silent outside the window, after expiry, without expiry, or not armed', () => {
    expect(expiryAlertVerdict(subject({ expiresAt: new Date(NOW + EXPIRY_ALERT_WINDOW_MS + 60_000).toISOString() }), NOW).shouldAlert).toBe(false);
    expect(expiryAlertVerdict(subject({ expiresAt: new Date(NOW - 1000).toISOString() }), NOW).shouldAlert).toBe(false);
    expect(expiryAlertVerdict(subject({ expiresAt: null }), NOW).shouldAlert).toBe(false);
    expect(expiryAlertVerdict(subject({ status: 'draft' as const }), NOW).shouldAlert).toBe(false);
  });

  it('silent when every rung is terminal (nothing at stake)', () => {
    expect(expiryAlertVerdict(subject({ rungs: [rung({ status: 'fired' })] }), NOW).shouldAlert).toBe(false);
  });

  it('exit-only pending rungs get the scale-outs-stop wording', () => {
    const v = expiryAlertVerdict(subject({ rungs: [rung({ status: 'fired' }), rung({ seq: 2, action: 'reduce', status: 'pending' })] }), NOW);
    expect(v.shouldAlert).toBe(true);
    expect(v.message).toMatch(/scale-outs stop at expiry/);
  });
});
