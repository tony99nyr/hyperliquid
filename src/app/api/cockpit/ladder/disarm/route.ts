/**
 * POST /api/cockpit/ladder/disarm — the operator kill-switch for a single ladder.
 *
 *   POST { ladderId }  → status → 'disarmed' (reason 'operator-disarm').
 *
 * Admin + same-origin gated (a deliberate operator action). Disarming is always safe —
 * it can only STOP a ladder from firing, never start one. Idempotent: disarming an
 * already-disarmed/done ladder is a no-op success.
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminAuth, getClientIdentifier } from '@/lib/infrastructure/auth/auth';
import { isSameOrigin } from '@/lib/infrastructure/auth/same-origin';
import { checkRateLimit } from '@/lib/infrastructure/rate-limiting/in-memory-rate-limit';
import { disarmLadder } from '@/lib/ladder/ladder-service';
import { extractErrorMessage } from '@/lib/infrastructure/logging/logger';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!(await verifyAdminAuth(request))) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
  if (!isSameOrigin(request)) {
    return NextResponse.json({ ok: false, error: 'Cross-origin request rejected' }, { status: 403 });
  }
  const limit = checkRateLimit(`ladder-disarm:${getClientIdentifier(request)}`, 30, 60_000);
  if (!limit.allowed) return NextResponse.json({ ok: false, error: 'Too many requests' }, { status: 429 });

  let ladderId = '';
  try {
    const body = (await request.json()) as { ladderId?: unknown };
    if (typeof body.ladderId === 'string') ladderId = body.ladderId.trim();
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid body' }, { status: 400 });
  }
  if (!ladderId) return NextResponse.json({ ok: false, error: 'ladderId required' }, { status: 400 });

  try {
    await disarmLadder(ladderId, 'operator-disarm');
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMessage(err) }, { status: 502 });
  }
}
