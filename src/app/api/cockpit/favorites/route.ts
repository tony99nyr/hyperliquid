/**
 * POST /api/cockpit/favorites — add/remove a favorited trader (admin-authed).
 *
 * Favorites drive the trade-watch daemon's live watch set (favorites-gated cost
 * cut). The UI reads favorited_traders via the anon client (select-only RLS); this
 * is the only write path. Body: { address: string, action: 'add' | 'remove', note?: string }.
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminAuth, getClientIdentifier } from '@/lib/infrastructure/auth/auth';
import { isSameOrigin } from '@/lib/infrastructure/auth/same-origin';
import { checkRateLimit } from '@/lib/infrastructure/rate-limiting/in-memory-rate-limit';
import { addFavorite, removeFavorite } from '@/lib/cockpit/favorites-service';
import { extractErrorMessage } from '@/lib/infrastructure/logging/logger';

export const dynamic = 'force-dynamic';

const FAVORITES_MAX_PER_MIN = 30;

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!(await verifyAdminAuth(request))) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
  if (!isSameOrigin(request)) {
    return NextResponse.json({ ok: false, error: 'Cross-origin request rejected' }, { status: 403 });
  }
  const limit = checkRateLimit(`favorites:${getClientIdentifier(request)}`, FAVORITES_MAX_PER_MIN, 60_000);
  if (!limit.allowed) {
    return NextResponse.json({ ok: false, error: 'Too many requests' }, { status: 429 });
  }

  let address = '';
  let action = '';
  let note: string | undefined;
  try {
    const body = (await request.json()) as { address?: unknown; action?: unknown; note?: unknown };
    address = typeof body.address === 'string' ? body.address : '';
    action = typeof body.action === 'string' ? body.action : '';
    note = typeof body.note === 'string' ? body.note : undefined;
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid request body' }, { status: 400 });
  }
  if (!address) {
    return NextResponse.json({ ok: false, error: 'address required' }, { status: 400 });
  }
  if (action !== 'add' && action !== 'remove') {
    return NextResponse.json({ ok: false, error: "action must be 'add' or 'remove'" }, { status: 400 });
  }

  try {
    if (action === 'add') await addFavorite(address, note);
    else await removeFavorite(address);
    return NextResponse.json({ ok: true, action });
  } catch (err) {
    console.error('[favorites] write failed:', err);
    return NextResponse.json({ ok: false, error: extractErrorMessage(err) }, { status: 502 });
  }
}
