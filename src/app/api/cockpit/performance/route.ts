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
import { getAccountPerformanceSummary } from '@/lib/cockpit/performance-service';
import { getTradingMode } from '@/lib/env/mode';

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

  // ACCOUNT-WIDE: the Performance tab shows the operator's WHOLE history for the
  // current trading mode (all sessions folded), NOT one session — so opening/closing
  // sessions never hides past orders. Single-operator + admin-authed + same-origin,
  // so there's no cross-session leak to guard (it's all the operator's own account).
  // The `sessionId` query param is accepted but ignored (kept for URL compatibility).
  const summary = await getAccountPerformanceSummary(getTradingMode());
  return NextResponse.json({ ok: true, summary });
}
