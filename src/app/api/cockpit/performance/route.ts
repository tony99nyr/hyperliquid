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
import { getPerformanceSummary } from '@/lib/cockpit/performance-service';

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

  const sessionId = request.nextUrl.searchParams.get('sessionId')?.trim() ?? '';
  if (!sessionId) {
    return NextResponse.json({ ok: false, error: 'Missing sessionId' }, { status: 400 });
  }
  const summary = await getPerformanceSummary(sessionId);
  return NextResponse.json({ ok: true, summary });
}
