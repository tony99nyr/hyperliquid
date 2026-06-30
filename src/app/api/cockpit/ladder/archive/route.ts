/**
 * POST /api/cockpit/ladder/archive — soft-archive a single ladder (hide from the UI).
 *
 *   POST { ladderId }  → archived_at = now.
 *
 * Admin + same-origin gated (a deliberate operator action). Archiving is a UI-only
 * tombstone — the row (+ rungs + ladder_fires) stays in the DB for the audit trail, and an
 * ARMED ladder can never be archived (the service refuses status='armed'). Idempotent:
 * archiving an already-archived ladder is a no-op success.
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminAuth, getClientIdentifier } from '@/lib/infrastructure/auth/auth';
import { isSameOrigin } from '@/lib/infrastructure/auth/same-origin';
import { checkRateLimit } from '@/lib/infrastructure/rate-limiting/in-memory-rate-limit';
import { archiveLadder } from '@/lib/ladder/ladder-service';
import { extractErrorMessage } from '@/lib/infrastructure/logging/logger';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!(await verifyAdminAuth(request))) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
  if (!isSameOrigin(request)) {
    return NextResponse.json({ ok: false, error: 'Cross-origin request rejected' }, { status: 403 });
  }
  const limit = checkRateLimit(`ladder-archive:${getClientIdentifier(request)}`, 30, 60_000);
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
    const archived = await archiveLadder(ladderId);
    // false = it was armed (can't archive a live ladder) or already archived / absent.
    if (!archived) return NextResponse.json({ ok: false, error: 'Cannot archive — an armed ladder cannot be hidden (disarm it first).' }, { status: 409 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMessage(err) }, { status: 502 });
  }
}
