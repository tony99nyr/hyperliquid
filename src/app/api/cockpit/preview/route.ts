/**
 * POST /api/cockpit/preview — create an operator PREVIEW of an OPEN position.
 *
 * The trader-drawer "Mirror this → Preview" (and any future cockpit-native
 * preview source) posts here. It builds the same risk-sized OPEN proposal as the
 * skill / self-service paths, but instead of executing it WRITES a 'preview' row
 * (origin='operator'). NOTHING executes here — a preview only ever fires later, on
 * the operator's explicit Approve in the popup (`/api/cockpit/preview/decide`).
 *
 * THE LOAD-BEARING IDEMPOTENCY GUARDRAIL: the proposal's `clientIntentId` is
 * minted HERE, at creation, and stored on the intent. The execute route reuses it
 * verbatim (never re-mints) so a double-click / retry dedupes in persistFill and
 * can never double-fire.
 *
 * Guards mirror open-position: admin-auth → same-origin → rate-limit. No LIVE
 * typed-phrase here (creating a preview is harmless); the stronger LIVE confirm is
 * enforced at EXECUTE time, on the validated stored intent.
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminAuth, getClientIdentifier } from '@/lib/infrastructure/auth/auth';
import { isSameOrigin } from '@/lib/infrastructure/auth/same-origin';
import { checkRateLimit } from '@/lib/infrastructure/rate-limiting/in-memory-rate-limit';
import { getActiveSession, openSession } from '@/lib/cockpit/session-service';
import { fetchAllMids } from '@/lib/hyperliquid/hyperliquid-info-service';
import { createPreview } from '@/lib/cockpit/pending-actions-service';
import { buildOpenProposal } from '@/lib/skills/open-position-business-logic';
import { resolveCoinMaxLeverage, serverValidateLeverage } from '@/lib/trading/leverage-business-logic';
import { getTradingMode } from '@/lib/env/mode';
import { writeAnalysisLog } from '@/lib/cockpit/analysis-log-service';
import { randomUUID } from 'node:crypto';
import type { PendingActionDisplay } from '@/types/cockpit';

export const dynamic = 'force-dynamic';

/** Creating a preview is cheap + deliberate: 20/min per client is ample. */
const PREVIEW_MAX_PER_MIN = 20;

interface PreviewBody {
  coin?: unknown;
  side?: unknown;
  riskUsd?: unknown;
  stopFrac?: unknown;
  entryPx?: unknown;
  leverage?: unknown;
  thesis?: unknown;
  /** Optional leader address — recorded for the "mirror" rationale + display. */
  leaderAddress?: unknown;
}

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
  const limit = checkRateLimit(`preview:${getClientIdentifier(request)}`, PREVIEW_MAX_PER_MIN, 60_000);
  if (!limit.allowed) {
    return NextResponse.json({ ok: false, error: 'Too many requests' }, { status: 429 });
  }

  let body: PreviewBody;
  try {
    body = (await request.json()) as PreviewBody;
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid request body' }, { status: 400 });
  }

  const coin = typeof body.coin === 'string' ? body.coin.trim().toUpperCase() : '';
  const side = body.side === 'buy' || body.side === 'sell' ? body.side : null;
  const riskUsd = num(body.riskUsd) ?? 100; // default $100 risk for a one-tap mirror
  const stopFrac = num(body.stopFrac) ?? 0.05; // default 5% stop
  let entryPx = num(body.entryPx);
  const thesis = typeof body.thesis === 'string' ? body.thesis : '';
  const leaderAddress = typeof body.leaderAddress === 'string' ? body.leaderAddress.trim() : '';

  if (!coin) return NextResponse.json({ ok: false, error: 'coin required' }, { status: 400 });
  if (!side) return NextResponse.json({ ok: false, error: 'side must be buy or sell' }, { status: 400 });

  // entryPx is optional: a one-tap "Mirror this" sends none, so fetch the live HL
  // mark server-side. The EntryModal/self-service path may still send its own.
  if (entryPx == null || entryPx <= 0) {
    try {
      const mids = await fetchAllMids();
      const mid = mids[coin];
      if (Number.isFinite(mid) && mid > 0) entryPx = mid;
    } catch {
      // fall through to the error below
    }
  }
  if (entryPx == null || entryPx <= 0) {
    return NextResponse.json({ ok: false, error: `live mark unavailable for ${coin}` }, { status: 400 });
  }
  if (riskUsd == null || riskUsd <= 0) {
    return NextResponse.json({ ok: false, error: 'riskUsd must be positive' }, { status: 400 });
  }
  if (stopFrac == null || stopFrac <= 0 || stopFrac >= 1) {
    return NextResponse.json({ ok: false, error: 'stopFrac must be in (0, 1)' }, { status: 400 });
  }

  // SERVER-VALIDATE leverage to [1, coinMax] (the popup re-validates on execute too).
  const coinMax = resolveCoinMaxLeverage(coin, null);
  const leverage = serverValidateLeverage(body.leverage, coinMax, 1);

  const mode = getTradingMode();
  let session = await getActiveSession();
  let sessionOpened = false;
  if (!session) {
    session = await openSession({ mode, title: `${coin} ${side}`, leaderAddress: leaderAddress || null });
    sessionOpened = true;
  }

  // Build the OPEN intent via the SHARED builder. The clientIntentId minted HERE
  // is the stable idempotency key reused verbatim by the execute route.
  const now = Date.now();
  const shortLeader = leaderAddress ? `${leaderAddress.slice(0, 6)}…${leaderAddress.slice(-4)}` : '';
  const thesisText =
    thesis.trim() ||
    (leaderAddress
      ? `mirror ${shortLeader} ${side === 'buy' ? 'long' : 'short'} ${coin}`
      : `Manual ${side === 'buy' ? 'long' : 'short'} ${coin}`);
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
    thesis: thesisText,
  });
  if (proposal.warnings.length > 0) {
    return NextResponse.json(
      { ok: false, error: `Unsafe setup: ${proposal.warnings.join(' ')}` },
      { status: 422 },
    );
  }

  // Assemble the popup display (same shape the skill path builds). coinMax was
  // resolved server-side; the leader address drives the "following" chip + the
  // Match-leader preset on the popup's leverage control.
  const display: PendingActionDisplay = {
    coin,
    side,
    sz: proposal.intent.sz,
    estPx: entryPx,
    stopPx: proposal.stopPx,
    rationale: proposal.rationale,
    leverage,
    coinMaxLeverage: coinMax,
    leaderLeverage: null,
    leaderAddress: leaderAddress || null,
  };

  const preview = await createPreview({
    sessionId: session.id,
    kind: 'entry',
    mode,
    proposal: { intent: proposal.intent, display },
  });

  try {
    await writeAnalysisLog({
      sessionId: session.id,
      source: 'preview',
      severity: 'info',
      message:
        `PREVIEW created: ${side} ${proposal.intent.sz} ${coin} ` +
        `(${leverage}x, notional $${proposal.notionalUsd}, risk $${proposal.dollarRisk}` +
        `${leaderAddress ? `, mirror ${shortLeader}` : ''}). Awaiting operator approval.`,
    });
  } catch {
    // non-critical
  }

  return NextResponse.json({
    ok: true,
    previewId: preview.id,
    sessionId: session.id,
    sessionOpened,
    leverage,
    stopPx: proposal.stopPx,
    notionalUsd: proposal.notionalUsd,
    dollarRisk: proposal.dollarRisk,
  });
}
