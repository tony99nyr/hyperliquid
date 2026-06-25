/**
 * follow-match service (SERVICE ROLE, server-only) — PR-6 keep-matched staging.
 *
 * Given a leader's detected change (a leader_actions row), stage a PROTECTIVE
 * reduce-only matching action into the approval popup, sized from the operator's OWN
 * position. NO-AUTO-FIRE: this only creates a `preview` pending_action — the human
 * approves every fire through the existing preview→decide path; nothing executes here.
 *
 * SAFETY:
 *  - GATED OFF by default (FOLLOW_MATCH_ENABLED). Staging is a no-op unless enabled.
 *  - REDUCE-ONLY only: it can never open/grow exposure (buildMarketReduceOnlyClose).
 *  - Side/flip-guarded by the PURE planFollowMatch (never closes a correctly-aligned
 *    position; never matches the wrong side).
 *  - Idempotent: one stage per leader_action via the dedupe_key partial-unique index.
 */

import 'server-only';
import { getServiceRoleClient } from '@/lib/cockpit/supabase-server';
import { getTradingMode } from '@/lib/env/mode';
import { getActiveSession, openSession } from '@/lib/cockpit/session-service';
import { loadPosition } from '@/lib/cockpit/fill-persistence-service';
import { buildMarketReduceOnlyClose } from './safe-exit-business-logic';
import { createPreview } from '@/lib/cockpit/pending-actions-service';
import { endFollow } from '@/lib/cockpit/favorites-service';
import { planFollowMatch, type LeaderActionKind, type Side } from './follow-match-business-logic';

/** The follow keep-matched mechanism is OFF unless explicitly enabled (real money). */
export function isFollowMatchEnabled(): boolean {
  return process.env.FOLLOW_MATCH_ENABLED === 'true';
}

export interface StageResult {
  staged: boolean;
  reason: string;
  action?: 'reduce' | 'close';
}

interface LeaderActionRow {
  leader_address: string;
  coin: string;
  kind: string;
  prev_side: Side | null;
  new_side: Side | null;
  prev_size: number | null;
  new_size: number | null;
}

export async function stageFollowMatch(leaderActionId: string): Promise<StageResult> {
  if (!isFollowMatchEnabled()) {
    return { staged: false, reason: 'follow-match is disabled (FOLLOW_MATCH_ENABLED off)' };
  }
  const client = getServiceRoleClient();

  const { data: laData } = await client
    .from('leader_actions')
    .select('leader_address, coin, kind, prev_side, new_side, prev_size, new_size')
    .eq('id', leaderActionId)
    .maybeSingle();
  const la = laData as LeaderActionRow | null;
  if (!la) return { staged: false, reason: 'leader action not found' };

  // Only the protective (reduce-side) kinds stage; opens/adds are never staged.
  if (!['reduce', 'close', 'flip'].includes(la.kind)) {
    return { staged: false, reason: `kind '${la.kind}' is not a protective match` };
  }

  // Idempotency: one LIVE stage per leader_action (the partial-unique index is the
  // backstop). A dismissed (rejected/expired) prior stage is NOT counted, so a
  // mistakenly-dismissed match can be re-raised (migration 0017).
  const dedupeKey = `follow:${leaderActionId}`;
  const { data: dup } = await client
    .from('pending_actions')
    .select('id')
    .eq('dedupe_key', dedupeKey)
    .not('status', 'in', '("rejected","expired")')
    .limit(1);
  if (dup && dup.length > 0) return { staged: false, reason: 'already staged for this leader action' };

  const mode = getTradingMode();
  let session = await getActiveSession();
  if (!session) session = await openSession({ mode, title: 'follow-match', leaderAddress: la.leader_address });

  const position = await loadPosition(session.id, la.coin);
  if (!position || position.side === 'flat' || !(position.sz > 0)) {
    return { staged: false, reason: 'you hold no position in this coin — nothing to keep matched' };
  }

  const plan = planFollowMatch({
    leaderKind: la.kind as LeaderActionKind,
    leaderPrevSide: la.prev_side,
    leaderNewSide: la.new_side,
    leaderPrevSize: la.prev_size ?? 0,
    leaderNewSize: la.new_size ?? 0,
    operatorSide: position.side,
    operatorSz: position.sz,
  });
  if (plan.action === 'none') return { staged: false, reason: plan.reason };

  const intent = buildMarketReduceOnlyClose(position, {
    clientIntentId: dedupeKey,
    sessionId: session.id,
    now: Date.now(),
    fraction: plan.action === 'close' ? 1 : plan.fraction,
  });
  if (!intent) return { staged: false, reason: 'reduce-only build returned null (flat/zero size)' };

  await createPreview({
    sessionId: session.id,
    kind: 'exit',
    mode,
    dedupeKey,
    proposal: {
      intent,
      // Display is built from the REDUCE-ONLY intent (close side, reduced size) — the
      // popup + LIVE confirm phrase describe the actual reduce, never an open.
      display: { coin: intent.coin, side: intent.side, sz: intent.sz, rationale: plan.reason, leverage: null },
    },
  });

  // Lifecycle: a leader CLOSE ends the follow once its match is staged.
  if (la.kind === 'close') {
    try { await endFollow(la.leader_address, la.coin); } catch { /* best-effort */ }
  }

  return { staged: true, reason: plan.reason, action: plan.action };
}
