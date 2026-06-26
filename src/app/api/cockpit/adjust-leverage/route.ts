/**
 * POST /api/cockpit/adjust-leverage — change the leverage on an OPEN position.
 *
 * Changing leverage on an open isolated position does NOT change size; it adjusts
 * the posted isolated margin, MOVING the liquidation price. This route:
 *   1. auth + same-origin + rate-limit (mutating, real-money);
 *   2. resolves the active session + its open position for the coin;
 *   3. SERVER-VALIDATES the leverage to [1, coinMax] (never trusts the client);
 *   4. computes the danger guard (a RAISE that pushes liq within 5% of the live
 *      mark requires an explicit ack) — refuses without it;
 *   5. pushes the leverage to HL (LIVE only — paper is metadata) FAIL-CLOSED:
 *      if HL rejects, nothing is persisted (the cockpit never shows a leverage HL
 *      refused);
 *   6. persists the new leverage on the positions row + logs it.
 *
 * NEVER changes position size/side — this is leverage-only. Reduce/close stay on
 * the reduce-only safe-exit seam. Admin-authed; service-role writes server-side.
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminAuth, getClientIdentifier } from '@/lib/infrastructure/auth/auth';
import { isSameOrigin } from '@/lib/infrastructure/auth/same-origin';
import { checkRateLimit } from '@/lib/infrastructure/rate-limiting/in-memory-rate-limit';
import { getActiveSession } from '@/lib/cockpit/session-service';
import { loadPosition, loadPositionLeverage, updatePositionLeverage } from '@/lib/cockpit/fill-persistence-service';
import { resolveCoinMaxLeverage } from '@/lib/trading/leverage-business-logic';
import { adjustLeveragePlan } from '@/lib/trading/adjust-leverage-business-logic';
import { applyLeverageOnHl } from '@/lib/trading/adjust-leverage-service';
import { fetchAllMids } from '@/lib/hyperliquid/hyperliquid-info-service';
import { writeAnalysisLog } from '@/lib/cockpit/analysis-log-service';
import { extractErrorMessage } from '@/lib/infrastructure/logging/logger';

export const dynamic = 'force-dynamic';

/** Leverage changes are deliberate, not spammy: 10/min per client is ample. */
const ADJUST_MAX_PER_MIN = 10;

/**
 * Pull HL's OWN rejection string out of the thrown message (which ends in the HL
 * `/exchange` JSON, e.g. `{"status":"err","response":"Insufficient margin..."}`).
 * Bounded to a short clause; null when no readable reason is present. Surfacing HL's
 * reason (not the raw body) is what lets the operator pick the right fix.
 */
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
  const limit = checkRateLimit(`adjust-lev:${getClientIdentifier(request)}`, ADJUST_MAX_PER_MIN, 60_000);
  if (!limit.allowed) {
    return NextResponse.json({ ok: false, error: 'Too many requests' }, { status: 429 });
  }

  // Body: { coin, leverage, ackDanger? }.
  let coin: string | null = null;
  let rawLeverage: unknown;
  let ackDanger = false;
  try {
    const body = (await request.json()) as { coin?: unknown; leverage?: unknown; ackDanger?: unknown };
    if (typeof body.coin === 'string' && body.coin.trim()) coin = body.coin.trim().toUpperCase();
    rawLeverage = body.leverage;
    ackDanger = body.ackDanger === true;
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid body' }, { status: 400 });
  }
  if (!coin) {
    return NextResponse.json({ ok: false, error: 'coin is required' }, { status: 400 });
  }
  const requested = typeof rawLeverage === 'number' ? rawLeverage : typeof rawLeverage === 'string' ? parseFloat(rawLeverage) : NaN;
  if (!Number.isFinite(requested) || requested <= 0) {
    return NextResponse.json({ ok: false, error: 'leverage must be a positive number' }, { status: 400 });
  }

  const session = await getActiveSession();
  if (!session) {
    return NextResponse.json({ ok: false, error: 'No active session' }, { status: 409 });
  }

  // The position must be OPEN — there's no leverage to adjust on a flat coin.
  const position = await loadPosition(session.id, coin);
  if (!position || position.side === 'flat' || position.sz <= 0) {
    return NextResponse.json({ ok: false, error: `No open ${coin} position to adjust` }, { status: 409 });
  }

  const currentLeverage = await loadPositionLeverage(session.id, coin);

  // Fresh mark for the danger guard (cached ~10s). A missing mark → no danger
  // assertion, but the [1,coinMax] validation still applies.
  let markPx: number | null = null;
  try {
    const mids = await fetchAllMids();
    const m = mids[coin];
    if (typeof m === 'number' && Number.isFinite(m) && m > 0) markPx = m;
  } catch {
    // mark unavailable — proceed without the mark-relative danger guard.
  }

  const coinMax = resolveCoinMaxLeverage(coin, null);
  const plan = adjustLeveragePlan({
    side: position.side,
    entryPx: position.avgEntryPx,
    markPx,
    currentLeverage,
    requestedLeverage: requested,
    coinMax,
  });

  if (!plan.changed) {
    return NextResponse.json({ ok: false, error: `Leverage is already ${plan.leverage}x`, leverage: plan.leverage }, { status: 409 });
  }

  // SAFETY GATE: a raise that pushes liquidation inside the danger band of the
  // live mark requires an explicit ack (the operator opted in knowingly).
  if (plan.dangerNearMark && !ackDanger) {
    return NextResponse.json(
      {
        ok: false,
        error: `Liquidation would sit ~${plan.liqDistFromMarkPct?.toFixed(1)}% from the mark at ${plan.leverage}x — confirm to proceed.`,
        requiresAck: true,
        leverage: plan.leverage,
        liqPx: plan.liqPx,
        liqDistFromMarkPct: plan.liqDistFromMarkPct,
      },
      { status: 409 },
    );
  }

  // HL applies leverage as an INTEGER (submitUpdateLeverage rounds). Persist the
  // SAME rounded value so the cockpit record can never claim a fractional leverage
  // HL didn't actually apply (reconcile compares rounded, so it wouldn't heal it).
  const appliedLev = Math.round(plan.leverage);

  // Push to HL FIRST (live), then persist — so the row never claims a leverage HL
  // rejected. Fail-closed: an HL rejection throws → 502 → leverage unchanged.
  let pushed: boolean;
  try {
    const res = await applyLeverageOnHl(coin, appliedLev);
    pushed = res.pushed;
  } catch (err) {
    const raw = extractErrorMessage(err);
    console.error('[adjust-leverage] HL updateLeverage rejected:', raw);
    // Surface HL's OWN rejection reason (bounded) — it's the operator-facing detail
    // they need to act ("insufficient margin" vs "cannot switch leverage type with
    // open position" mean different fixes). Lowering ISOLATED leverage posts more
    // margin to the position, so a short-margin / open-position state is the usual
    // cause; the dependable de-risk is adding margin in the HL app, or Reduce/Close.
    return NextResponse.json(
      {
        ok: false,
        error: `HL rejected the leverage change${hlRejectReason(raw) ? `: ${hlRejectReason(raw)}` : ''}. To de-risk now: add margin in the HL app, or Reduce/Close here.`,
      },
      { status: 502 },
    );
  }

  const persisted = await updatePositionLeverage(session.id, coin, appliedLev);
  if (!persisted) {
    // HL already has the new leverage (live) but the DB write failed — surface it
    // so the operator knows the cockpit display may lag (reconciliation will heal).
    return NextResponse.json(
      { ok: false, error: 'Leverage set on HL but the cockpit record failed to update — it will reconcile shortly.', pushed, leverage: appliedLev },
      { status: 500 },
    );
  }

  try {
    await writeAnalysisLog({
      sessionId: session.id,
      source: 'adjust-leverage',
      severity: plan.dangerNearMark ? 'warn' : 'info',
      message:
        `LEVERAGE: ${coin} ${currentLeverage != null ? `${Math.round(currentLeverage)}x → ` : 'set '}${appliedLev}x ` +
        `(${pushed ? 'pushed to HL' : 'paper'}; new liq ~$${plan.liqPx?.toFixed(2) ?? '—'}` +
        `${plan.dangerNearMark ? ', danger-acked' : ''}).`,
    });
  } catch {
    // non-critical
  }

  return NextResponse.json({ ok: true, leverage: appliedLev, pushed, liqPx: plan.liqPx, liqDistFromMarkPct: plan.liqDistFromMarkPct });
}
