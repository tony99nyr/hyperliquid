/**
 * /api/cockpit/position-tp — manage the resting reduce-only TAKE-PROFIT for a position.
 *
 *   GET  ?coin=SOL          → the current resting TP (or null).
 *   POST { action:'place', coin, triggerPx }  → place a reduce-only take-profit-market.
 *   POST { action:'cancel', coin }            → cancel the resting TP.
 *
 * Profit-side sibling of /position-stop: REDUCE-ONLY (can only CLOSE) → auth + same-
 * origin + rate-limit, no LIVE typed-phrase (it can't increase risk). A TP must sit on
 * the PROFIT side of the mark (a long's TP ABOVE, a short's TP BELOW) — the inverse of
 * a stop. One TP per coin. Admin-authed; never touches a key client-side.
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminAuth, getClientIdentifier } from '@/lib/infrastructure/auth/auth';
import { isSameOrigin } from '@/lib/infrastructure/auth/same-origin';
import { checkRateLimit } from '@/lib/infrastructure/rate-limiting/in-memory-rate-limit';
import { getActiveSession } from '@/lib/cockpit/session-service';
import { loadPosition } from '@/lib/cockpit/fill-persistence-service';
import { fetchAllMids } from '@/lib/hyperliquid/hyperliquid-info-service';
import { validateEnv } from '@/lib/env/env';
import { findOpenTp, placeTpOnHl, cancelTpOnHl } from '@/lib/trading/stop-order-service';
import { writeAnalysisLog } from '@/lib/cockpit/analysis-log-service';
import { extractErrorMessage } from '@/lib/infrastructure/logging/logger';

export const dynamic = 'force-dynamic';

const TP_MAX_PER_MIN = 15;
/** Refuse a "TP" further than this fraction from the mark (likely a fat-finger). */
const MAX_TP_DIST_FRAC = 0.5;
/** Refuse a "TP" closer than this to the mark — it would trigger on noise/instantly. */
const MIN_TP_DIST_FRAC = 0.005;

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) : NaN;
  return Number.isFinite(n) ? n : null;
}
function tpSummary(s: Awaited<ReturnType<typeof findOpenTp>>) {
  return s ? { oid: s.oid, triggerPx: s.triggerPx, sz: s.sz } : null;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!(await verifyAdminAuth(request))) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
  const coin = request.nextUrl.searchParams.get('coin')?.trim().toUpperCase() ?? '';
  if (!coin) return NextResponse.json({ ok: false, error: 'coin required' }, { status: 400 });
  try {
    return NextResponse.json({ ok: true, tp: tpSummary(await findOpenTp(coin)) });
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
  const limit = checkRateLimit(`position-tp:${getClientIdentifier(request)}`, TP_MAX_PER_MIN, 60_000);
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
      const tp = await findOpenTp(coin);
      if (!tp) return NextResponse.json({ ok: false, error: `No resting ${coin} take-profit to cancel` }, { status: 409 });
      const res = await cancelTpOnHl(coin, tp.oid);
      await writeAnalysisLog({ sessionId: session.id, source: 'position-tp', severity: 'info', message: `CANCEL TP: ${coin} oid ${tp.oid} (${res.pushed ? 'pushed' : 'paper'}).` }).catch(() => {});
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
    return NextResponse.json({ ok: false, error: `No open ${coin} position to take profit on` }, { status: 409 });
  }
  const side: 'long' | 'short' = position.side === 'long' ? 'long' : 'short';

  // Fresh mark (uncached) — validate the TP is on the PROFIT side + not absurd.
  const mids = await fetchAllMids(validateEnv().HL_NETWORK, { uncached: true });
  const markPx = mids[coin];
  if (!Number.isFinite(markPx) || markPx <= 0) return NextResponse.json({ ok: false, error: `No live ${coin} mark — try again` }, { status: 503 });
  // A long's TP must be ABOVE the mark; a short's BELOW (else it fires instantly / is a stop).
  if (side === 'long' ? triggerPx <= markPx : triggerPx >= markPx) {
    return NextResponse.json({ ok: false, error: `Take-profit must be ${side === 'long' ? 'above' : 'below'} the mark ($${markPx}) for a ${side}.` }, { status: 422 });
  }
  const tpDistFrac = Math.abs(markPx - triggerPx) / markPx;
  if (tpDistFrac > MAX_TP_DIST_FRAC) {
    return NextResponse.json({ ok: false, error: `Take-profit is > ${MAX_TP_DIST_FRAC * 100}% from the mark — check the price.` }, { status: 422 });
  }
  if (tpDistFrac < MIN_TP_DIST_FRAC) {
    return NextResponse.json({ ok: false, error: `Take-profit is < ${MIN_TP_DIST_FRAC * 100}% from the mark — it would trigger on noise.` }, { status: 422 });
  }

  try {
    // One TP per coin — keep it consistent. Cancel first to replace.
    if (await findOpenTp(coin)) {
      return NextResponse.json({ ok: false, error: `A ${coin} take-profit already exists — cancel it first to replace.`, hasTp: true }, { status: 409 });
    }
    const res = await placeTpOnHl(coin, triggerPx, position.sz, side);
    await writeAnalysisLog({ sessionId: session.id, source: 'position-tp', severity: 'info', message: `PLACE TP: ${coin} ${side} @ $${triggerPx} sz ${position.sz} (${res.pushed ? `pushed oid ${res.oid}` : 'paper'}).` }).catch(() => {});
    return NextResponse.json({ ok: true, action, pushed: res.pushed, oid: res.oid, triggerPx });
  } catch (err) {
    return NextResponse.json({ ok: false, error: `Place failed: ${extractErrorMessage(err)}` }, { status: 502 });
  }
}
