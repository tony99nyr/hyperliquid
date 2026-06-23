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
import { verifyAdminAuth, getClientIdentifier } from '@/lib/infrastructure/auth/auth';
import { isSameOrigin } from '@/lib/infrastructure/auth/same-origin';
import { checkRateLimit } from '@/lib/infrastructure/rate-limiting/in-memory-rate-limit';
import { getActiveSession } from '@/lib/cockpit/session-service';
import { loadPosition, loadOpenPositions } from '@/lib/cockpit/fill-persistence-service';
import { getSafeExitPlan } from '@/lib/cockpit/safe-exit-plan-service';
import { executeIntent } from '@/lib/trading/fill-source';
import {
  buildMarketReduceOnlyClose,
  isPlanFresh,
  planReducesPosition,
  DEFAULT_SAFE_EXIT_STALENESS_MS,
} from '@/lib/trading/safe-exit-business-logic';
import { writeAnalysisLog } from '@/lib/cockpit/analysis-log-service';
import { extractErrorMessage } from '@/lib/infrastructure/logging/logger';
import { randomUUID } from 'node:crypto';

export const dynamic = 'force-dynamic';

/** The panic button is rare-by-design: 5/min per client is ample. */
const SAFE_EXIT_MAX_PER_MIN = 5;

export async function POST(request: NextRequest): Promise<NextResponse> {
  // 1) Auth FIRST (an unauthenticated caller always gets 401).
  if (!(await verifyAdminAuth(request))) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
  // 2) CSRF defense-in-depth: reject cross-origin browser POSTs.
  if (!isSameOrigin(request)) {
    return NextResponse.json({ ok: false, error: 'Cross-origin request rejected' }, { status: 403 });
  }
  // 3) Rate limit BEFORE resolving any session / executing any intent.
  const limit = checkRateLimit(`safe-exit:${getClientIdentifier(request)}`, SAFE_EXIT_MAX_PER_MIN, 60_000);
  if (!limit.allowed) {
    return NextResponse.json({ ok: false, error: 'Too many requests' }, { status: 429 });
  }

  // Optional body: `all` (close EVERY open position), an explicit `coin` (otherwise
  // close the session's single open position), and an optional close `fraction` in
  // (0,1] for a partial "Reduce". Tolerate an empty/invalid body.
  let coinOverride: string | undefined;
  let fraction: number | undefined;
  let closeAll = false;
  try {
    const body = (await request.json()) as { coin?: unknown; fraction?: unknown; all?: unknown };
    if (body.all === true) closeAll = true;
    if (typeof body.coin === 'string' && body.coin.trim()) coinOverride = body.coin.trim().toUpperCase();
    if (typeof body.fraction === 'number' && body.fraction > 0 && body.fraction < 1) {
      fraction = body.fraction;
    }
  } catch {
    // no body — fine.
  }

  const session = await getActiveSession();
  if (!session) {
    return NextResponse.json({ ok: false, error: 'No active session' }, { status: 409 });
  }

  // CLOSE-ALL: market reduce-only close EVERY open position in the session. Each
  // close is isolated (one failing coin does not abort the rest) and the response
  // reports the REAL per-coin outcome — never an optimistic "closed N" that didn't
  // actually fill (the bug behind a panic button falsely reporting success).
  if (closeAll) {
    const open = (await loadOpenPositions(session.id)).filter((p) => p.side !== 'flat' && p.sz > 0);
    if (open.length === 0) {
      return NextResponse.json({ ok: true, all: true, closed: 0, failed: 0, results: [], message: 'Already flat — nothing to close' });
    }
    const results: Array<{ coin: string; ok: boolean; sz?: number; px?: number; error?: string }> = [];
    for (const position of open) {
      const intent = buildMarketReduceOnlyClose(position, { clientIntentId: randomUUID(), sessionId: session.id, now: Date.now() });
      if (!intent) {
        results.push({ coin: position.coin, ok: false, error: 'position is flat' });
        continue;
      }
      try {
        const fill = await executeIntent(intent);
        const ok = fill.sz > 0;
        results.push({ coin: position.coin, ok, sz: fill.sz, px: fill.px });
        if (ok) {
          try {
            await writeAnalysisLog({ sessionId: session.id, source: 'safe-exit', severity: 'danger', message: `SAFE-EXIT ALL: closed ${fill.sz} ${position.coin} @ $${fill.px} (source=${fill.source}).` });
          } catch { /* non-critical */ }
        }
      } catch (err) {
        results.push({ coin: position.coin, ok: false, error: extractErrorMessage(err) });
      }
    }
    const closed = results.filter((r) => r.ok).length;
    const failed = results.length - closed;
    // 207 Multi-Status when some legs failed, so the UI shows partial reality.
    return NextResponse.json({ ok: failed === 0, all: true, closed, failed, results }, { status: failed === 0 ? 200 : 207 });
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

  // FRESH Claude plan → trust it, but HARDEN it against a position flip:
  //   (a) force reduceOnly=true (a panic exit can NEVER open/grow exposure);
  //   (b) the plan's coin+side must still REDUCE the live position (long→sell,
  //       short→buy). If the position flipped since the plan was armed, the
  //       stored intent would now ADD exposure — DISCARD it and use the
  //       mechanical market reduce-only close instead.
  // STALE/absent → also build the market close (the Claude-offline path).
  // Either way the session id is forced onto the intent and a fresh idempotency
  // key is minted.
  // A PARTIAL close (fraction < 1) is always a fresh mechanical reduce-only of
  // the live position — the armed plan describes a FULL close, so a partial
  // request must not ride it.
  let intent;
  let usedFallback: boolean;
  if (fraction === undefined && plan && planFresh && planReducesPosition(plan.intent, position)) {
    intent = {
      ...plan.intent,
      sessionId: session.id,
      clientIntentId: randomUUID(),
      createdAt: now,
      reduceOnly: true,
    };
    usedFallback = false;
  } else {
    const fallback = buildMarketReduceOnlyClose(position, {
      clientIntentId: randomUUID(),
      sessionId: session.id,
      now,
      fraction,
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

  // Execution can throw (HL rejects the order, agent-key/auth issue, no live mid).
  // Catch it → a CLEAR error instead of a 500, so the panic button surfaces what
  // actually happened rather than a generic failure.
  let fill;
  try {
    fill = await executeIntent(intent);
  } catch (err) {
    return NextResponse.json(
      { ok: false, executed: false, error: `Close failed: ${extractErrorMessage(err)}` },
      { status: 502 },
    );
  }

  // The trade has already executed and the fill is recorded by executeIntent.
  // A failed analysis-log write must NOT 500 the route and make a SUCCESSFUL
  // panic exit look like a failure to the operator — best-effort only.
  try {
    await writeAnalysisLog({
      sessionId: session.id,
      source: 'safe-exit',
      severity: 'danger',
      message:
        `${fraction === undefined ? 'SAFE-EXIT' : 'REDUCE'} fired: ${intent.side} ${fill.sz} ${coin} @ $${fill.px} ` +
        `(${fraction !== undefined ? `partial ${(fraction * 100).toFixed(0)}% reduce-only` : usedFallback ? 'market-close fallback — Claude offline/stale plan' : 'fresh plan'}, source=${fill.source}).`,
    });
  } catch {
    // swallow — the exit succeeded; logging is non-critical.
  }

  return NextResponse.json({
    ok: true,
    executed: fill.sz > 0,
    usedFallback,
    planFresh,
    planAgeMs: plan ? now - plan.updatedAt : null,
    fill,
  });
}
