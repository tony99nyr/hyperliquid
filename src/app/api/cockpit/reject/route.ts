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
import { verifyAdminAuth, getClientIdentifier } from '@/lib/infrastructure/auth/auth';
import { isSameOrigin } from '@/lib/infrastructure/auth/same-origin';
import { checkRateLimit } from '@/lib/infrastructure/rate-limiting/in-memory-rate-limit';
import { decidePendingAction } from '@/lib/cockpit/pending-actions-service';

export const dynamic = 'force-dynamic';

/** Decision routes are cheap but state-changing: 20/min per client. */
const REJECT_MAX_PER_MIN = 20;

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
  const limit = checkRateLimit(`reject:${getClientIdentifier(request)}`, REJECT_MAX_PER_MIN, 60_000);
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

  const decided = await decidePendingAction(id, 'rejected');
  if (!decided) {
    return NextResponse.json(
      { ok: false, error: 'Action is not pending (already decided or not found)' },
      { status: 409 },
    );
  }
  return NextResponse.json({ ok: true, status: 'rejected' });
}
