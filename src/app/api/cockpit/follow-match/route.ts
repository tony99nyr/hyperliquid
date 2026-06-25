/**
 * POST /api/cockpit/follow-match — stage a PROTECTIVE keep-matched reduce-only action
 * for a leader's detected change (PR-6). Admin-authed. NO-AUTO-FIRE: this only creates
 * a preview pending_action (the human approves it in the popup); nothing executes here.
 * GATED OFF by default (FOLLOW_MATCH_ENABLED) — disabled → staged:false no-op.
 *
 * Body: { leaderActionId: string }.
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminAuth, getClientIdentifier } from '@/lib/infrastructure/auth/auth';
import { isSameOrigin } from '@/lib/infrastructure/auth/same-origin';
import { checkRateLimit } from '@/lib/infrastructure/rate-limiting/in-memory-rate-limit';
import { stageFollowMatch } from '@/lib/trading/follow-match-service';
import { extractErrorMessage } from '@/lib/infrastructure/logging/logger';

export const dynamic = 'force-dynamic';

const MAX_PER_MIN = 30;

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!(await verifyAdminAuth(request))) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
  if (!isSameOrigin(request)) {
    return NextResponse.json({ ok: false, error: 'Cross-origin request rejected' }, { status: 403 });
  }
  const limit = checkRateLimit(`follow-match:${getClientIdentifier(request)}`, MAX_PER_MIN, 60_000);
  if (!limit.allowed) {
    return NextResponse.json({ ok: false, error: 'Too many requests' }, { status: 429 });
  }
  let leaderActionId = '';
  try {
    const body = (await request.json()) as { leaderActionId?: unknown };
    leaderActionId = typeof body.leaderActionId === 'string' ? body.leaderActionId : '';
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid request body' }, { status: 400 });
  }
  if (!leaderActionId) {
    return NextResponse.json({ ok: false, error: 'leaderActionId required' }, { status: 400 });
  }
  try {
    const result = await stageFollowMatch(leaderActionId);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    console.error('[follow-match] stage failed:', err);
    return NextResponse.json({ ok: false, error: extractErrorMessage(err) }, { status: 502 });
  }
}
