/**
 * POST /api/cockpit/safe-exit — the dead-man's switch.
 *
 * The Safe-Exit panic button posts here. It works with ZERO dependency on a live
 * Claude session: the server resolves the active session + its open position,
 * then EITHER uses the current Safe-Exit plan when it is FRESH (Claude is keeping
 * it armed), OR builds a market reduce-only full close from the LIVE position
 * (the "Claude offline" fallback). It then calls executeIntent directly — the
 * same seam every trade rides (paper now / live later) — and returns the result
 * plus staleness + usedFallback so the UI can show what happened.
 *
 * Admin-authed (the cockpit's existing admin auth). Service-role writes happen
 * server-side via executeIntent / the plan service — never the browser.
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminAuth } from '@/lib/infrastructure/auth/auth';
import { getActiveSession } from '@/lib/cockpit/session-service';
import { loadPosition } from '@/lib/cockpit/fill-persistence-service';
import { getSafeExitPlan } from '@/lib/cockpit/safe-exit-plan-service';
import { executeIntent } from '@/lib/trading/fill-source';
import {
  buildMarketReduceOnlyClose,
  isPlanFresh,
  DEFAULT_SAFE_EXIT_STALENESS_MS,
} from '@/lib/trading/safe-exit-business-logic';
import { writeAnalysisLog } from '@/lib/cockpit/analysis-log-service';
import { randomUUID } from 'node:crypto';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!(await verifyAdminAuth(request))) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  // Optional body: an explicit coin (otherwise close the session's single open
  // position). Tolerate an empty/invalid body — the button can POST nothing.
  let coinOverride: string | undefined;
  try {
    const body = (await request.json()) as { coin?: unknown };
    if (typeof body.coin === 'string' && body.coin.trim()) coinOverride = body.coin.trim().toUpperCase();
  } catch {
    // no body — fine.
  }

  const session = await getActiveSession();
  if (!session) {
    return NextResponse.json({ ok: false, error: 'No active session' }, { status: 409 });
  }

  // Resolve the plan + the live position. The plan tells us the coin when the
  // caller did not specify one.
  const plan = await getSafeExitPlan(session.id);
  const coin = coinOverride ?? plan?.intent.coin ?? null;
  if (!coin) {
    return NextResponse.json(
      { ok: false, error: 'No coin to exit (no plan and none supplied)' },
      { status: 409 },
    );
  }

  const position = await loadPosition(session.id, coin);
  if (!position || position.side === 'flat' || position.sz <= 0) {
    return NextResponse.json(
      { ok: false, error: `No open ${coin} position to exit`, executed: false },
      { status: 409 },
    );
  }

  const now = Date.now();
  const planFresh = isPlanFresh(plan?.updatedAt, now, DEFAULT_SAFE_EXIT_STALENESS_MS);

  // FRESH Claude plan → trust it. STALE/absent → build the market reduce-only
  // close from the LIVE position (the Claude-offline path). Either way the
  // session id is forced onto the intent and a fresh idempotency key is minted.
  let intent;
  let usedFallback: boolean;
  if (plan && planFresh) {
    intent = { ...plan.intent, sessionId: session.id, clientIntentId: randomUUID(), createdAt: now };
    usedFallback = false;
  } else {
    const fallback = buildMarketReduceOnlyClose(position, {
      clientIntentId: randomUUID(),
      sessionId: session.id,
      now,
    });
    if (!fallback) {
      return NextResponse.json(
        { ok: false, error: 'Position is flat — nothing to close', executed: false },
        { status: 409 },
      );
    }
    intent = fallback;
    usedFallback = true;
  }

  const fill = await executeIntent(intent);

  await writeAnalysisLog({
    sessionId: session.id,
    source: 'safe-exit',
    severity: 'danger',
    message:
      `SAFE-EXIT fired: ${intent.side} ${fill.sz} ${coin} @ $${fill.px} ` +
      `(${usedFallback ? 'market-close fallback — Claude offline/stale plan' : 'fresh plan'}, source=${fill.source}).`,
  });

  return NextResponse.json({
    ok: true,
    executed: fill.sz > 0,
    usedFallback,
    planFresh,
    planAgeMs: plan ? now - plan.updatedAt : null,
    fill,
  });
}
