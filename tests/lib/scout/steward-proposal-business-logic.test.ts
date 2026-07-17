import { describe, it, expect } from 'vitest';
import { resolveProposalCounterfactual, stewardScore } from '@/lib/scout/steward-proposal-business-logic';

const base = { proposalKind: 'exit' as const, side: 'long' as const, positionSz: 2, markPx: 100, paramPx: null };

describe('resolveProposalCounterfactual — exit/bank', () => {
  it('long exit before a drop HELPED by the fall × size', () => {
    const r = resolveProposalCounterfactual(base, [], 90);
    expect(r.scorable).toBe(true);
    expect(r.helpedUsd).toBeCloseTo(20); // (100−90)×2, exiting would have saved $20
    expect(r.note).toContain('HELPED');
  });

  it('long exit before a rally HURT (the advice would have cost the upside)', () => {
    const r = resolveProposalCounterfactual(base, [], 110);
    expect(r.helpedUsd).toBeCloseTo(-20);
    expect(r.note).toContain('HURT');
  });

  it('short exit signs invert correctly', () => {
    const r = resolveProposalCounterfactual({ ...base, side: 'short' }, [], 110);
    expect(r.helpedUsd).toBeCloseTo(20); // covering at 100 vs price rising to 110 = saved $20
  });

  it('no referenced position → unscorable, never guessed', () => {
    const r = resolveProposalCounterfactual({ ...base, side: null, positionSz: null }, [], 90);
    expect(r.scorable).toBe(false);
    expect(r.helpedUsd).toBeNull();
  });
});

describe('resolveProposalCounterfactual — stop-tighten', () => {
  const tighten = { ...base, proposalKind: 'stop-tighten' as const, paramPx: 95 };

  it('tightened stop touched, price fell further → HELPED by the difference', () => {
    const r = resolveProposalCounterfactual(tighten, [{ highPx: 98, lowPx: 94 }], 88);
    expect(r.cfExitPx).toBe(95);
    expect(r.helpedUsd).toBeCloseTo((95 - 88) * 2); // +14 saved
  });

  it('tightened stop touched, price then recovered → HURT (shaken out)', () => {
    const r = resolveProposalCounterfactual(tighten, [{ highPx: 98, lowPx: 94 }], 105);
    expect(r.helpedUsd).toBeCloseTo((95 - 105) * 2); // −20
  });

  it('stop never touched → no effect, $0, still scorable', () => {
    const r = resolveProposalCounterfactual(tighten, [{ highPx: 104, lowPx: 96 }], 102);
    expect(r.scorable).toBe(true);
    expect(r.helpedUsd).toBe(0);
    expect(r.note).toContain('never touched');
  });

  it('stop-tighten without paramPx is unscorable', () => {
    const r = resolveProposalCounterfactual({ ...tighten, paramPx: null }, [], 90);
    expect(r.scorable).toBe(false);
  });

  it('short stop-tighten replays against highs', () => {
    const r = resolveProposalCounterfactual(
      { ...tighten, side: 'short', paramPx: 105 },
      [{ highPx: 106, lowPx: 99 }],
      112,
    );
    expect(r.cfExitPx).toBe(105);
    expect(r.helpedUsd).toBeCloseTo((105 - 112) * 2 * -1); // dir −1: (105−112)×2×−1 = +14 saved
  });
});

describe('stewardScore', () => {
  it('tallies helped/hurt/net over resolved rows; open rows excluded', () => {
    const s = stewardScore([
      { status: 'resolved', helpedUsd: 12 },
      { status: 'resolved', helpedUsd: -5 },
      { status: 'resolved', helpedUsd: 0 },
      { status: 'unscorable', helpedUsd: null },
      { status: 'open', helpedUsd: null },
    ]);
    expect(s).toEqual({ resolved: 4, scorable: 3, helpedCount: 1, hurtCount: 1, netHelpedUsd: 7 });
  });
});
