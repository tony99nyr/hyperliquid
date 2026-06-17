/**
 * GET /api/cockpit/active-session — the latest active session (or null).
 *
 * The cockpit page is an RSC and passes the active session at load. But a session
 * is often opened MID-FLOW (the operator runs open-session while the cockpit is
 * already on screen). This route lets the client poll for a newly-active session
 * so its approval popup + Safe-Exit button surface without a manual refresh.
 *
 * Admin-authed (same gate as the page). Read-only — no writes.
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminAuth } from '@/lib/infrastructure/auth/auth';
import { getActiveSession } from '@/lib/cockpit/session-service';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!(await verifyAdminAuth(request))) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
  const session = await getActiveSession();
  return NextResponse.json({ ok: true, session });
}
