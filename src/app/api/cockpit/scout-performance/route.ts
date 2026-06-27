/**
 * GET /api/cockpit/scout-performance — the autonomous scout's REAL track record:
 * net paper P&L + KPIs + a 30-day cumulative-P&L curve, folded from the scout's
 * own sessions (title='scout'). READ-ONLY. Admin-authed + same-origin + rate-
 * limited (same gate as the other cockpit reads). Lets the cockpit show "how the
 * scout has done over time", not just its thesis outcomes.
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminAuth, getClientIdentifier } from '@/lib/infrastructure/auth/auth';
import { isSameOrigin } from '@/lib/infrastructure/auth/same-origin';
import { checkRateLimit } from '@/lib/infrastructure/rate-limiting/in-memory-rate-limit';
import { getScoutPerformanceSummary } from '@/lib/cockpit/performance-service';
import { readScoutLaneCards } from '@/lib/scout/lane-scorecard-service';

export const dynamic = 'force-dynamic';

const MAX_PER_MIN = 30;

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!(await verifyAdminAuth(request))) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
  if (!isSameOrigin(request)) {
    return NextResponse.json({ ok: false, error: 'Cross-origin request rejected' }, { status: 403 });
  }
  if (!checkRateLimit(`scout-perf:${getClientIdentifier(request)}`, MAX_PER_MIN, 60_000).allowed) {
    return NextResponse.json({ ok: false, error: 'Too many requests' }, { status: 429 });
  }
  const [summary, laneCards] = await Promise.all([
    getScoutPerformanceSummary(),
    readScoutLaneCards().catch(() => ({ account: null, lanes: [], updatedAt: null })),
  ]);
  return NextResponse.json({ ok: true, summary, lanes: laneCards });
}
