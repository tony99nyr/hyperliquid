/**
 * POST /api/cockpit/ladder/fire-rung — the autonomous money-moving seam for armed
 * ladders. The NAS watcher (dedicated cron token) or a manual admin trigger posts
 * { ladderId, rungId }; the server RE-VALIDATES everything from the persisted row and,
 * only if all guards pass, executes the pre-authorized order via performLadderRungFire.
 *
 * The caller supplies ONLY which rung — never a side/size/price. Mirrors risk-exit:
 *   1. KILL-SWITCH first — LADDER_AUTOFIRE_ENABLED off ⇒ refuse, for anyone.
 *   2. Auth: dedicated cron bearer OR admin + same-origin.
 *   3. Rate limit.
 * This is the single enforcement point (§4b.7): a flipped kill-switch stops a fire here
 * even if an in-flight watcher POST is mid-air.
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminAuth, verifyCronBearer, getClientIdentifier } from '@/lib/infrastructure/auth/auth';
import { isSameOrigin } from '@/lib/infrastructure/auth/same-origin';
import { checkRateLimit } from '@/lib/infrastructure/rate-limiting/in-memory-rate-limit';
import { extractErrorMessage } from '@/lib/infrastructure/logging/logger';
import { isLadderAutofireEnabled, getLadderCronSecret } from '@/lib/ladder/ladder-flags';
import { performLadderRungFire } from '@/lib/ladder/ladder-fire-service';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest): Promise<NextResponse> {
  // 1) Kill-switch FIRST — when off, autonomous firing does nothing, for anyone.
  if (!isLadderAutofireEnabled()) {
    return NextResponse.json({ ok: false, error: 'Ladder autofire disabled (LADDER_AUTOFIRE_ENABLED off)' }, { status: 403 });
  }

  // 2) Auth: dedicated cron token (NAS/cron, cross-origin) OR admin + same-origin.
  const cronAuthed = verifyCronBearer(request, getLadderCronSecret());
  if (!cronAuthed) {
    if (!(await verifyAdminAuth(request))) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }
    if (!isSameOrigin(request)) {
      return NextResponse.json({ ok: false, error: 'Cross-origin request rejected' }, { status: 403 });
    }
  }

  // 3) Rate limit before any work.
  const limit = checkRateLimit(`ladder-fire:${getClientIdentifier(request)}`, 60, 60_000);
  if (!limit.allowed) {
    return NextResponse.json({ ok: false, error: 'Too many requests' }, { status: 429 });
  }

  let ladderId = '';
  let rungId = '';
  try {
    const body = (await request.json()) as { ladderId?: unknown; rungId?: unknown };
    if (typeof body.ladderId === 'string') ladderId = body.ladderId.trim();
    if (typeof body.rungId === 'string') rungId = body.rungId.trim();
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!ladderId || !rungId) {
    return NextResponse.json({ ok: false, error: 'ladderId and rungId are required' }, { status: 400 });
  }

  try {
    const result = await performLadderRungFire({ ladderId, rungId, now: Date.now() });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json({ ok: false, fired: false, error: extractErrorMessage(e) }, { status: 500 });
  }
}
