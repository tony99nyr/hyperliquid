/**
 * POST /api/cockpit/approve — the human approves a pending action.
 *
 * The approval popup posts the pending_actions id here. Admin-authed; the
 * service-role update enforces the pending→approved transition atomically (a
 * double click or a race on an already-decided row is a no-op). On success the
 * polling skill (requireApproval) observes 'approved' and fires the trade — this
 * route is the ONLY thing that flips a pending action to approved.
 *
 * Body: { id: string }.
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminAuth, getClientIdentifier } from '@/lib/infrastructure/auth/auth';
import { isSameOrigin } from '@/lib/infrastructure/auth/same-origin';
import { checkRateLimit } from '@/lib/infrastructure/rate-limiting/in-memory-rate-limit';
import { decidePendingAction } from '@/lib/cockpit/pending-actions-service';

export const dynamic = 'force-dynamic';

/** Decision routes are cheap but state-changing: 20/min per client. */
const APPROVE_MAX_PER_MIN = 20;

export async function POST(request: NextRequest): Promise<NextResponse> {
  // 1) Auth FIRST (an unauthenticated caller always gets 401).
  if (!(await verifyAdminAuth(request))) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
  // 2) CSRF defense-in-depth: reject cross-origin browser POSTs.
  if (!isSameOrigin(request)) {
    return NextResponse.json({ ok: false, error: 'Cross-origin request rejected' }, { status: 403 });
  }
  // 3) Rate limit BEFORE any DB write.
  const limit = checkRateLimit(`approve:${getClientIdentifier(request)}`, APPROVE_MAX_PER_MIN, 60_000);
  if (!limit.allowed) {
    return NextResponse.json({ ok: false, error: 'Too many requests' }, { status: 429 });
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

  const decided = await decidePendingAction(id, 'approved');
  if (!decided) {
    // Already decided (or not found) — not a legal pending→approved transition.
    return NextResponse.json(
      { ok: false, error: 'Action is not pending (already decided or not found)' },
      { status: 409 },
    );
  }
  return NextResponse.json({ ok: true, status: 'approved' });
}
