/**
 * Pins the read-only stops route: admin-gated; returns all resting stops keyed by
 * coin from a single service call; surfaces a 502 when the HL read throws.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const verifyAdminAuth = vi.fn();
const findAllStops = vi.fn();

vi.mock('@/lib/infrastructure/auth/auth', () => ({ verifyAdminAuth: (...a: unknown[]) => verifyAdminAuth(...a) }));
vi.mock('@/lib/trading/stop-order-service', () => ({ findAllStops: (...a: unknown[]) => findAllStops(...a) }));

import { GET } from '@/app/api/cockpit/stops/route';
import type { NextRequest } from 'next/server';

const req = () => ({ headers: { get: () => null } }) as unknown as NextRequest;

beforeEach(() => {
  vi.clearAllMocks();
  verifyAdminAuth.mockResolvedValue(true);
  findAllStops.mockResolvedValue({ ETH: { oid: 9, triggerPx: 1672, sz: 0.3 } });
});

describe('GET /api/cockpit/stops', () => {
  it('401 without auth', async () => {
    verifyAdminAuth.mockResolvedValue(false);
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(findAllStops).not.toHaveBeenCalled();
  });

  it('returns the resting stops keyed by coin', async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: true, stops: { ETH: { oid: 9, triggerPx: 1672, sz: 0.3 } } });
  });

  it('502 when the HL read throws', async () => {
    findAllStops.mockRejectedValue(new Error('HL down'));
    const res = await GET(req());
    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.error).toMatch(/HL down/);
  });
});
