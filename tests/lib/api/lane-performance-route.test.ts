import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const auth = vi.fn();
const origin = vi.fn();
const report = vi.fn();
const confirm = vi.fn();
vi.mock('@/lib/infrastructure/auth/auth', () => ({ verifyAdminAuth: (...args: unknown[]) => auth(...args), getClientIdentifier: () => 'lane-performance-test' }));
vi.mock('@/lib/infrastructure/auth/same-origin', () => ({ isSameOrigin: (...args: unknown[]) => origin(...args) }));
vi.mock('@/lib/performance/lane-performance-service', () => ({ getLanePerformanceReport: (...args: unknown[]) => report(...args), confirmPerformanceMarker: (...args: unknown[]) => confirm(...args) }));

import { GET } from '@/app/api/cockpit/lane-performance/route';
import { POST } from '@/app/api/cockpit/lane-performance/markers/confirm/route';
import { _resetRateLimits } from '@/lib/infrastructure/rate-limiting/in-memory-rate-limit';

const req = (url = 'http://localhost/api/cockpit/lane-performance', body: unknown = null): NextRequest => ({
  nextUrl: new URL(url), headers: { get: () => null }, json: async () => body,
} as unknown as NextRequest);

describe('lane performance routes', () => {
  beforeEach(() => { vi.clearAllMocks(); _resetRateLimits(); auth.mockResolvedValue(true); origin.mockReturnValue(true);
    report.mockResolvedValue({ schemaVersion: 1, generatedAt: '2026-10-24', lanes: [], markers: [], forecast: {} }); });

  it('requires the admin PIN and same origin before reading', async () => {
    auth.mockResolvedValueOnce(false);
    expect((await GET(req())).status).toBe(401);
    origin.mockReturnValueOnce(false);
    expect((await GET(req())).status).toBe(403);
    expect(report).not.toHaveBeenCalled();
  });

  it('returns the report shape directly and passes filters', async () => {
    const response = await GET(req('http://localhost/api/cockpit/lane-performance?lane=event-straddle&since=2026-10-01'));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ schemaVersion: 1, lanes: [] });
    expect(report).toHaveBeenCalledWith({ lane: 'event-straddle', since: '2026-10-01' });
  });

  it('requires auth, origin, and a valid id before confirming', async () => {
    auth.mockResolvedValueOnce(false);
    expect((await POST(req(undefined, { id: 'x' }))).status).toBe(401);
    origin.mockReturnValueOnce(false);
    expect((await POST(req(undefined, { id: 'x' }))).status).toBe(403);
    expect((await POST(req(undefined, { id: 'x' }))).status).toBe(400);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('confirms one marker after the PIN gate', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    confirm.mockResolvedValue({ id, confirmed_by: 'operator' });
    const response = await POST(req(undefined, { id }));
    expect(response.status).toBe(200);
    expect(confirm).toHaveBeenCalledWith(id);
  });
});
