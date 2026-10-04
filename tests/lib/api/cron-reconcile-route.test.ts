/**
 * Pins the reconcile cron route's auth + heartbeat contract (retro 2026-10-03: this
 * route ran silently dead for six weeks; the heartbeat rows are the alarm, so the
 * write-per-branch behaviour is load-bearing).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const verifyCronBearer = vi.fn();
const getAutoExitCronSecret = vi.fn();
const reconcileLivePositions = vi.fn();
const backfillExchangeFills = vi.fn();
const writeScoutHeartbeat = vi.fn().mockResolvedValue(undefined);

vi.mock('@/lib/infrastructure/auth/auth', () => ({ verifyCronBearer: (...a: unknown[]) => verifyCronBearer(...a) }));
vi.mock('@/lib/auto-exit/auto-exit-config', () => ({ getAutoExitCronSecret: (...a: unknown[]) => getAutoExitCronSecret(...a) }));
vi.mock('@/lib/cockpit/position-reconcile-service', () => ({ reconcileLivePositions: (...a: unknown[]) => reconcileLivePositions(...a) }));
vi.mock('@/lib/cockpit/fill-backfill-service', () => ({ backfillExchangeFills: (...a: unknown[]) => backfillExchangeFills(...a) }));
vi.mock('@/lib/scout/scout-watch-service', () => ({ writeScoutHeartbeat: (...a: unknown[]) => writeScoutHeartbeat(...a) }));

import { GET } from '@/app/api/cron/reconcile-positions/route';
import type { NextRequest } from 'next/server';

const req = (poker?: string) =>
  ({ headers: { get: (k: string) => (k.toLowerCase() === 'x-poker' ? (poker ?? null) : null) } }) as unknown as NextRequest;

beforeEach(() => {
  vi.clearAllMocks();
  verifyCronBearer.mockReturnValue(true);
  getAutoExitCronSecret.mockReturnValue('s');
  reconcileLivePositions.mockResolvedValue({ skipped: false, checked: 1, flattened: 0, resynced: 0, suspicious: false });
  backfillExchangeFills.mockResolvedValue({ skipped: false, scanned: 2, inserted: 1, unattributed: 0 });
});

describe('GET /api/cron/reconcile-positions', () => {
  it('writes an OK heartbeat with poker attribution on a healthy run', async () => {
    const res = await GET(req('nas'));
    expect(res.status).toBe(200);
    expect(writeScoutHeartbeat).toHaveBeenCalledWith('ok', expect.stringContaining('via nas'), 'reconcile');
    expect(writeScoutHeartbeat).toHaveBeenCalledTimes(1);
  });

  it('writes a DEGRADED heartbeat when the backfill skipped (alive but not healing)', async () => {
    backfillExchangeFills.mockResolvedValue({ skipped: true, reason: 'HL fills read failed', scanned: 0, inserted: 0, unattributed: 0 });
    await GET(req());
    expect(writeScoutHeartbeat).toHaveBeenCalledWith('degraded', expect.stringContaining('SKIPPED'), 'reconcile');
    expect(writeScoutHeartbeat).toHaveBeenCalledTimes(1);
  });

  it('401s without a valid bearer and writes NO heartbeat (an unauthorised poke must not look alive)', async () => {
    verifyCronBearer.mockReturnValue(false);
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(writeScoutHeartbeat).not.toHaveBeenCalled();
    expect(reconcileLivePositions).not.toHaveBeenCalled();
  });
});
