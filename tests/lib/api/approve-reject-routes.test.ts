/**
 * Pins the approve/reject routes: admin-authed + only the pending→decided
 * transition succeeds (a non-pending row 409s). decidePendingAction is mocked
 * (its atomic transition is covered in pending-actions-service.test.ts).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const verifyAdminAuth = vi.fn();
const decidePendingAction = vi.fn();
const approveWithLeverage = vi.fn();
const getPendingAction = vi.fn();

vi.mock('@/lib/infrastructure/auth/auth', () => ({
  verifyAdminAuth: (...a: unknown[]) => verifyAdminAuth(...a),
  getClientIdentifier: (req: { headers: { get: (k: string) => string | null } }) =>
    req.headers.get('x-forwarded-for') ?? 'test-client',
}));
vi.mock('@/lib/cockpit/pending-actions-service', () => ({
  decidePendingAction: (...a: unknown[]) => decidePendingAction(...a),
  approveWithLeverage: (...a: unknown[]) => approveWithLeverage(...a),
  getPendingAction: (...a: unknown[]) => getPendingAction(...a),
}));

import { POST as approve } from '@/app/api/cockpit/approve/route';
import { POST as reject } from '@/app/api/cockpit/reject/route';
import { _resetRateLimits } from '@/lib/infrastructure/rate-limiting/in-memory-rate-limit';
import type { NextRequest } from 'next/server';

function req(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return {
    json: async () => body,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
  } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetRateLimits();
  verifyAdminAuth.mockResolvedValue(true);
});

describe('POST /api/cockpit/approve', () => {
  it('401s without admin auth (and never decides)', async () => {
    verifyAdminAuth.mockResolvedValue(false);
    const res = await approve(req({ id: 'a1' }));
    expect(res.status).toBe(401);
    expect(decidePendingAction).not.toHaveBeenCalled();
  });

  it('400s without an id', async () => {
    const res = await approve(req({}));
    expect(res.status).toBe(400);
  });

  it('approves a pending action (200) and calls decide with "approved"', async () => {
    decidePendingAction.mockResolvedValue(true);
    const res = await approve(req({ id: 'a1' }));
    expect(res.status).toBe(200);
    expect(decidePendingAction).toHaveBeenCalledWith('a1', 'approved');
  });

  it('409s when the row is not pending (already decided / not found)', async () => {
    decidePendingAction.mockResolvedValue(false);
    const res = await approve(req({ id: 'a1' }));
    expect(res.status).toBe(409);
  });

  it('403s a CROSS-ORIGIN request (CSRF defense) — after auth, before deciding', async () => {
    const res = await approve(
      req({ id: 'a1' }, { host: 'cockpit.example.com', origin: 'https://evil.example.com' }),
    );
    expect(res.status).toBe(403);
    expect(decidePendingAction).not.toHaveBeenCalled();
  });

  it('cross-origin 403 still requires auth FIRST (401 wins for unauthenticated)', async () => {
    verifyAdminAuth.mockResolvedValue(false);
    const res = await approve(
      req({ id: 'a1' }, { host: 'cockpit.example.com', origin: 'https://evil.example.com' }),
    );
    expect(res.status).toBe(401);
  });
});

describe('POST /api/cockpit/approve — leverage (Item 3, server-validated)', () => {
  function pendingAction(over: Record<string, unknown> = {}) {
    return {
      id: 'a1',
      status: 'pending',
      proposal: {
        intent: { coin: 'ETH', side: 'buy', sz: 1, reduceOnly: false, leverage: 5 },
        display: { coin: 'ETH', side: 'buy', sz: 1, coinMaxLeverage: 20, leverage: 5 },
      },
      ...over,
    };
  }

  it('SERVER-VALIDATES the chosen leverage to the coin max (clamps a too-high client value)', async () => {
    getPendingAction.mockResolvedValue(pendingAction());
    approveWithLeverage.mockResolvedValue(true);
    // Client sends 99×; the coin max is 20 ⇒ server must clamp to 20.
    const res = await approve(req({ id: 'a1', leverage: 99 }));
    expect(res.status).toBe(200);
    expect(approveWithLeverage).toHaveBeenCalledWith('a1', 20);
    const json = (await res.json()) as { leverage: number };
    expect(json.leverage).toBe(20);
    // Plain decide is NOT used on the leverage path.
    expect(decidePendingAction).not.toHaveBeenCalled();
  });

  it('passes a valid in-band leverage straight through', async () => {
    getPendingAction.mockResolvedValue(pendingAction());
    approveWithLeverage.mockResolvedValue(true);
    const res = await approve(req({ id: 'a1', leverage: 8 }));
    expect(res.status).toBe(200);
    expect(approveWithLeverage).toHaveBeenCalledWith('a1', 8);
  });

  it('garbage leverage ⇒ falls back to the proposal leverage (clamped)', async () => {
    getPendingAction.mockResolvedValue(pendingAction());
    approveWithLeverage.mockResolvedValue(true);
    const res = await approve(req({ id: 'a1', leverage: -5 }));
    expect(res.status).toBe(200);
    expect(approveWithLeverage).toHaveBeenCalledWith('a1', 5); // proposal fallback
  });

  it('409s when the action is not pending', async () => {
    getPendingAction.mockResolvedValue(pendingAction({ status: 'approved' }));
    const res = await approve(req({ id: 'a1', leverage: 8 }));
    expect(res.status).toBe(409);
    expect(approveWithLeverage).not.toHaveBeenCalled();
  });

  it('NO leverage in body ⇒ plain decide path (no slider; proposal leverage kept)', async () => {
    decidePendingAction.mockResolvedValue(true);
    const res = await approve(req({ id: 'a1' }));
    expect(res.status).toBe(200);
    expect(decidePendingAction).toHaveBeenCalledWith('a1', 'approved');
    expect(approveWithLeverage).not.toHaveBeenCalled();
  });
});

describe('POST /api/cockpit/reject', () => {
  it('401s without admin auth', async () => {
    verifyAdminAuth.mockResolvedValue(false);
    const res = await reject(req({ id: 'a1' }));
    expect(res.status).toBe(401);
    expect(decidePendingAction).not.toHaveBeenCalled();
  });

  it('rejects a pending action (200) and calls decide with "rejected"', async () => {
    decidePendingAction.mockResolvedValue(true);
    const res = await reject(req({ id: 'a1' }));
    expect(res.status).toBe(200);
    expect(decidePendingAction).toHaveBeenCalledWith('a1', 'rejected');
  });

  it('409s when not pending', async () => {
    decidePendingAction.mockResolvedValue(false);
    const res = await reject(req({ id: 'a1' }));
    expect(res.status).toBe(409);
  });
});
