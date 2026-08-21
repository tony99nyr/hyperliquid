/**
 * Pins the ladder-watch cron route auth (a money-moving endpoint): cron-bearer required;
 * a bad/missing bearer → 401; a valid bearer → runLadderWatchTick. The tick itself owns
 * the autofire gate + the full fire guard stack.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

// Pin the wall clock OUTSIDE the throttle's fullTick window (minute 5): the advisory
// side-lanes stay 'throttled' so this auth test exercises only the fire pass — and the
// suite stops flapping with the minute of day it happens to run in.
vi.useFakeTimers({ shouldAdvanceTime: true });
vi.setSystemTime(new Date('2026-08-20T12:05:00Z'));
afterAll(() => vi.useRealTimers());

const verifyCronBearer = vi.fn();
const getLadderCronSecret = vi.fn();
const runLadderWatchTick = vi.fn();

vi.mock('@/lib/infrastructure/auth/auth', () => ({ verifyCronBearer: (...a: unknown[]) => verifyCronBearer(...a) }));
vi.mock('@/lib/ladder/ladder-flags', () => ({
  getLadderCronSecret: (...a: unknown[]) => getLadderCronSecret(...a),
  isReversionAlertEnabled: () => false, // sub-task stays skipped in this auth test
  isTrendAlertEnabled: () => false, // ditto (the flip guard self-skips: stance unconfigured)
  // MUST track the route's ladder-flags imports: a missing member here is undefined()
  // → TypeError → 500, but ONLY on fullTick minutes (getUTCMinutes()%10<2) — a
  // time-dependent test failure that hid for a day (08-20). Time is pinned below too.
  isRunawayAlertEnabled: () => false,
}));
vi.mock('@/lib/ladder/ladder-watch-service', () => ({ runLadderWatchTick: (...a: unknown[]) => runLadderWatchTick(...a) }));

import { GET } from '@/app/api/cron/ladder-watch/route';
import type { NextRequest } from 'next/server';

const req = () => ({ headers: { get: () => null } }) as unknown as NextRequest;

beforeEach(() => {
  vi.clearAllMocks();
  getLadderCronSecret.mockReturnValue('cron-secret');
  verifyCronBearer.mockReturnValue(true);
  runLadderWatchTick.mockResolvedValue({ autofireOff: false, laddersEvaluated: 1, rungsMet: 0, rungsFired: 0, fires: [] });
});

describe('GET /api/cron/ladder-watch', () => {
  it('401 without a valid cron bearer (no tick)', async () => {
    verifyCronBearer.mockReturnValue(false);
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(runLadderWatchTick).not.toHaveBeenCalled();
  });

  it('runs the watch tick for a valid cron caller', async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(runLadderWatchTick).toHaveBeenCalledWith(expect.objectContaining({ now: expect.any(Number) }));
  });

  it('500 (not a thrown 200) when the tick throws', async () => {
    runLadderWatchTick.mockRejectedValue(new Error('boom'));
    expect((await GET(req())).status).toBe(500);
  });
});
