/**
 * POST /api/cockpit/add-to-position — ADD size to an OPEN position (pyramiding).
 *
 * Increases exposure (real-money OPEN, reduceOnly:false) into the SAME coin+side,
 * re-averaging entry. Distinct from "+ New Position" so the safety is purpose-built:
 *   - position must be OPEN; the add is FORCED to the position's existing side (a
 *     fat-fingered opposite side can never reduce/flip via this route);
 *   - size is direct (`% of current` or `$ notional`), capped at MAX_ADD_MULTIPLE×;
 *   - AVERAGING-DOWN gate: adding while underwater requires an explicit ack (the
 *     martingale pattern — adding to a WINNER is the intended use);
 *   - liq sanity: refuse if the resulting liquidation would sit at/through the mark;
 *   - LIVE requires the exact typed "side coin" phrase (parity with open-position).
 * Pushes through executeIntent (the ONE seam) only on an explicit operator Approve.
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminAuth, getClientIdentifier } from '@/lib/infrastructure/auth/auth';
import { isSameOrigin } from '@/lib/infrastructure/auth/same-origin';
import { checkRateLimit } from '@/lib/infrastructure/rate-limiting/in-memory-rate-limit';
import { getActiveSession } from '@/lib/cockpit/session-service';
import { loadPosition, loadPositionLeverage, writePnlSnapshot } from '@/lib/cockpit/fill-persistence-service';
import { executeIntent } from '@/lib/trading/fill-source';
import { unrealizedPnl } from '@/lib/trading/pnl-business-logic';
import { fetchAllMids } from '@/lib/hyperliquid/hyperliquid-info-service';
import { validateEnv } from '@/lib/env/env';
import { previewAdd, MAX_ADD_MULTIPLE, type AddSizeMode } from '@/lib/trading/add-to-position-business-logic';
import { findOpenStop } from '@/lib/trading/stop-order-service';
import { extractErrorMessage } from '@/lib/infrastructure/logging/logger';
import { liquidationInsideStop } from '@/lib/trading/leverage-business-logic';
import { getTradingMode } from '@/lib/env/mode';
import { entryLiveConfirmPhrase } from '@/app/cockpit/components/entry-modal-helpers';
import { writeAnalysisLog } from '@/lib/cockpit/analysis-log-service';
import type { TradeIntent } from '@/types/fill';
import { randomUUID } from 'node:crypto';

export const dynamic = 'force-dynamic';

const ADD_MAX_PER_MIN = 10;

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
  const limit = checkRateLimit(`add-position:${getClientIdentifier(request)}`, ADD_MAX_PER_MIN, 60_000);
  if (!limit.allowed) {
    return NextResponse.json({ ok: false, error: 'Too many requests' }, { status: 429 });
  }

  let body: { coin?: unknown; mode?: unknown; value?: unknown; ackAveragingDown?: unknown; confirmPhrase?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid request body' }, { status: 400 });
  }
  const coin = typeof body.coin === 'string' ? body.coin.trim().toUpperCase() : '';
  const mode: AddSizeMode = body.mode === 'usd' ? 'usd' : 'pct';
  const value = num(body.value);
  const ackAveragingDown = body.ackAveragingDown === true;
  if (!coin) return NextResponse.json({ ok: false, error: 'coin required' }, { status: 400 });
  if (value == null || value <= 0) return NextResponse.json({ ok: false, error: 'amount must be positive' }, { status: 400 });

  const session = await getActiveSession();
  if (!session) return NextResponse.json({ ok: false, error: 'No active session' }, { status: 409 });

  const position = await loadPosition(session.id, coin);
  if (!position || position.side === 'flat' || position.sz <= 0) {
    return NextResponse.json({ ok: false, error: `No open ${coin} position to add to` }, { status: 409 });
  }
  const side: 'long' | 'short' = position.side === 'long' ? 'long' : 'short';
  const leverage = (await loadPositionLeverage(session.id, coin)) ?? 1;

  // A resting stop is sized to the CURRENT position; adding would leave it covering
  // only part of the new size. Require canceling it first (keeps stop ⇄ position
  // consistent + forces you to re-set the stop at the new average entry). FAIL-CLOSED:
  // if we can't verify, refuse the add (don't risk adding over a stale stop).
  let existingStop: Awaited<ReturnType<typeof findOpenStop>>;
  try {
    existingStop = await findOpenStop(coin);
  } catch (e) {
    return NextResponse.json({ ok: false, error: `Couldn't verify a resting ${coin} stop — retry. (${extractErrorMessage(e)})` }, { status: 502 });
  }
  if (existingStop) {
    return NextResponse.json(
      { ok: false, error: `Cancel your ${coin} stop (@ $${existingStop.triggerPx}) before adding — it only covers the current size. Re-place it after the add.`, hasStop: true },
      { status: 409 },
    );
  }

  // Fresh mark (uncached — server-side, once). A bad mark can't be sized against.
  const mids = await fetchAllMids(validateEnv().HL_NETWORK, { uncached: true });
  const markPx = mids[coin];
  if (!Number.isFinite(markPx) || markPx <= 0) {
    return NextResponse.json({ ok: false, error: `No live ${coin} mark — try again` }, { status: 503 });
  }

  // Recompute the preview SERVER-SIDE (never trust the client's numbers).
  const preview = previewAdd({
    side,
    currentSz: position.sz,
    currentEntryPx: position.avgEntryPx,
    markPx,
    leverage,
    mode,
    value,
    maxAddMultiple: MAX_ADD_MULTIPLE,
  });
  if (preview.warnings.length > 0 || preview.addSz <= 0) {
    return NextResponse.json({ ok: false, error: `Unsafe add: ${preview.warnings.join(' ') || 'zero size'}` }, { status: 422 });
  }

  // AVERAGING-DOWN gate: adding while underwater needs an explicit ack (martingale).
  if (preview.isAveragingDown && !ackAveragingDown) {
    return NextResponse.json(
      { ok: false, error: 'This adds to a LOSING position (averaging down). Confirm to proceed.', requiresAck: true, isAveragingDown: true, preview },
      { status: 409 },
    );
  }

  // Liq sanity: the new liquidation must not sit at/through the live mark.
  const buySell = side === 'long' ? 'buy' : 'sell';
  if (liquidationInsideStop(buySell, preview.newLiqPx, markPx)) {
    return NextResponse.json(
      { ok: false, error: `Add rejected: the new liquidation ($${preview.newLiqPx?.toFixed(2)}) would sit at/through the mark.` },
      { status: 422 },
    );
  }

  // LIVE needs the exact "side coin" phrase (parity with open-position).
  const tradingMode = getTradingMode();
  if (tradingMode === 'live') {
    const typed = typeof body.confirmPhrase === 'string' ? body.confirmPhrase.trim().toLowerCase() : '';
    const required = entryLiveConfirmPhrase(buySell, coin);
    if (typed !== required) {
      return NextResponse.json({ ok: false, error: `LIVE confirm phrase mismatch — type exactly: ${required}` }, { status: 422 });
    }
  }

  // Build the OPEN intent (reduceOnly:false) for the add size, same side as the
  // position. Server-authoritative id/clock. NO-AUTO-FIRE: reached only on Approve.
  const intent: TradeIntent = {
    clientIntentId: randomUUID(),
    sessionId: session.id,
    coin,
    side: buySell,
    sz: preview.addSz,
    reduceOnly: false,
    leverage,
    createdAt: Date.now(),
  };
  const fill = await executeIntent(intent);

  // executeIntent's fold appends a pnl snapshot with mark=null / unrealized=0, which
  // would briefly show the position's uPnL as 0 ("reset") until the next watch tick
  // re-marks it. We have the live mark here, so immediately append a MARKED snapshot
  // (realized is unchanged — an add closes nothing) so the displayed unrealized P&L
  // stays correct. Best-effort; the watch loop re-marks regardless.
  try {
    const after = await loadPosition(session.id, coin);
    if (after && after.side !== 'flat' && after.sz > 0) {
      await writePnlSnapshot({
        sessionId: session.id,
        coin,
        realizedPnlUsd: after.realizedPnlUsd,
        unrealizedPnlUsd: unrealizedPnl(after, markPx),
        feesPaidUsd: after.feesPaidUsd,
        markPx,
      });
    }
  } catch {
    // non-critical — the next watch tick re-marks
  }

  try {
    await writeAnalysisLog({
      sessionId: session.id,
      source: 'add-to-position',
      severity: preview.isAveragingDown ? 'warn' : 'info',
      message: `ADD: +${fill.sz} ${coin} ${side} @ $${fill.px} (new sz ${preview.newSz}, new avg $${preview.newAvgEntryPx}, new liq $${preview.newLiqPx?.toFixed(2)}${preview.isAveragingDown ? ', AVERAGING DOWN' : ''}).`,
    });
  } catch {
    // non-critical
  }

  return NextResponse.json({ ok: true, executed: fill.sz > 0, sessionId: session.id, preview, fill });
}
