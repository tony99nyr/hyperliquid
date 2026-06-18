/**
 * POST /api/cockpit/open-position — the SELF-SERVICE manual entry path.
 *
 * The "＋ New Position" entry modal posts here. This is the cockpit-native parallel
 * to the Claude-skill → pending_action → approval-popup path: BOTH still work, and
 * BOTH are NO-AUTO-FIRE. Nothing executes until the operator explicitly Approves the
 * entry form — this route is only ever reached on that click.
 *
 * The route:
 *   1. admin-auth → same-origin → rate-limit (mirrors safe-exit / approve);
 *   2. validates the setup + SERVER-VALIDATES leverage to [1, coinMax] (never trust
 *      the client); for LIVE it ALSO requires the exact "side sz coin" typed phrase
 *      (the stronger live confirm, parity with the approval popup + terminal gate);
 *   3. builds the OPEN TradeIntent (reduceOnly:false) via the SHARED buildOpenProposal
 *      (so the self-service path sizes identically to the skill path);
 *   4. uses the ACTIVE session if one exists, else openSession() in the server's
 *      trading mode (paper now / live later — the same seam everything rides);
 *   5. calls executeIntent (the ONE seam) → fill → returns it.
 *
 * The opened position then renders live in Open Positions via the existing realtime
 * subscription. Service-role writes happen server-side via executeIntent / the
 * session service — never the browser.
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminAuth, getClientIdentifier } from '@/lib/infrastructure/auth/auth';
import { isSameOrigin } from '@/lib/infrastructure/auth/same-origin';
import { checkRateLimit } from '@/lib/infrastructure/rate-limiting/in-memory-rate-limit';
import { getActiveSession, openSession } from '@/lib/cockpit/session-service';
import { executeIntent } from '@/lib/trading/fill-source';
import { buildOpenProposal } from '@/lib/skills/open-position-business-logic';
import {
  resolveCoinMaxLeverage,
  serverValidateLeverage,
} from '@/lib/trading/leverage-business-logic';
import { getTradingMode } from '@/lib/env/mode';
import { entryLiveConfirmPhrase } from '@/app/cockpit/components/entry-modal-helpers';
import { writeAnalysisLog } from '@/lib/cockpit/analysis-log-service';
import { randomUUID } from 'node:crypto';

export const dynamic = 'force-dynamic';

/** Opening orders are deliberate + rare: 10/min per client is ample. */
const OPEN_POSITION_MAX_PER_MIN = 10;

interface OpenBody {
  coin?: unknown;
  side?: unknown;
  riskUsd?: unknown;
  stopFrac?: unknown;
  entryPx?: unknown;
  leverage?: unknown;
  thesis?: unknown;
  /** LIVE only: the exact "side sz coin" confirm phrase the operator typed. */
  confirmPhrase?: unknown;
}

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  // 1) Auth FIRST (an unauthenticated caller always gets 401).
  if (!(await verifyAdminAuth(request))) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
  // 2) CSRF defense-in-depth: reject cross-origin browser POSTs.
  if (!isSameOrigin(request)) {
    return NextResponse.json({ ok: false, error: 'Cross-origin request rejected' }, { status: 403 });
  }
  // 3) Rate limit BEFORE building any intent / executing anything.
  const limit = checkRateLimit(
    `open-position:${getClientIdentifier(request)}`,
    OPEN_POSITION_MAX_PER_MIN,
    60_000,
  );
  if (!limit.allowed) {
    return NextResponse.json({ ok: false, error: 'Too many requests' }, { status: 429 });
  }

  let body: OpenBody;
  try {
    body = (await request.json()) as OpenBody;
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid request body' }, { status: 400 });
  }

  const coin = typeof body.coin === 'string' ? body.coin.trim().toUpperCase() : '';
  const side = body.side === 'buy' || body.side === 'sell' ? body.side : null;
  const riskUsd = num(body.riskUsd);
  const stopFrac = num(body.stopFrac);
  const entryPx = num(body.entryPx);
  const thesis = typeof body.thesis === 'string' ? body.thesis : '';

  if (!coin) return NextResponse.json({ ok: false, error: 'coin required' }, { status: 400 });
  if (!side) return NextResponse.json({ ok: false, error: 'side must be buy or sell' }, { status: 400 });
  if (entryPx == null || entryPx <= 0) {
    return NextResponse.json({ ok: false, error: 'entryPx required (live mark unavailable)' }, { status: 400 });
  }
  if (riskUsd == null || riskUsd <= 0) {
    return NextResponse.json({ ok: false, error: 'riskUsd must be positive' }, { status: 400 });
  }
  if (stopFrac == null || stopFrac <= 0 || stopFrac >= 1) {
    return NextResponse.json({ ok: false, error: 'stopFrac must be in (0, 1)' }, { status: 400 });
  }

  // SERVER-VALIDATE leverage to [1, coinMax] (don't trust the client). The
  // coin max is resolved server-side; the entry form's slider ceiling is advisory.
  const coinMax = resolveCoinMaxLeverage(coin, null);
  const leverage = serverValidateLeverage(body.leverage, coinMax, 1);

  // Resolve the session: reuse the active one, else open a fresh paper/live
  // session in the SERVER'S trading mode (the env-gated seam — never client-set).
  const mode = getTradingMode();
  let session = await getActiveSession();
  let sessionOpened = false;
  if (!session) {
    session = await openSession({ mode, title: `${coin} ${side}`, leaderAddress: null });
    sessionOpened = true;
  }

  // Build the OPEN intent via the SHARED builder (reduceOnly:false, risk-based
  // sizing). A fresh idempotency key + clock are minted here (server-authoritative).
  const now = Date.now();
  const proposal = buildOpenProposal({
    sessionId: session.id,
    coin,
    side,
    entryPx,
    riskUsd,
    stopDistanceFrac: stopFrac,
    leverage,
    clientIntentId: randomUUID(),
    now,
    thesis: thesis.trim() || `Manual ${side === 'buy' ? 'long' : 'short'} ${coin}`,
  });
  if (proposal.warnings.length > 0) {
    return NextResponse.json(
      { ok: false, error: `Unsafe setup: ${proposal.warnings.join(' ')}` },
      { status: 422 },
    );
  }

  // LIVE needs the STRONGER confirm: the exact "side sz coin" phrase, computed
  // server-side from the VALIDATED intent (so a tampered client phrase can't pass).
  if (mode === 'live') {
    const typed = typeof body.confirmPhrase === 'string' ? body.confirmPhrase.trim().toLowerCase() : '';
    const required = entryLiveConfirmPhrase(side, proposal.intent.sz, coin);
    if (typed !== required) {
      return NextResponse.json(
        { ok: false, error: `LIVE confirm phrase mismatch — type exactly: ${required}` },
        { status: 422 },
      );
    }
  }

  // Execute through the ONE seam (paper now / live later). reduceOnly:false — this
  // is the only cockpit path that OPENS exposure, and it only runs on an explicit
  // operator Approve (no-auto-fire preserved).
  const fill = await executeIntent(proposal.intent);

  // Best-effort analysis-log line; a log failure must NOT 500 a successful open.
  try {
    await writeAnalysisLog({
      sessionId: session.id,
      source: 'open-position',
      severity: 'info',
      message:
        `MANUAL ENTRY: ${side} ${fill.sz} ${coin} @ $${fill.px} ` +
        `(${leverage}x, notional $${proposal.notionalUsd}, risk $${proposal.dollarRisk}, source=${fill.source}).`,
    });
  } catch {
    // swallow — the entry succeeded; logging is non-critical.
  }

  return NextResponse.json({
    ok: true,
    executed: fill.sz > 0,
    sessionId: session.id,
    sessionOpened,
    leverage,
    stopPx: proposal.stopPx,
    notionalUsd: proposal.notionalUsd,
    dollarRisk: proposal.dollarRisk,
    fill,
  });
}
