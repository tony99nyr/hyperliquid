/**
 * GET /api/cockpit/performance?sessionId=… — the Performance view's derived
 * data: trade ledger + KPI strip + 30-day equity series, folded from the durable
 * `fills` ledger (the single source of truth) + live marks.
 *
 * READ-ONLY: no writes, no order placement. Admin-authed (same gate as the
 * page), same-origin checked, and rate-limited BEFORE the (HL mids + Supabase)
 * fetch so a leaked session can't hammer upstream.
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminAuth, getClientIdentifier } from '@/lib/infrastructure/auth/auth';
import { isSameOrigin } from '@/lib/infrastructure/auth/same-origin';
import { checkRateLimit } from '@/lib/infrastructure/rate-limiting/in-memory-rate-limit';
import { getActivePerformanceSummary } from '@/lib/cockpit/performance-service';

export const dynamic = 'force-dynamic';

const PERFORMANCE_MAX_PER_MIN = 30;

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!(await verifyAdminAuth(request))) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
  if (!isSameOrigin(request)) {
    return NextResponse.json({ ok: false, error: 'Cross-origin request rejected' }, { status: 403 });
  }
  const limit = checkRateLimit(
    `performance:${getClientIdentifier(request)}`,
    PERFORMANCE_MAX_PER_MIN,
    60_000,
  );
  if (!limit.allowed) {
    return NextResponse.json({ ok: false, error: 'Too many requests' }, { status: 429 });
  }

  // SECURITY: the session is resolved SERVER-SIDE (getActiveSession). The caller
  // may pass `sessionId` only as an assertion of which session it expects — it is
  // validated against the active session, NEVER folded blindly. A mismatch (a
  // caller pointing at someone else's / a stale session) is rejected, so a leaked
  // or guessed id can't read another session's fill ledger.
  const requested = request.nextUrl.searchParams.get('sessionId')?.trim() || null;
  const result = await getActivePerformanceSummary(requested);
  if (result.status === 'forbidden') {
    return NextResponse.json({ ok: false, error: 'Session not active for this operator' }, { status: 403 });
  }
  if (result.status === 'none') {
    return NextResponse.json({ ok: false, error: 'No active session' }, { status: 404 });
  }
  return NextResponse.json({ ok: true, summary: result.summary });
}
