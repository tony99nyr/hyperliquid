import { beforeEach, describe, expect, it, vi } from 'vitest';

const verifyAdminAuth = vi.fn();
const isSameOrigin = vi.fn();
const getActiveSession = vi.fn();
const loadPosition = vi.fn();
const loadPositionLeverage = vi.fn();
const updatePositionLeverage = vi.fn();
const applyLeverageOnHl = vi.fn();
const fetchAllMids = vi.fn();
const writeAnalysisLog = vi.fn();
vi.mock('@/lib/infrastructure/auth/auth', () => ({ verifyAdminAuth: (...args: unknown[]) => verifyAdminAuth(...args), getClientIdentifier: () => 'adjust-test' }));
vi.mock('@/lib/infrastructure/auth/same-origin', () => ({ isSameOrigin: (...args: unknown[]) => isSameOrigin(...args) }));
vi.mock('@/lib/cockpit/session-service', () => ({ getActiveSession: (...args: unknown[]) => getActiveSession(...args) }));
vi.mock('@/lib/cockpit/fill-persistence-service', () => ({ loadPosition: (...args: unknown[]) => loadPosition(...args), loadPositionLeverage: (...args: unknown[]) => loadPositionLeverage(...args), updatePositionLeverage: (...args: unknown[]) => updatePositionLeverage(...args) }));
vi.mock('@/lib/trading/adjust-leverage-service', () => ({ applyLeverageOnHl: (...args: unknown[]) => applyLeverageOnHl(...args) }));
vi.mock('@/lib/hyperliquid/hyperliquid-info-service', () => ({ fetchAllMids: (...args: unknown[]) => fetchAllMids(...args) }));
vi.mock('@/lib/cockpit/analysis-log-service', () => ({ writeAnalysisLog: (...args: unknown[]) => writeAnalysisLog(...args) }));

import { POST } from '@/app/api/cockpit/adjust-leverage/route';
import { _resetRateLimits } from '@/lib/infrastructure/rate-limiting/in-memory-rate-limit';
import type { NextRequest } from 'next/server';

function request(body: unknown): NextRequest {
  return { json: async () => body, headers: { get: () => null } } as unknown as NextRequest;
}

describe('adjust leverage route safety gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetRateLimits();
    verifyAdminAuth.mockResolvedValue(true);
    isSameOrigin.mockReturnValue(true);
    getActiveSession.mockResolvedValue({ id: 's1' });
    loadPosition.mockResolvedValue({ side: 'long', sz: 1, avgEntryPx: 2000 });
    loadPositionLeverage.mockResolvedValue(5);
    fetchAllMids.mockResolvedValue({ ETH: 2000 });
  });

  it('refuses a raise that moves liquidation inside the danger band without acknowledgement', async () => {
    const response = await POST(request({ coin: 'ETH', leverage: 25 }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ ok: false, requiresAck: true });
    expect(applyLeverageOnHl).not.toHaveBeenCalled();
    expect(updatePositionLeverage).not.toHaveBeenCalled();
  });
});
