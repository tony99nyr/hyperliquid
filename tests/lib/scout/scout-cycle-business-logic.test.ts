/**
 * parseScoutDecision — the headless contract's strict gate (malformed NEVER trades).
 * The propose kind is the STEWARD lane: a page + log, never an execution.
 */
import { describe, it, expect } from 'vitest';
import { parseScoutDecision } from '@/lib/scout/scout-cycle-business-logic';

describe('parseScoutDecision — propose (steward lane, never executes)', () => {
  it('accepts a well-formed proposal and clips lengths', () => {
    const r = parseScoutDecision(JSON.stringify({ action: 'propose', title: 'T'.repeat(200), body: 'B'.repeat(2000), coin: 'hype' }));
    expect(r.kind).toBe('propose');
    if (r.kind === 'propose') {
      expect(r.title.length).toBeLessThanOrEqual(120);
      expect(r.body.length).toBeLessThanOrEqual(1200);
      expect(r.coin).toBe('HYPE');
    }
  });

  it('a propose CARRYING open/close fields STAYS a propose — can never route to execution', () => {
    const r = parseScoutDecision(JSON.stringify({
      action: 'propose', title: 't', body: 'b', coin: 'BTC',
      side: 'buy', riskUsd: 400, stopFrac: 0.02, thesis: 'x', sessionId: 'live-xyz', fraction: 1,
    }));
    expect(r.kind).toBe('propose'); // the kind check runs BEFORE open/close parsing
  });

  it('rejects proposals without a title or body (a page must carry substance)', () => {
    expect(parseScoutDecision(JSON.stringify({ action: 'propose', body: 'x' })).kind).toBe('error');
    expect(parseScoutDecision(JSON.stringify({ action: 'propose', title: 'x' })).kind).toBe('error');
  });
});

describe('parseScoutDecision — close (session resolved by coin when omitted)', () => {
  it('accepts a close WITHOUT sessionId (headless model has coin, not session)', () => {
    const r = parseScoutDecision(JSON.stringify({ action: 'close', coin: 'SOL', note: 'target hit' }));
    expect(r.kind).toBe('close');
    if (r.kind !== 'close') return;
    expect(r.args.exit).toBe(true);
    expect(r.args.coin).toBe('SOL');
    expect('session' in r.args).toBe(false); // resolved downstream by (coin, active paper session)
    expect(r.args.note).toBe('target hit');
  });

  it('passes an explicit sessionId through when supplied', () => {
    const r = parseScoutDecision(JSON.stringify({ action: 'close', coin: 'SOL', sessionId: 'abc', fraction: 0.5 }));
    expect(r.kind).toBe('close');
    if (r.kind !== 'close') return;
    expect(r.args.session).toBe('abc');
    expect(r.args.fraction).toBe('0.5');
  });

  it('still requires a coin', () => {
    expect(parseScoutDecision(JSON.stringify({ action: 'close', sessionId: 'abc' })).kind).toBe('error');
  });
});
