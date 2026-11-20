import { describe, it, expect } from 'vitest';
import { checkReduce, checkTightenStop, parseAgentActionRequest, tightestStopPx } from '@/lib/agent-actions/agent-action-business-logic';

describe('parseAgentActionRequest', () => {
  it('accepts a tighten-stop request and normalises the coin', () => {
    expect(parseAgentActionRequest({ action: 'tighten-stop', coin: ' hype ', triggerPx: 66.5 })).toEqual({
      ok: true,
      request: { action: 'tighten-stop', coin: 'HYPE', triggerPx: 66.5 },
    });
  });

  it('accepts a reduce request at the full fraction', () => {
    expect(parseAgentActionRequest({ action: 'reduce', coin: 'BTC', fraction: 1 })).toEqual({ ok: true, request: { action: 'reduce', coin: 'BTC', fraction: 1 } });
  });

  it.each([
    ['a non-object body', 'x'],
    ['null', null],
    ['an unknown action', { action: 'open', coin: 'BTC', triggerPx: 1 }],
    ['a cancel action', { action: 'cancel', coin: 'BTC' }],
    ['a missing coin', { action: 'reduce', fraction: 0.5 }],
    ['a coin with a path character', { action: 'reduce', coin: 'BTC/..', fraction: 0.5 }],
    ['a string price', { action: 'tighten-stop', coin: 'BTC', triggerPx: '66.5' }],
    ['a zero price', { action: 'tighten-stop', coin: 'BTC', triggerPx: 0 }],
    ['a NaN price', { action: 'tighten-stop', coin: 'BTC', triggerPx: Number.NaN }],
    ['a zero fraction', { action: 'reduce', coin: 'BTC', fraction: 0 }],
    ['a fraction above 1', { action: 'reduce', coin: 'BTC', fraction: 1.01 }],
    ['a negative fraction', { action: 'reduce', coin: 'BTC', fraction: -0.5 }],
  ])('refuses %s', (_name, body) => {
    expect(parseAgentActionRequest(body).ok).toBe(false);
  });
});

describe('checkTightenStop', () => {
  const short = { side: 'short' as const, markPx: 63.5, oldPx: 69.085 };
  const long = { side: 'long' as const, markPx: 100, oldPx: 90 };

  it('allows a short stop that moves lower and stays above the mark', () => {
    expect(checkTightenStop({ ...short, newPx: 66.5 })).toEqual({ ok: true });
  });

  it('allows a long stop that moves higher and stays below the mark', () => {
    expect(checkTightenStop({ ...long, newPx: 95 })).toEqual({ ok: true });
  });

  it('refuses a short stop that moves higher (looser)', () => {
    expect(checkTightenStop({ ...short, newPx: 70 })).toEqual({ ok: false, reason: 'not-tighter-than-resting-stop' });
  });

  it('refuses a long stop that moves lower (looser)', () => {
    expect(checkTightenStop({ ...long, newPx: 85 })).toEqual({ ok: false, reason: 'not-tighter-than-resting-stop' });
  });

  it('refuses a stop equal to the resting stop', () => {
    expect(checkTightenStop({ ...short, newPx: 69.085 })).toEqual({ ok: false, reason: 'not-tighter-than-resting-stop' });
  });

  it('refuses a stop on the wrong side of the mark', () => {
    expect(checkTightenStop({ ...short, newPx: 63 })).toEqual({ ok: false, reason: 'stop-on-wrong-side-of-mark' });
    expect(checkTightenStop({ ...long, newPx: 101 })).toEqual({ ok: false, reason: 'stop-on-wrong-side-of-mark' });
  });

  it('refuses a stop closer than 0.5% to the mark', () => {
    expect(checkTightenStop({ ...short, newPx: 63.6 })).toEqual({ ok: false, reason: 'stop-too-close-to-mark' });
  });

  it('refuses a stop further than 50% from the mark', () => {
    expect(checkTightenStop({ side: 'short', markPx: 10, newPx: 16, oldPx: null })).toEqual({ ok: false, reason: 'stop-too-far-from-mark' });
  });

  it('allows a first stop when none rests', () => {
    expect(checkTightenStop({ side: 'short', markPx: 63.5, newPx: 66.5, oldPx: null })).toEqual({ ok: true });
  });

  it('refuses an unusable mark or resting stop', () => {
    expect(checkTightenStop({ ...short, markPx: Number.NaN, newPx: 66.5 })).toEqual({ ok: false, reason: 'bad-mark' });
    expect(checkTightenStop({ ...short, oldPx: Number.NaN, newPx: 66.5 })).toEqual({ ok: false, reason: 'bad-resting-stop' });
    expect(checkTightenStop({ ...short, newPx: Number.POSITIVE_INFINITY })).toEqual({ ok: false, reason: 'bad-stop-price' });
  });
});

describe('tightestStopPx', () => {
  it('returns the lowest stop for a short and the highest for a long', () => {
    expect(tightestStopPx('short', [72.6, 69.085])).toBe(69.085);
    expect(tightestStopPx('long', [90, 95])).toBe(95);
  });

  it('returns null when no stop is usable', () => {
    expect(tightestStopPx('short', [])).toBeNull();
    expect(tightestStopPx('long', [Number.NaN, 0])).toBeNull();
  });
});

describe('checkReduce', () => {
  const hype = { sz: 2.89, markPx: 63.5, szDecimals: 2 };

  it('allows a partial close when both parts clear the minimum notional', () => {
    expect(checkReduce({ ...hype, fraction: 0.4 })).toEqual({ ok: true });
  });

  it('allows a full close', () => {
    expect(checkReduce({ ...hype, fraction: 1 })).toEqual({ ok: true });
  });

  it('refuses a close under the minimum notional', () => {
    expect(checkReduce({ ...hype, fraction: 0.05 })).toEqual({ ok: false, reason: 'close-below-min-notional' });
  });

  it('checks the size that the venue submits after it floors to the lot', () => {
    // 1 x 0.151 = 0.151 is $10.04 unrounded, but the venue submits 0.15 = $9.98.
    expect(checkReduce({ sz: 1, markPx: 66.5, fraction: 0.151, szDecimals: 2 })).toEqual({ ok: false, reason: 'close-below-min-notional' });
    expect(checkReduce({ sz: 1, markPx: 66.5, fraction: 0.151, szDecimals: 3 })).toEqual({ ok: true });
  });

  it('refuses a partial close that leaves a remainder under the minimum notional', () => {
    expect(checkReduce({ ...hype, fraction: 0.96 })).toEqual({ ok: false, reason: 'remainder-below-min-notional' });
  });

  it('refuses a flat position, a bad mark, a bad fraction and a bad lot size', () => {
    expect(checkReduce({ ...hype, sz: 0, fraction: 1 })).toEqual({ ok: false, reason: 'flat' });
    expect(checkReduce({ ...hype, markPx: 0, fraction: 1 })).toEqual({ ok: false, reason: 'bad-mark' });
    expect(checkReduce({ ...hype, fraction: 1.5 })).toEqual({ ok: false, reason: 'bad-fraction' });
    expect(checkReduce({ ...hype, fraction: 1, szDecimals: 1.5 })).toEqual({ ok: false, reason: 'bad-lot-size' });
  });
});
