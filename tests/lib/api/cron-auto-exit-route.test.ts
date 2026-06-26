/**
 * Pins the Vercel-cron backup detector route. The reason it exists is resilience:
 * a per-candidate failure must NOT abort the rest of the scan, or one bad position
 * would leave every later one unguarded.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const verifyCronBearer = vi.fn();
const performRiskExit = vi.fn();
const listExitCandidates = vi.fn();
const isAutoExitEnabled = vi.fn();
const getAutoExitCronSecret = vi.fn();

vi.mock('@/lib/infrastructure/auth/auth', () => ({ verifyCronBearer: (...a: unknown[]) => verifyCronBearer(...a) }));
vi.mock('@/lib/trading/risk-exit-service', () => ({ performRiskExit: (...a: unknown[]) => performRiskExit(...a) }));
vi.mock('@/lib/auto-exit/auto-exit-scan', () => ({ listExitCandidates: (...a: unknown[]) => listExitCandidates(...a) }));
vi.mock('@/lib/auto-exit/auto-exit-config', () => ({
  isAutoExitEnabled: () => isAutoExitEnabled(),
  getAutoExitCronSecret: () => getAutoExitCronSecret(),
  getHlAccountAddress: () => null,
}));
const scanAndAlertLiqProximity = vi.fn();
vi.mock('@/lib/auto-exit/liq-alert-service', () => ({ scanAndAlertLiqProximity: (...a: unknown[]) => scanAndAlertLiqProximity(...a) }));

import { GET } from '@/app/api/cron/auto-exit/route';
import type { NextRequest } from 'next/server';

function req(headers: Record<string, string> = {}): NextRequest {
  return { headers: { get: (k: string) => headers[k.toLowerCase()] ?? null } } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  isAutoExitEnabled.mockReturnValue(true);
  getAutoExitCronSecret.mockReturnValue('sek');
  verifyCronBearer.mockReturnValue(true);
  listExitCandidates.mockResolvedValue([]);
  scanAndAlertLiqProximity.mockResolvedValue({ scanned: 0, warned: 0, critical: 0, paged: 0 });
});

describe('GET /api/cron/auto-exit', () => {
  it('skips the auto-CLOSE when the kill-switch is off — but still ran the liq alert', async () => {
    isAutoExitEnabled.mockReturnValue(false);
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect((await res.json()).skipped).toBe('auto-close disabled');
    // notify-only liq alert runs independent of the auto-close gate...
    expect(scanAndAlertLiqProximity).toHaveBeenCalled();
    // ...but the CLOSE scan does not.
    expect(listExitCandidates).not.toHaveBeenCalled();
  });

  it('401s on a bad cron token and never scans OR alerts', async () => {
    verifyCronBearer.mockReturnValue(false);
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(scanAndAlertLiqProximity).not.toHaveBeenCalled();
    expect(listExitCandidates).not.toHaveBeenCalled();
  });

  it('isolates a per-candidate failure: a throw on one does not abort the rest', async () => {
    listExitCandidates.mockResolvedValue([
      { sessionId: 's1', coin: 'ETH' },
      { sessionId: 's1', coin: 'BTC' },
    ]);
    performRiskExit
      .mockRejectedValueOnce(new Error('ETH boom'))
      .mockResolvedValueOnce({ fired: true, reason: 'max-loss-usd', skipped: null });
    const res = await GET(req());
    expect(res.status).toBe(200);
    const json = (await res.json()) as { scanned: number; fired: number; results: Array<Record<string, unknown>> };
    expect(json.scanned).toBe(2);
    expect(json.fired).toBe(1);
    expect(json.results).toHaveLength(2);
    expect(json.results[0].error).toMatch(/boom/);
    expect(json.results[1].fired).toBe(true);
  });
});
