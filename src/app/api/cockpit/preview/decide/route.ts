/**
 * POST /api/cockpit/preview/decide — the operator decides an operator PREVIEW.
 *
 * Body: { id, decision: 'execute' | 'discard', leverage?, confirmPhrase? }.
 *
 * This is the ONLY thing that fires an operator preview — NO-AUTO-FIRE is
 * preserved: the route is reached only on the operator's explicit Approve
 * (execute) or Discard click. Claude can annotate a preview but can NEVER reach
 * this path.
 *
 * EXECUTE — route-driven (no polling skill watches operator rows), built on the
 * guardrails the design review surfaced:
 *   1. server-validate the operator-chosen leverage to [1, coinMax] (never trust
 *      the client) and, in LIVE, recompute the typed confirm phrase from the
 *      STORED intent (parity with open-position / approve);
 *   2. ATOMIC CLAIM preview→'executing' (guarded on status='preview' AND
 *      origin='operator') — a double-click loses the claim ⇒ 409, can't double-fire;
 *   3. executeIntent on the CLAIMED intent, whose clientIntentId was minted at
 *      preview CREATION (reused verbatim) — persistFill dedupe is the second
 *      backstop against a double-fire;
 *   4. finalize 'executing'→'executed' (a terminal state DISTINCT from the skill
 *      path's 'approved'); on failure REVERT to 'preview' so the operator can retry
 *      (safe — the stable clientIntentId makes the retry idempotent).
 *
 * DISCARD — preview→'rejected'. Never executes.
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminAuth, getClientIdentifier } from '@/lib/infrastructure/auth/auth';
import { isSameOrigin } from '@/lib/infrastructure/auth/same-origin';
import { checkRateLimit } from '@/lib/infrastructure/rate-limiting/in-memory-rate-limit';
import {
  getPendingAction,
  claimPreviewForExecute,
  finalizeExecutedPreview,
  revertClaimedPreview,
  discardPreview,
} from '@/lib/cockpit/pending-actions-service';
import { executeIntent } from '@/lib/trading/fill-source';
import { serverValidateLeverage } from '@/lib/trading/leverage-business-logic';
import { getTradingMode } from '@/lib/env/mode';
import { entryLiveConfirmPhrase } from '@/app/cockpit/components/entry-modal-helpers';
import { writeAnalysisLog } from '@/lib/cockpit/analysis-log-service';
import { extractErrorMessage } from '@/lib/infrastructure/logging/logger';

export const dynamic = 'force-dynamic';

const DECIDE_MAX_PER_MIN = 20;

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!(await verifyAdminAuth(request))) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
  if (!isSameOrigin(request)) {
    return NextResponse.json({ ok: false, error: 'Cross-origin request rejected' }, { status: 403 });
  }
  const limit = checkRateLimit(`preview-decide:${getClientIdentifier(request)}`, DECIDE_MAX_PER_MIN, 60_000);
  if (!limit.allowed) {
    return NextResponse.json({ ok: false, error: 'Too many requests' }, { status: 429 });
  }

  let id = '';
  // Default to NEITHER — an ambiguous/garbage decision must NOT fall through to
  // the execute (fire) path. Only an explicit 'execute' or 'discard' is honored.
  let decision: 'execute' | 'discard' | null = null;
  let rawLeverage: unknown;
  let confirmPhrase = '';
  try {
    const body = (await request.json()) as {
      id?: unknown;
      decision?: unknown;
      leverage?: unknown;
      confirmPhrase?: unknown;
    };
    id = typeof body.id === 'string' ? body.id : '';
    decision = body.decision === 'execute' ? 'execute' : body.decision === 'discard' ? 'discard' : null;
    rawLeverage = body.leverage;
    confirmPhrase = typeof body.confirmPhrase === 'string' ? body.confirmPhrase : '';
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid request body' }, { status: 400 });
  }
  if (!id) return NextResponse.json({ ok: false, error: 'id required' }, { status: 400 });
  if (decision === null) {
    return NextResponse.json({ ok: false, error: "decision must be 'execute' or 'discard'" }, { status: 400 });
  }

  // ---- DISCARD -------------------------------------------------------------
  if (decision === 'discard') {
    const ok = await discardPreview(id);
    if (!ok) {
      return NextResponse.json(
        { ok: false, error: 'Preview is not discardable (already decided or not found)' },
        { status: 409 },
      );
    }
    return NextResponse.json({ ok: true, status: 'rejected' });
  }

  // ---- EXECUTE -------------------------------------------------------------
  // Read first so we can validate leverage + the LIVE phrase against the STORED
  // (server-authored) intent BEFORE claiming. The claim itself re-asserts the
  // status/origin atomically, so this read is not a TOCTOU hole.
  const action = await getPendingAction(id);
  if (!action || action.status !== 'preview' || action.origin !== 'operator') {
    return NextResponse.json(
      { ok: false, error: 'Preview is not executable (already decided, not found, or not an operator preview)' },
      { status: 409 },
    );
  }

  const { display, intent } = action.proposal;

  // Defense-in-depth: never execute a malformed stored intent (service-role
  // authored, but validate before it reaches executeIntent).
  if (!intent.coin || !(intent.sz > 0)) {
    return NextResponse.json({ ok: false, error: 'Preview intent is malformed' }, { status: 422 });
  }

  // Mode must match the mode the preview was AUTHORED under. If TRADING_MODE
  // flipped (paper⇄live) between create and approve, refuse — never silently
  // execute a paper-authored preview as live (or vice-versa).
  const mode = getTradingMode();
  if (action.mode !== mode) {
    return NextResponse.json(
      {
        ok: false,
        error: `Preview was created in ${action.mode} mode but the system is now ${mode} — discard and recreate it.`,
      },
      { status: 409 },
    );
  }

  const isOpening = intent.reduceOnly !== true;
  const coinMax = display.coinMaxLeverage ?? 1;
  const fallbackLev = intent.leverage ?? 1;
  const validatedLeverage = isOpening
    ? serverValidateLeverage(rawLeverage, coinMax, fallbackLev)
    : null;

  // LIVE needs the STRONGER confirm: the exact "side coin" phrase (size omitted —
  // it recomputes per tick and made the phrase a moving target; see helper).
  if (action.mode === 'live') {
    const required = entryLiveConfirmPhrase(display.side, display.coin);
    if (confirmPhrase.trim().toLowerCase() !== required) {
      return NextResponse.json(
        { ok: false, error: `LIVE confirm phrase mismatch — type exactly: ${required}` },
        { status: 422 },
      );
    }
  }

  // ATOMIC CLAIM: preview→executing (+stamp leverage). A losing claim ⇒ 409.
  const claimed = await claimPreviewForExecute(id, validatedLeverage);
  if (!claimed) {
    return NextResponse.json(
      { ok: false, error: 'Preview already being executed or decided' },
      { status: 409 },
    );
  }

  // Execute the CLAIMED intent (stable clientIntentId reused → dedupe-safe).
  try {
    const fill = await executeIntent(claimed.proposal.intent);
    await finalizeExecutedPreview(id);
    try {
      await writeAnalysisLog({
        sessionId: claimed.sessionId,
        source: 'preview',
        severity: 'info',
        message:
          `PREVIEW EXECUTED: ${display.side} ${fill.sz} ${display.coin} @ $${fill.px} ` +
          `(${validatedLeverage ?? fallbackLev}x, source=${fill.source}).`,
      });
    } catch {
      // non-critical
    }
    return NextResponse.json({ ok: true, status: 'executed', executed: fill.sz > 0, fill });
  } catch (err) {
    // Execution failed — REVERT the claim so the operator can retry (the stable
    // clientIntentId makes a retry idempotent if a fill actually landed).
    await revertClaimedPreview(id).catch(() => {});
    return NextResponse.json(
      { ok: false, error: `Execution failed: ${extractErrorMessage(err)}` },
      { status: 500 },
    );
  }
}
