/**
 * POST /api/cockpit/add-margin — add ISOLATED margin to an OPEN position.
 *
 * The correct, NON-MARTINGALE way to keep an isolated position healthy: posting
 * collateral pushes the liquidation price AWAY without changing size or direction
 * (it can never increase exposure or loss potential — worst case you committed more
 * margin, recoverable by reducing/closing). This is the de-risk the leverage-down
 * path keeps hitting HL's margin restriction on.
 *
 * Flow (mirrors adjust-leverage): auth + same-origin + rate-limit → resolve the
 * active session + its open position (its side → isBuy) → validate the amount →
 * push to HL (LIVE only; PAPER is metadata) FAIL-CLOSED (surface HL's reason) →
 * best-effort persist the new effective leverage so the cockpit's liq display
 * reflects the de-risk. ADD-ONLY; never removes margin. Admin-authed.
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminAuth, getClientIdentifier } from '@/lib/infrastructure/auth/auth';
import { isSameOrigin } from '@/lib/infrastructure/auth/same-origin';
import { checkRateLimit } from '@/lib/infrastructure/rate-limiting/in-memory-rate-limit';
import { getActiveSession } from '@/lib/cockpit/session-service';
import { loadPosition, loadPositionLeverage, updatePositionLeverage } from '@/lib/cockpit/fill-persistence-service';
import { addIsolatedMarginOnHl } from '@/lib/trading/add-margin-service';
import { writeAnalysisLog } from '@/lib/cockpit/analysis-log-service';
import { extractErrorMessage } from '@/lib/infrastructure/logging/logger';

export const dynamic = 'force-dynamic';

/** Margin posts are deliberate, not spammy. */
const ADD_MARGIN_MAX_PER_MIN = 10;
/** Absolute sanity cap on a single add (HL still rejects > free collateral). */
const MAX_ADD_USD = 100_000;

/** Pull HL's own rejection reason out of the thrown message (bounded). */
function hlRejectReason(raw: string): string | null {
  const i = raw.indexOf('{');
  if (i < 0) return null;
  try {
    const j = JSON.parse(raw.slice(i)) as { response?: unknown };
    const r = typeof j.response === 'string' ? j.response : null;
    return r ? r.replace(/\s+/g, ' ').trim().slice(0, 140) : null;
  } catch {
    return null;
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!(await verifyAdminAuth(request))) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
  if (!isSameOrigin(request)) {
    return NextResponse.json({ ok: false, error: 'Cross-origin request rejected' }, { status: 403 });
  }
  const limit = checkRateLimit(`add-margin:${getClientIdentifier(request)}`, ADD_MARGIN_MAX_PER_MIN, 60_000);
  if (!limit.allowed) {
    return NextResponse.json({ ok: false, error: 'Too many requests' }, { status: 429 });
  }

  let coin: string | null = null;
  let rawAmount: unknown;
  try {
    const body = (await request.json()) as { coin?: unknown; amountUsd?: unknown };
    if (typeof body.coin === 'string' && body.coin.trim()) coin = body.coin.trim().toUpperCase();
    rawAmount = body.amountUsd;
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid body' }, { status: 400 });
  }
  if (!coin) {
    return NextResponse.json({ ok: false, error: 'coin is required' }, { status: 400 });
  }
  const amountUsd = typeof rawAmount === 'number' ? rawAmount : typeof rawAmount === 'string' ? parseFloat(rawAmount) : NaN;
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
    return NextResponse.json({ ok: false, error: 'amountUsd must be a positive number' }, { status: 400 });
  }
  if (amountUsd > MAX_ADD_USD) {
    return NextResponse.json({ ok: false, error: `amountUsd exceeds the ${MAX_ADD_USD.toLocaleString('en-US')} cap` }, { status: 422 });
  }

  const session = await getActiveSession();
  if (!session) {
    return NextResponse.json({ ok: false, error: 'No active session' }, { status: 409 });
  }

  // The position must be OPEN — there's no isolated margin to add on a flat coin.
  const position = await loadPosition(session.id, coin);
  if (!position || position.side === 'flat' || position.sz <= 0) {
    return NextResponse.json({ ok: false, error: `No open ${coin} position to add margin to` }, { status: 409 });
  }
  const isBuy = position.side === 'long';

  // Push to HL FIRST (live) — FAIL-CLOSED: on rejection nothing else runs, and we
  // surface HL's own reason (the leverage-down path's lesson).
  let pushed: boolean;
  let mode: 'paper' | 'live';
  try {
    const res = await addIsolatedMarginOnHl(coin, amountUsd, isBuy);
    pushed = res.pushed;
    mode = res.mode;
  } catch (err) {
    const raw = extractErrorMessage(err);
    console.error('[add-margin] HL updateIsolatedMargin rejected:', raw);
    return NextResponse.json(
      { ok: false, error: `HL rejected the margin add${hlRejectReason(raw) ? `: ${hlRejectReason(raw)}` : ''}. Check free collateral, or Reduce/Close here.` },
      { status: 502 },
    );
  }

  // Best-effort: recompute the new effective leverage (notional / (oldMargin + add))
  // so the cockpit's liq display reflects the de-risk. Non-fatal — HL is the truth.
  let newLeverage: number | null = null;
  const oldLev = await loadPositionLeverage(session.id, coin);
  const notional = position.sz * position.avgEntryPx;
  if (oldLev && oldLev > 0 && notional > 0) {
    const newMargin = notional / oldLev + amountUsd;
    if (newMargin > 0) {
      newLeverage = Math.max(1, Math.round(notional / newMargin));
      await updatePositionLeverage(session.id, coin, newLeverage).catch(() => {});
    }
  }

  try {
    await writeAnalysisLog({
      sessionId: session.id,
      source: 'add-margin',
      severity: 'info',
      message: `ADD MARGIN: +$${amountUsd} to ${coin} ${position.side} (${mode}${pushed ? ', pushed to HL' : ', paper'}${newLeverage != null ? `, eff lev ≈ ${newLeverage}x` : ''}).`,
    });
  } catch {
    // non-critical
  }

  return NextResponse.json({ ok: true, pushed, mode, coin, amountUsd, newLeverage });
}
