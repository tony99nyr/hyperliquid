/**
 * POST /api/cockpit/risk-exit — the Layer-1 autonomous exit-only endpoint.
 *
 * Accepts a candidate (sessionId, coin) from the NAS detector (dedicated cron
 * token) or a manual admin trigger (admin auth + same-origin), RE-VERIFIES the
 * risk condition server-side, and — only if a trigger genuinely fires — submits a
 * reduce-only close. The caller cannot supply a side/size; the close is derived
 * server-side from the live position, so this can never open/add/flip.
 *
 * Gated by AUTO_EXIT_ENABLED (default OFF) — when off, the endpoint refuses.
 */

import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { verifyAdminAuth, getClientIdentifier } from '@/lib/infrastructure/auth/auth';
import { isSameOrigin } from '@/lib/infrastructure/auth/same-origin';
import { checkRateLimit } from '@/lib/infrastructure/rate-limiting/in-memory-rate-limit';
import { extractErrorMessage } from '@/lib/infrastructure/logging/logger';
import { performRiskExit } from '@/lib/trading/risk-exit-service';
import { isAutoExitEnabled, getAutoExitCronSecret } from '@/lib/auto-exit/auto-exit-config';

export const dynamic = 'force-dynamic';

/** Constant-time bearer-token check against the dedicated auto-exit cron secret. */
export function bearerMatches(request: NextRequest, secret: string | undefined): boolean {
  if (!secret) return false;
  const header = request.headers.get('authorization') ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!m) return false;
  const provided = Buffer.from(m[1]);
  const expected = Buffer.from(secret);
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  // 1) Kill-switch FIRST — when off the endpoint does nothing, for anyone.
  if (!isAutoExitEnabled()) {
    return NextResponse.json({ ok: false, error: 'Auto-exit disabled (AUTO_EXIT_ENABLED off)' }, { status: 403 });
  }

  // 2) Auth: dedicated cron token (NAS/cron, cross-origin) OR admin + same-origin.
  const cronAuthed = bearerMatches(request, getAutoExitCronSecret());
  if (!cronAuthed) {
    if (!(await verifyAdminAuth(request))) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }
    if (!isSameOrigin(request)) {
      return NextResponse.json({ ok: false, error: 'Cross-origin request rejected' }, { status: 403 });
    }
  }

  // 3) Rate limit before any work.
  const limit = checkRateLimit(`risk-exit:${getClientIdentifier(request)}`, 30, 60_000);
  if (!limit.allowed) {
    return NextResponse.json({ ok: false, error: 'Too many requests' }, { status: 429 });
  }

  let sessionId = '';
  let coin = '';
  let reason: string | undefined;
  try {
    const body = (await request.json()) as { sessionId?: unknown; coin?: unknown; reason?: unknown };
    if (typeof body.sessionId === 'string') sessionId = body.sessionId.trim();
    if (typeof body.coin === 'string') coin = body.coin.trim();
    if (typeof body.reason === 'string') reason = body.reason;
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!sessionId || !coin) {
    return NextResponse.json({ ok: false, error: 'sessionId and coin are required' }, { status: 400 });
  }

  try {
    const result = await performRiskExit({ sessionId, coin, triggerHint: reason, now: Date.now() });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json({ ok: false, fired: false, error: extractErrorMessage(e) }, { status: 500 });
  }
}
