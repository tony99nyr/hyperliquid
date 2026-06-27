/**
 * POST /api/cockpit/position-bracket — place a native OCO BRACKET (stop + take-profit)
 * on an open position in ONE action (HL `positionTpsl` grouping → the two legs are
 * mutually-cancelling and both auto-cancel when the position closes).
 *
 * Body: { coin, stopPx, tpPx }. Reduce-only → admin + same-origin + rate-limit, no LIVE
 * typed-phrase (can only CLOSE). Validates the stop is on the LOSS side and the TP on the
 * PROFIT side of the mark, both 0.5–50% away; refuses if a stop/TP already rests (cancel
 * first). Fail-closed: a rejected leg throws (never a half-bracket).
 *
 * NOTE: positionTpsl is a NEW live path — rehearse on testnet (long + short) before relying
 * on it; PAPER is a no-op.
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminAuth, getClientIdentifier } from '@/lib/infrastructure/auth/auth';
import { isSameOrigin } from '@/lib/infrastructure/auth/same-origin';
import { checkRateLimit } from '@/lib/infrastructure/rate-limiting/in-memory-rate-limit';
import { getActiveSession } from '@/lib/cockpit/session-service';
import { loadPosition } from '@/lib/cockpit/fill-persistence-service';
import { fetchAllMids } from '@/lib/hyperliquid/hyperliquid-info-service';
import { validateEnv } from '@/lib/env/env';
import { findOpenStop, findOpenTp, placeBracketOnHl } from '@/lib/trading/stop-order-service';
import { writeAnalysisLog } from '@/lib/cockpit/analysis-log-service';
import { extractErrorMessage } from '@/lib/infrastructure/logging/logger';

export const dynamic = 'force-dynamic';

const BRACKET_MAX_PER_MIN = 10;
const MAX_DIST_FRAC = 0.5;
const MIN_DIST_FRAC = 0.005;

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!(await verifyAdminAuth(request))) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
  if (!isSameOrigin(request)) {
    return NextResponse.json({ ok: false, error: 'Cross-origin request rejected' }, { status: 403 });
  }
  const limit = checkRateLimit(`position-bracket:${getClientIdentifier(request)}`, BRACKET_MAX_PER_MIN, 60_000);
  if (!limit.allowed) return NextResponse.json({ ok: false, error: 'Too many requests' }, { status: 429 });

  let body: { coin?: unknown; stopPx?: unknown; tpPx?: unknown };
  try { body = (await request.json()) as typeof body; } catch { return NextResponse.json({ ok: false, error: 'Invalid body' }, { status: 400 }); }
  const coin = typeof body.coin === 'string' ? body.coin.trim().toUpperCase() : '';
  const stopPx = num(body.stopPx);
  const tpPx = num(body.tpPx);
  if (!coin) return NextResponse.json({ ok: false, error: 'coin required' }, { status: 400 });
  if (stopPx == null || stopPx <= 0 || tpPx == null || tpPx <= 0) return NextResponse.json({ ok: false, error: 'stopPx + tpPx must be positive' }, { status: 400 });

  const session = await getActiveSession();
  if (!session) return NextResponse.json({ ok: false, error: 'No active session' }, { status: 409 });

  const position = await loadPosition(session.id, coin);
  if (!position || position.side === 'flat' || position.sz <= 0) {
    return NextResponse.json({ ok: false, error: `No open ${coin} position to bracket` }, { status: 409 });
  }
  const side: 'long' | 'short' = position.side === 'long' ? 'long' : 'short';

  // One bracket per coin: refuse if a stop or TP already rests (cancel first). Fail-closed
  // if we can't verify (don't stack onto an unknown resting order).
  try {
    if ((await findOpenStop(coin)) || (await findOpenTp(coin))) {
      return NextResponse.json({ ok: false, error: `A ${coin} stop or take-profit already rests — cancel it before placing a bracket.`, hasExisting: true }, { status: 409 });
    }
  } catch (e) {
    return NextResponse.json({ ok: false, error: `Couldn't verify resting ${coin} orders — retry. (${extractErrorMessage(e)})` }, { status: 502 });
  }

  // Fresh mark (uncached) — validate both legs against the live price.
  const mids = await fetchAllMids(validateEnv().HL_NETWORK, { uncached: true });
  const markPx = mids[coin];
  if (!Number.isFinite(markPx) || markPx <= 0) return NextResponse.json({ ok: false, error: `No live ${coin} mark — try again` }, { status: 503 });

  // Stop on the LOSS side (long below / short above); TP on the PROFIT side (long above / short below).
  if (side === 'long' ? stopPx >= markPx : stopPx <= markPx) {
    return NextResponse.json({ ok: false, error: `Stop must be ${side === 'long' ? 'below' : 'above'} the mark ($${markPx}) for a ${side}.` }, { status: 422 });
  }
  if (side === 'long' ? tpPx <= markPx : tpPx >= markPx) {
    return NextResponse.json({ ok: false, error: `Take-profit must be ${side === 'long' ? 'above' : 'below'} the mark ($${markPx}) for a ${side}.` }, { status: 422 });
  }
  for (const [label, px] of [['Stop', stopPx], ['Take-profit', tpPx]] as const) {
    const frac = Math.abs(markPx - px) / markPx;
    if (frac > MAX_DIST_FRAC) return NextResponse.json({ ok: false, error: `${label} is > ${MAX_DIST_FRAC * 100}% from the mark — check the price.` }, { status: 422 });
    if (frac < MIN_DIST_FRAC) return NextResponse.json({ ok: false, error: `${label} is < ${MIN_DIST_FRAC * 100}% from the mark — it would trigger on noise.` }, { status: 422 });
  }

  try {
    const res = await placeBracketOnHl(coin, stopPx, tpPx, position.sz, side);
    await writeAnalysisLog({ sessionId: session.id, source: 'position-bracket', severity: 'info', message: `PLACE BRACKET: ${coin} ${side} stop $${stopPx} / tp $${tpPx} sz ${position.sz} (${res.pushed ? `pushed stop ${res.stopOid} tp ${res.tpOid}` : 'paper'}).` }).catch(() => {});
    return NextResponse.json({ ok: true, pushed: res.pushed, stopOid: res.stopOid, tpOid: res.tpOid, stopPx, tpPx });
  } catch (err) {
    return NextResponse.json({ ok: false, error: `Bracket failed: ${extractErrorMessage(err)}` }, { status: 502 });
  }
}
