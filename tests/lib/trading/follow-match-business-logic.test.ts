import { describe, it, expect } from 'vitest';
import { planFollowMatch, type FollowMatchInput } from '@/lib/trading/follow-match-business-logic';

function inp(over: Partial<FollowMatchInput>): FollowMatchInput {
  return {
    leaderKind: 'reduce', leaderPrevSide: 'long', leaderNewSide: 'long',
    leaderPrevSize: 10, leaderNewSize: 7, operatorSide: 'long', operatorSz: 5, ...over,
  };
}

describe('planFollowMatch — protective reduce-only matching', () => {
  it('flat operator → never proposes anything', () => {
    expect(planFollowMatch(inp({ operatorSide: 'flat', operatorSz: 0 })).action).toBe('none');
  });

  it('leader reduce 30% on the same side → proportional reduce', () => {
    const p = planFollowMatch(inp({ leaderKind: 'reduce', leaderPrevSize: 10, leaderNewSize: 7 }));
    expect(p.action).toBe('reduce');
    expect(p.fraction).toBeCloseTo(0.3);
  });

  it('leader reduce but operator on the OPPOSITE side → none', () => {
    expect(planFollowMatch(inp({ leaderKind: 'reduce', operatorSide: 'short' })).action).toBe('none');
  });

  it('leader close on the matching side → full close', () => {
    const p = planFollowMatch(inp({ leaderKind: 'close', leaderPrevSide: 'long', leaderNewSide: null, operatorSide: 'long' }));
    expect(p.action).toBe('close');
    expect(p.fraction).toBe(1);
  });

  it('leader close on the opposite side → none', () => {
    expect(planFollowMatch(inp({ leaderKind: 'close', leaderPrevSide: 'short', operatorSide: 'long' })).action).toBe('none');
  });

  it('FLIP: operator holds the pre-flip side → close it', () => {
    const p = planFollowMatch(inp({ leaderKind: 'flip', leaderPrevSide: 'long', leaderNewSide: 'short', operatorSide: 'long' }));
    expect(p.action).toBe('close');
  });

  it('FLIP: operator already on the leader new side → none (never close a correct position)', () => {
    expect(planFollowMatch(inp({ leaderKind: 'flip', leaderPrevSide: 'long', leaderNewSide: 'short', operatorSide: 'short' })).action).toBe('none');
  });

  it('leader add / open → never staged (opening is discretionary)', () => {
    expect(planFollowMatch(inp({ leaderKind: 'add' })).action).toBe('none');
    expect(planFollowMatch(inp({ leaderKind: 'open' })).action).toBe('none');
  });

  it('sub-threshold / zero reduce → none', () => {
    expect(planFollowMatch(inp({ leaderKind: 'reduce', leaderPrevSize: 10, leaderNewSize: 10 })).action).toBe('none');
  });
});
