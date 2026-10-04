/**
 * POST /api/cockpit/ladder/reanchor — re-price a STALE DRAFT to the live mark.
 *
 *   POST { ladderId } → scale every pending rung's price levels by (live mark / stored
 *   anchor), stamp the new anchor + an audit note on the thesis.
 *
 * This is a DRAFT-ONLY edit: it moves NO money, arms nothing, and never touches an
 * armed ladder (armed prices are consented — the arm route re-validates and the
 * operator re-confirms AFTER a re-anchor). It exists because the drafters price every
 * rung as a ratio of the detection mark; when price runs through a gate before the
 * operator arms, the instant-fire guard (correctly) refuses and the draft was
 * un-armable without a manual DB edit (retro 2026-10-03, third incident).
 *
 * Refusals by design:
 *   - no stored anchor (manual draft → levels are structural, scaling is wrong);
 *   - multi-coin ladder (mark ambiguity);
 *   - drift beyond ±50% (premise dead — re-draft, don't scale);
 *   - a mids outage (unlike the arm guard, a fresh mark is a HARD requirement here).
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminAuth, getClientIdentifier } from '@/lib/infrastructure/auth/auth';
import { isSameOrigin } from '@/lib/infrastructure/auth/same-origin';
import { checkRateLimit } from '@/lib/infrastructure/rate-limiting/in-memory-rate-limit';
import { getLadderWithRungs, applyDraftReanchor } from '@/lib/ladder/ladder-service';
import { reanchorLadderRungs, reanchorThesisNote, stripReanchorNotes } from '@/lib/ladder/ladder-reanchor-business-logic';
import { fetchAllMids } from '@/lib/hyperliquid/hyperliquid-info-service';
import { getActiveSession } from '@/lib/cockpit/session-service';
import { writeAnalysisLog } from '@/lib/cockpit/analysis-log-service';
import { extractErrorMessage } from '@/lib/infrastructure/logging/logger';

export const dynamic = 'force-dynamic';

const REANCHOR_MAX_PER_MIN = 10;

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!(await verifyAdminAuth(request))) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
  if (!isSameOrigin(request)) {
    return NextResponse.json({ ok: false, error: 'Cross-origin request rejected' }, { status: 403 });
  }
  const limit = checkRateLimit(`ladder-reanchor:${getClientIdentifier(request)}`, REANCHOR_MAX_PER_MIN, 60_000);
  if (!limit.allowed) return NextResponse.json({ ok: false, error: 'Too many requests' }, { status: 429 });

  let body: { ladderId?: unknown };
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
  if (ladder.status !== 'draft') {
    return NextResponse.json({ ok: false, error: `ladder is '${ladder.status}' — only a draft can be re-anchored (armed prices are consented)` }, { status: 409 });
  }
  if (ladder.author !== 'operator') return NextResponse.json({ ok: false, error: 'only operator-authored ladders can be re-anchored' }, { status: 403 });
  if (ladder.anchorPx == null) {
    return NextResponse.json(
      { ok: false, error: 'this draft has no stored anchor (manually built) — its levels are structural, not ratios of a mark. Edit or re-draft instead of scaling.' },
      { status: 422 },
    );
  }
  const coins = Array.from(new Set(ladder.rungs.map((r) => r.coin.trim().toUpperCase())));
  if (coins.length !== 1) {
    return NextResponse.json({ ok: false, error: 'multi-coin ladder — re-anchor supports single-coin drafts only' }, { status: 422 });
  }

  // A fresh mark is a HARD requirement: re-anchoring to a stale/absent price would
  // rebuild the exact stale-gate problem this route exists to fix.
  let markPx: number;
  try {
    const mids = await fetchAllMids();
    markPx = Number(mids[coins[0]]);
  } catch (err) {
    return NextResponse.json({ ok: false, error: `couldn't fetch the live mark — retry (${extractErrorMessage(err)})` }, { status: 502 });
  }
  if (!Number.isFinite(markPx) || markPx <= 0) {
    return NextResponse.json({ ok: false, error: `no live mark for ${coins[0]} — retry` }, { status: 502 });
  }

  const outcome = reanchorLadderRungs(ladder.rungs, ladder.anchorPx, markPx);
  if (!outcome.ok) return NextResponse.json({ ok: false, error: outcome.reason }, { status: 422 });

  // Repeated re-anchors REPLACE the previous note (unbounded thesis growth otherwise);
  // the per-event audit trail is the analysis_log write below.
  const note = reanchorThesisNote(ladder.anchorPx, markPx, new Date().toISOString());
  const base = ladder.thesis ? stripReanchorNotes(ladder.thesis) : '';
  const thesis = base ? `${base}\n\n${note}` : note;

  let result: Awaited<ReturnType<typeof applyDraftReanchor>>;
  try {
    result = await applyDraftReanchor(ladder.id, { newAnchorPx: markPx, thesis, patches: outcome.patches });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMessage(err) }, { status: 502 });
  }
  if (result !== 'applied') {
    return NextResponse.json({ ok: false, error: `ladder stopped being a ${result === 'not-found' ? 'row' : 'draft'} mid-request — nothing was changed` }, { status: 409 });
  }

  const session = await getActiveSession();
  if (session) {
    await writeAnalysisLog({
      sessionId: session.id,
      source: 'ladder-reanchor',
      severity: 'info',
      message: `RE-ANCHORED draft ${ladder.id.slice(0, 8)} "${ladder.title}": anchor ${ladder.anchorPx} → ${markPx} (×${outcome.factor.toFixed(4)}), ${outcome.patches.length} rung(s) re-priced.`,
    }).catch(() => {});
  }

  return NextResponse.json({ ok: true, ladderId: ladder.id, anchorPx: markPx, factor: outcome.factor, rungsRepriced: outcome.patches.length });
}
