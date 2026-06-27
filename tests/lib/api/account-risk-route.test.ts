/** Pins the read-only account-risk route: admin-gated; returns per-coin risk; 502 on throw. */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const verifyAdminAuth = vi.fn();
const fetchAccountRisk = vi.fn();

vi.mock('@/lib/infrastructure/auth/auth', () => ({ verifyAdminAuth: (...a: unknown[]) => verifyAdminAuth(...a) }));
vi.mock('@/lib/trading/account-risk-service', () => ({ fetchAccountRisk: (...a: unknown[]) => fetchAccountRisk(...a) }));

import { GET } from '@/app/api/cockpit/account-risk/route';
import type { NextRequest } from 'next/server';

const req = () => ({ headers: { get: () => null } }) as unknown as NextRequest;

beforeEach(() => {
  vi.clearAllMocks();
  verifyAdminAuth.mockResolvedValue(true);
  fetchAccountRisk.mockResolvedValue({ ETH: { liqPx: 2658.36, effLeverage: 1.4, marginUsed: 856.83 } });
});

describe('GET /api/cockpit/account-risk', () => {
  it('401 without auth', async () => {
    verifyAdminAuth.mockResolvedValue(false);
    expect((await GET(req())).status).toBe(401);
    expect(fetchAccountRisk).not.toHaveBeenCalled();
  });

  it('returns per-coin risk', async () => {
    const json = await (await GET(req())).json();
    expect(json).toEqual({ ok: true, risk: { ETH: { liqPx: 2658.36, effLeverage: 1.4, marginUsed: 856.83 } } });
  });

  it('502 when the HL read throws', async () => {
    fetchAccountRisk.mockRejectedValue(new Error('HL down'));
    const res = await GET(req());
    expect(res.status).toBe(502);
    expect((await res.json()).ok).toBe(false);
  });
});
