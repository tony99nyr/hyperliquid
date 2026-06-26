/**
 * /api/cockpit/position-stop — manage the resting protective STOP for a position.
 *
 *   GET  ?coin=SOL          → the current resting stop (or null).
 *   POST { action:'place', coin, triggerPx }  → place a reduce-only stop-market.
 *   POST { action:'cancel', coin }            → cancel the resting stop.
 *
 * A stop is REDUCE-ONLY (it can only CLOSE) — the safest order type — so this gets
 * auth + same-origin + rate-limit but no LIVE typed-phrase (it can't increase risk).
 * One stop per coin: placing requires no existing stop (cancel first) — keeps the
 * stop and position always consistent. Admin-authed; never touches a key client-side.
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminAuth, getClientIdentifier } from '@/lib/infrastructure/auth/auth';
import { isSameOrigin } from '@/lib/infrastructure/auth/same-origin';
import { checkRateLimit } from '@/lib/infrastructure/rate-limiting/in-memory-rate-limit';
import { getActiveSession } from '@/lib/cockpit/session-service';
import { loadPosition } from '@/lib/cockpit/fill-persistence-service';
import { fetchAllMids } from '@/lib/hyperliquid/hyperliquid-info-service';
import { validateEnv } from '@/lib/env/env';
import { findOpenStop, placeStopOnHl, cancelStopOnHl } from '@/lib/trading/stop-order-service';
import { writeAnalysisLog } from '@/lib/cockpit/analysis-log-service';
import { extractErrorMessage } from '@/lib/infrastructure/logging/logger';

export const dynamic = 'force-dynamic';

const STOP_MAX_PER_MIN = 15;
/** Refuse a "stop" further than this fraction from the mark (likely a fat-finger). */
const MAX_STOP_DIST_FRAC = 0.5;

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) : NaN;
  return Number.isFinite(n) ? n : null;
}
function stopSummary(s: Awaited<ReturnType<typeof findOpenStop>>) {
  return s ? { oid: s.oid, triggerPx: s.triggerPx, sz: s.sz } : null;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!(await verifyAdminAuth(request))) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
  const coin = request.nextUrl.searchParams.get('coin')?.trim().toUpperCase() ?? '';
  if (!coin) return NextResponse.json({ ok: false, error: 'coin required' }, { status: 400 });
  try {
    return NextResponse.json({ ok: true, stop: stopSummary(await findOpenStop(coin)) });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMessage(err) }, { status: 502 });
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!(await verifyAdminAuth(request))) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
  if (!isSameOrigin(request)) {
    return NextResponse.json({ ok: false, error: 'Cross-origin request rejected' }, { status: 403 });
  }
  const limit = checkRateLimit(`position-stop:${getClientIdentifier(request)}`, STOP_MAX_PER_MIN, 60_000);
  if (!limit.allowed) return NextResponse.json({ ok: false, error: 'Too many requests' }, { status: 429 });

  let body: { action?: unknown; coin?: unknown; triggerPx?: unknown };
  try { body = (await request.json()) as typeof body; } catch { return NextResponse.json({ ok: false, error: 'Invalid body' }, { status: 400 }); }
  const action = body.action === 'place' || body.action === 'cancel' ? body.action : null;
  const coin = typeof body.coin === 'string' ? body.coin.trim().toUpperCase() : '';
  if (!action) return NextResponse.json({ ok: false, error: "action must be 'place' or 'cancel'" }, { status: 400 });
  if (!coin) return NextResponse.json({ ok: false, error: 'coin required' }, { status: 400 });

  const session = await getActiveSession();
  if (!session) return NextResponse.json({ ok: false, error: 'No active session' }, { status: 409 });

  // ----- CANCEL -----
  if (action === 'cancel') {
    try {
      const stop = await findOpenStop(coin);
      if (!stop) return NextResponse.json({ ok: false, error: `No resting ${coin} stop to cancel` }, { status: 409 });
      const res = await cancelStopOnHl(coin, stop.oid);
      await writeAnalysisLog({ sessionId: session.id, source: 'position-stop', severity: 'info', message: `CANCEL STOP: ${coin} oid ${stop.oid} (${res.pushed ? 'pushed' : 'paper'}).` }).catch(() => {});
      return NextResponse.json({ ok: true, action, pushed: res.pushed });
    } catch (err) {
      return NextResponse.json({ ok: false, error: `Cancel failed: ${extractErrorMessage(err)}` }, { status: 502 });
    }
  }

  // ----- PLACE -----
  const triggerPx = num(body.triggerPx);
  if (triggerPx == null || triggerPx <= 0) return NextResponse.json({ ok: false, error: 'triggerPx must be positive' }, { status: 400 });

  const position = await loadPosition(session.id, coin);
  if (!position || position.side === 'flat' || position.sz <= 0) {
    return NextResponse.json({ ok: false, error: `No open ${coin} position to protect` }, { status: 409 });
  }
  const side: 'long' | 'short' = position.side === 'long' ? 'long' : 'short';

  // Fresh mark (uncached) — validate the stop is on the PROTECTIVE side + not absurd.
  const mids = await fetchAllMids(validateEnv().HL_NETWORK, { uncached: true });
  const markPx = mids[coin];
  if (!Number.isFinite(markPx) || markPx <= 0) return NextResponse.json({ ok: false, error: `No live ${coin} mark — try again` }, { status: 503 });
  // A long's stop must be BELOW the mark; a short's ABOVE (else it triggers instantly).
  if (side === 'long' ? triggerPx >= markPx : triggerPx <= markPx) {
    return NextResponse.json({ ok: false, error: `Stop must be ${side === 'long' ? 'below' : 'above'} the mark ($${markPx}) for a ${side}.` }, { status: 422 });
  }
  if (Math.abs(markPx - triggerPx) / markPx > MAX_STOP_DIST_FRAC) {
    return NextResponse.json({ ok: false, error: `Stop is > ${MAX_STOP_DIST_FRAC * 100}% from the mark — check the price.` }, { status: 422 });
  }

  try {
    // One stop per coin — keep the stop ⇄ position consistent. Cancel first to replace.
    if (await findOpenStop(coin)) {
      return NextResponse.json({ ok: false, error: `A ${coin} stop already exists — cancel it first to replace.`, hasStop: true }, { status: 409 });
    }
    const res = await placeStopOnHl(coin, triggerPx, position.sz, side);
    await writeAnalysisLog({ sessionId: session.id, source: 'position-stop', severity: 'info', message: `PLACE STOP: ${coin} ${side} @ $${triggerPx} sz ${position.sz} (${res.pushed ? `pushed oid ${res.oid}` : 'paper'}).` }).catch(() => {});
    return NextResponse.json({ ok: true, action, pushed: res.pushed, oid: res.oid, triggerPx });
  } catch (err) {
    return NextResponse.json({ ok: false, error: `Place failed: ${extractErrorMessage(err)}` }, { status: 502 });
  }
}
