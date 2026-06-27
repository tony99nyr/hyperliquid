/**
 * POST /api/cockpit/ladder/arm — ARM a draft ladder (the authorization gate).
 *
 *   POST { ladderId, confirmPhrase? }  → validate → snapshot live state → status='armed'.
 *
 * Arming is the AUTHORIZATION moment (architecture §3): it moves NO money — it flips the
 * ladder to 'armed' so the watcher + fire route (P1d) may later execute its pre-agreed
 * rungs. The full open gate applies (admin + same-origin + rate-limit). For a LIVE-mode
 * ladder the operator must type the exact `arm <id8>` phrase, AND LADDER_LIVE_ENABLED
 * must be on (paper-first kill-switch — a live ladder can't even be armed while it's off).
 *
 * Safety gates here:
 *   - author MUST be 'operator' (defense-in-depth with the §3.6 DB CHECK — a scout
 *     ladder can never be armed);
 *   - the full §2/§3.5 static validation (validateLadderForArm) must pass — no warnings;
 *   - a precondition snapshot (§3.7) of live position state is hashed + stored so the
 *     fire route can refuse a drifted fire;
 *   - the draft→armed transition is conditional (armLadder guards on status='draft') so
 *     a double-arm is a no-op.
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminAuth, getClientIdentifier } from '@/lib/infrastructure/auth/auth';
import { isSameOrigin } from '@/lib/infrastructure/auth/same-origin';
import { checkRateLimit } from '@/lib/infrastructure/rate-limiting/in-memory-rate-limit';
import { isLadderLiveEnabled } from '@/lib/ladder/ladder-flags';
import { getActiveSession } from '@/lib/cockpit/session-service';
import { getLadderWithRungs, armLadder } from '@/lib/ladder/ladder-service';
import {
  validateLadderForArm,
  resolveArmRung,
  ladderArmConfirmPhrase,
  type ArmRung,
} from '@/lib/ladder/ladder-arm-business-logic';
import { buildPreconditionSnapshot, hashPreconditionSnapshot, type LivePositionState } from '@/lib/ladder/ladder-risk-business-logic';
import { resolveCoinMaxLeverage } from '@/lib/trading/leverage-business-logic';
import { fetchClearinghouseState } from '@/lib/hyperliquid/hyperliquid-info-service';
import { getHlAccountAddress } from '@/lib/auto-exit/auto-exit-config';
import { writeAnalysisLog } from '@/lib/cockpit/analysis-log-service';
import { extractErrorMessage } from '@/lib/infrastructure/logging/logger';

export const dynamic = 'force-dynamic';

const ARM_MAX_PER_MIN = 10;

/** Live position state for the coins a rung DEPENDS on (add/reduce/close). For a LIVE
 *  ladder we read the real HL account; a PAPER ladder gets an empty set here (paper
 *  preconditions are re-derived from paper positions at fire — P1d). */
async function liveStateForLadder(mode: string, rungs: ArmRung[]): Promise<LivePositionState[]> {
  const dependsOnLive = rungs.some((r) => r.action === 'add' || r.action === 'reduce' || r.action === 'close');
  if (mode !== 'live' || !dependsOnLive) return [];
  const address = getHlAccountAddress();
  if (!address) return [];
  const state = await fetchClearinghouseState(address, { uncached: true });
  return state.positions.map((p) => ({ coin: p.coin, side: p.side, leverage: p.leverage }));
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!(await verifyAdminAuth(request))) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
  if (!isSameOrigin(request)) {
    return NextResponse.json({ ok: false, error: 'Cross-origin request rejected' }, { status: 403 });
  }
  const limit = checkRateLimit(`ladder-arm:${getClientIdentifier(request)}`, ARM_MAX_PER_MIN, 60_000);
  if (!limit.allowed) return NextResponse.json({ ok: false, error: 'Too many requests' }, { status: 429 });

  let body: { ladderId?: unknown; confirmPhrase?: unknown };
  try { body = (await request.json()) as typeof body; } catch { return NextResponse.json({ ok: false, error: 'Invalid body' }, { status: 400 }); }
  const ladderId = typeof body.ladderId === 'string' ? body.ladderId.trim() : '';
  if (!ladderId) return NextResponse.json({ ok: false, error: 'ladderId required' }, { status: 400 });

  let ladder;
  try {
    ladder = await getLadderWithRungs(ladderId);
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMessage(err) }, { status: 502 });
  }
  if (!ladder) return NextResponse.json({ ok: false, error: 'ladder not found' }, { status: 404 });
  if (ladder.status !== 'draft') return NextResponse.json({ ok: false, error: `ladder is '${ladder.status}', only a draft can be armed` }, { status: 409 });
  // Defense-in-depth with the DB CHECK: a scout-authored ladder can NEVER be armed.
  if (ladder.author !== 'operator') return NextResponse.json({ ok: false, error: 'only operator-authored ladders can be armed' }, { status: 403 });

  // Capability gate: a LIVE ladder can't be armed while LADDER_LIVE_ENABLED is off.
  // (This is the ARM capability — autonomous firing is the separate LADDER_AUTOFIRE
  // switch the fire route checks; arming does not move money.)
  if (ladder.mode === 'live' && !isLadderLiveEnabled()) {
    return NextResponse.json({ ok: false, error: 'LIVE ladders are disabled (LADDER_LIVE_ENABLED off).' }, { status: 403 });
  }

  // Resolve rungs + run the full static validation against live state.
  const armRungs = ladder.rungs.map(resolveArmRung);
  const expiresAtMs = ladder.expiresAt ? Date.parse(ladder.expiresAt) : null;
  const validation = validateLadderForArm({
    title: ladder.title,
    thesis: ladder.thesis,
    expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : null,
    caps: { maxTotalNotionalUsd: ladder.maxTotalNotionalUsd, maxTotalLossUsd: ladder.maxTotalLossUsd },
    rungs: armRungs,
    now: Date.now(),
    coinMaxLeverage: (coin) => resolveCoinMaxLeverage(coin, null),
  });
  if (validation.warnings.length > 0) {
    return NextResponse.json({ ok: false, error: 'Ladder is not safe to arm', warnings: validation.warnings }, { status: 422 });
  }

  // LIVE arm needs the exact typed phrase (the authorization moment).
  if (ladder.mode === 'live') {
    const typed = typeof body.confirmPhrase === 'string' ? body.confirmPhrase.trim().toLowerCase() : '';
    const required = ladderArmConfirmPhrase(ladder);
    if (typed !== required) {
      return NextResponse.json({ ok: false, error: `LIVE arm confirm phrase mismatch — type exactly: ${required}` }, { status: 422 });
    }
  }

  // Precondition snapshot (§3.7) over the coins this ladder depends on. This is a
  // BASELINE captured before the transition — the fire route (P1d) re-derives + compares
  // it at fire, so any drift after this point (the small TOCTOU window to armLadder, or
  // anything later) is caught there. The snapshot is not itself a freshness gate.
  let live: LivePositionState[];
  try {
    live = await liveStateForLadder(ladder.mode, armRungs);
  } catch (err) {
    return NextResponse.json({ ok: false, error: `couldn't read live position state — retry (${extractErrorMessage(err)})` }, { status: 502 });
  }
  const snapshot = buildPreconditionSnapshot(ladder.rungs, live);
  const preconditionHash = hashPreconditionSnapshot(snapshot);

  // Deterministic per-rung cloid (= ladderId:rungId) for exchange-level double-fire rejection.
  const cloidByRungId: Record<string, string> = {};
  for (const r of ladder.rungs) cloidByRungId[r.id] = `${ladder.id}:${r.id}`;

  try {
    const armed = await armLadder(ladder.id, { preconditionHash, expiresAtMs: expiresAtMs as number, cloidByRungId });
    if (!armed) return NextResponse.json({ ok: false, error: 'ladder was already armed/disarmed (lost the race)' }, { status: 409 });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMessage(err) }, { status: 502 });
  }

  const session = await getActiveSession();
  if (session) {
    await writeAnalysisLog({
      sessionId: session.id,
      source: 'ladder-arm',
      severity: 'info',
      message: `ARMED ladder ${ladder.id.slice(0, 8)} "${ladder.title}" (${ladder.mode}, ${ladder.rungs.length} rungs) · precondition ${preconditionHash} · snapshot [${snapshot || 'none'}].`,
    }).catch(() => {});
  }

  return NextResponse.json({ ok: true, ladderId: ladder.id, preconditionHash, riskPreview: validation.risk });
}
