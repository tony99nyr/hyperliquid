/**
 * Pins the ladder-watch cron route auth (a money-moving endpoint): cron-bearer required;
 * a bad/missing bearer → 401; a valid bearer → runLadderWatchTick. The tick itself owns
 * the autofire gate + the full fire guard stack.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const verifyCronBearer = vi.fn();
const getLadderCronSecret = vi.fn();
const runLadderWatchTick = vi.fn();

vi.mock('@/lib/infrastructure/auth/auth', () => ({ verifyCronBearer: (...a: unknown[]) => verifyCronBearer(...a) }));
vi.mock('@/lib/ladder/ladder-flags', () => ({ getLadderCronSecret: (...a: unknown[]) => getLadderCronSecret(...a) }));
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
