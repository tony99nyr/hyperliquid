/**
 * Pins the approve/reject routes: admin-authed + only the pending→decided
 * transition succeeds (a non-pending row 409s). decidePendingAction is mocked
 * (its atomic transition is covered in pending-actions-service.test.ts).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const verifyAdminAuth = vi.fn();
const decidePendingAction = vi.fn();

vi.mock('@/lib/infrastructure/auth/auth', () => ({ verifyAdminAuth: (...a: unknown[]) => verifyAdminAuth(...a) }));
vi.mock('@/lib/cockpit/pending-actions-service', () => ({
  decidePendingAction: (...a: unknown[]) => decidePendingAction(...a),
}));

import { POST as approve } from '@/app/api/cockpit/approve/route';
import { POST as reject } from '@/app/api/cockpit/reject/route';
import type { NextRequest } from 'next/server';

function req(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
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
