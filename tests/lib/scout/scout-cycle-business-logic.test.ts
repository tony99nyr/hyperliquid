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
