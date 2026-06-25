/**
 * POST /api/cockpit/follows — follow/unfollow a leader's (coin) position (admin-authed).
 *
 * An active follow tracks a specific (leader, coin) position so the cockpit can
 * surface keep-matched suggestions when the leader reduces/closes (PR-6). The UI
 * reads followed_positions via the anon client; this is the only write path.
 * Body: { leaderAddress: string, coin: string, action: 'follow' | 'unfollow', note?: string }.
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminAuth, getClientIdentifier } from '@/lib/infrastructure/auth/auth';
import { isSameOrigin } from '@/lib/infrastructure/auth/same-origin';
import { checkRateLimit } from '@/lib/infrastructure/rate-limiting/in-memory-rate-limit';
import { addFollow, endFollow } from '@/lib/cockpit/favorites-service';
import { extractErrorMessage } from '@/lib/infrastructure/logging/logger';

export const dynamic = 'force-dynamic';

const FOLLOWS_MAX_PER_MIN = 30;

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!(await verifyAdminAuth(request))) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
  if (!isSameOrigin(request)) {
    return NextResponse.json({ ok: false, error: 'Cross-origin request rejected' }, { status: 403 });
  }
  const limit = checkRateLimit(`follows:${getClientIdentifier(request)}`, FOLLOWS_MAX_PER_MIN, 60_000);
  if (!limit.allowed) {
    return NextResponse.json({ ok: false, error: 'Too many requests' }, { status: 429 });
  }

  let leaderAddress = '';
  let coin = '';
  let action = '';
  let note: string | undefined;
  try {
    const body = (await request.json()) as { leaderAddress?: unknown; coin?: unknown; action?: unknown; note?: unknown };
    leaderAddress = typeof body.leaderAddress === 'string' ? body.leaderAddress : '';
    coin = typeof body.coin === 'string' ? body.coin : '';
    action = typeof body.action === 'string' ? body.action : '';
    note = typeof body.note === 'string' ? body.note : undefined;
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid request body' }, { status: 400 });
  }
  if (!leaderAddress || !coin) {
    return NextResponse.json({ ok: false, error: 'leaderAddress + coin required' }, { status: 400 });
  }
  if (action !== 'follow' && action !== 'unfollow') {
    return NextResponse.json({ ok: false, error: "action must be 'follow' or 'unfollow'" }, { status: 400 });
  }

  try {
    if (action === 'follow') await addFollow(leaderAddress, coin, note);
    else await endFollow(leaderAddress, coin);
    return NextResponse.json({ ok: true, action });
  } catch (err) {
    console.error('[follows] write failed:', err);
    return NextResponse.json({ ok: false, error: extractErrorMessage(err) }, { status: 502 });
  }
}
