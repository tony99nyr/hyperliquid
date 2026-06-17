/**
 * POST /api/cockpit/reject — the human rejects a pending action.
 *
 * The approval popup posts the pending_actions id here. Admin-authed; the
 * service-role update enforces the pending→rejected transition atomically. The
 * polling skill (requireApproval) observes 'rejected' and resolves NO — nothing
 * executes. Mirrors the approve route.
 *
 * Body: { id: string }.
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminAuth } from '@/lib/infrastructure/auth/auth';
import { decidePendingAction } from '@/lib/cockpit/pending-actions-service';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!(await verifyAdminAuth(request))) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  let id = '';
  try {
    const body = (await request.json()) as { id?: unknown };
    id = typeof body.id === 'string' ? body.id : '';
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid request body' }, { status: 400 });
  }
  if (!id) {
    return NextResponse.json({ ok: false, error: 'id required' }, { status: 400 });
  }

  const decided = await decidePendingAction(id, 'rejected');
  if (!decided) {
    return NextResponse.json(
      { ok: false, error: 'Action is not pending (already decided or not found)' },
      { status: 409 },
    );
  }
  return NextResponse.json({ ok: true, status: 'rejected' });
}
