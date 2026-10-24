import { beforeEach, describe, expect, it, vi } from 'vitest';

const verifyAdminAuth = vi.fn();
const isSameOrigin = vi.fn();
const disarmLadder = vi.fn();
vi.mock('@/lib/infrastructure/auth/auth', () => ({ verifyAdminAuth: (...args: unknown[]) => verifyAdminAuth(...args), getClientIdentifier: () => 'disarm-test' }));
vi.mock('@/lib/infrastructure/auth/same-origin', () => ({ isSameOrigin: (...args: unknown[]) => isSameOrigin(...args) }));
vi.mock('@/lib/ladder/ladder-service', () => ({ disarmLadder: (...args: unknown[]) => disarmLadder(...args) }));

import { POST } from '@/app/api/cockpit/ladder/disarm/route';
import { _resetRateLimits } from '@/lib/infrastructure/rate-limiting/in-memory-rate-limit';
import type { NextRequest } from 'next/server';

function request(body: unknown): NextRequest {
  return { json: async () => body, headers: { get: () => null } } as unknown as NextRequest;
}

describe('ladder disarm route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetRateLimits();
    verifyAdminAuth.mockResolvedValue(true);
    isSameOrigin.mockReturnValue(true);
    disarmLadder.mockResolvedValue(undefined);
  });

  it('writes the operator disarm reason and returns success on repeated disarms', async () => {
    const first = await POST(request({ ladderId: 'ladder-1' }));
    const second = await POST(request({ ladderId: 'ladder-1' }));
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(disarmLadder).toHaveBeenNthCalledWith(1, 'ladder-1', 'operator-disarm');
    expect(disarmLadder).toHaveBeenNthCalledWith(2, 'ladder-1', 'operator-disarm');
  });

  it('stops autonomy only: disarm never cancels the protective resting stop', async () => {
    // A disarmed ladder may still hold a filled position. Its exchange-resting stop is
    // the only protection left, so disarm must leave resting orders alone.
    const response = await POST(request({ ladderId: 'ladder-1' }));
    expect(response.status).toBe(200);
    expect(disarmLadder).toHaveBeenCalledTimes(1);
    expect(disarmLadder).toHaveBeenCalledWith('ladder-1', 'operator-disarm');
  });
});
