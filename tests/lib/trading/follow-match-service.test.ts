/**
 * follow-match gating test — the critical real-money safety property: when
 * FOLLOW_MATCH_ENABLED is off, stageFollowMatch is a no-op that returns BEFORE
 * touching the DB / position / preview (so a stray POST can never stage a trade).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// If the gate ever leaked, this mock would throw on the DB call and fail the test.
vi.mock('@/lib/cockpit/supabase-server', () => ({
  getServiceRoleClient: () => { throw new Error('DB MUST NOT be touched while disabled'); },
}));

import { stageFollowMatch, isFollowMatchEnabled } from '@/lib/trading/follow-match-service';

const ORIG = process.env.FOLLOW_MATCH_ENABLED;
beforeEach(() => { delete process.env.FOLLOW_MATCH_ENABLED; });
afterEach(() => { if (ORIG === undefined) delete process.env.FOLLOW_MATCH_ENABLED; else process.env.FOLLOW_MATCH_ENABLED = ORIG; });

describe('follow-match gating (no-auto-fire safety)', () => {
  it('isFollowMatchEnabled defaults OFF and only true for exactly "true"', () => {
    expect(isFollowMatchEnabled()).toBe(false);
    process.env.FOLLOW_MATCH_ENABLED = 'false';
    expect(isFollowMatchEnabled()).toBe(false);
    process.env.FOLLOW_MATCH_ENABLED = '1';
    expect(isFollowMatchEnabled()).toBe(false);
    process.env.FOLLOW_MATCH_ENABLED = 'true';
    expect(isFollowMatchEnabled()).toBe(true);
  });

  it('stageFollowMatch is a no-op (no DB touch) when disabled', async () => {
    const r = await stageFollowMatch('any-id');
    expect(r.staged).toBe(false);
    expect(r.reason).toMatch(/disabled/i);
  });
});
