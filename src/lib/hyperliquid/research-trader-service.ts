/**
 * research-trader service (SERVICE ROLE, server-only) — the on-demand vetting
 * pipeline backing PR-3. The cockpit ENQUEUES a request; the NAS worker DRAINS the
 * queue (fetch fills + clearinghouse → computeTraderFingerprint → persist a
 * trader_evaluations row). Vercel never does the heavy fetch (review A3).
 *
 * One-evaluation-two-consumers: the persisted row is read by the UI (useTraderEvaluation)
 * AND the review-trader skill — same shape.
 */

import 'server-only';
import { getServiceRoleClient } from '@/lib/cockpit/supabase-server';
import { fetchClearinghouseState, fetchAllFills } from './hyperliquid-info-service';
import { computeTraderFingerprint } from './trader-fingerprint-business-logic';
import { normalizeLeaderAddress } from '@/lib/trader-watch/watch-set-business-logic';

const DAY = 24 * 60 * 60 * 1000;
export const DEFAULT_WINDOW_DAYS = 30;
/** Bounded so the worker fetch stays minutes, not unbounded, per address. */
const MAX_FILLS = 12000;

export interface TraderEvaluationRow {
  leader_address: string;
  verdict: string;
  persistence_confidence: string;
  metrics: Record<string, unknown>;
  hold_distribution: unknown;
  round_trip_series: unknown;
  window_label: string;
  fills_seen: number;
  generated_at: string;
}

/** Enqueue a vetting request. Idempotent: no-op if one is already pending/processing. */
export async function enqueueEvaluation(address: string): Promise<{ queued: boolean }> {
  const leader_address = normalizeLeaderAddress(address);
  if (!leader_address) throw new Error('address required');
  const client = getServiceRoleClient();
  const { data: inflight, error: selErr } = await client
    .from('evaluation_requests')
    .select('id')
    .eq('leader_address', leader_address)
    .in('status', ['pending', 'processing'])
    .limit(1);
  if (selErr) throw new Error(`enqueueEvaluation check failed: ${selErr.message}`);
  if (inflight && inflight.length > 0) return { queued: false };
  const { error } = await client.from('evaluation_requests').insert({ leader_address, status: 'pending' });
  if (error) throw new Error(`enqueueEvaluation failed: ${error.message}`);
  return { queued: true };
}

/** Latest persisted evaluation for an address (null if never vetted). */
export async function getLatestEvaluation(address: string): Promise<TraderEvaluationRow | null> {
  const leader_address = normalizeLeaderAddress(address);
  if (!leader_address) return null;
  const { data, error } = await getServiceRoleClient()
    .from('trader_evaluations')
    .select('*')
    .eq('leader_address', leader_address)
    .order('generated_at', { ascending: false })
    .limit(1);
  if (error) throw new Error(`getLatestEvaluation failed: ${error.message}`); // don't mask as "never vetted"
  return (data?.[0] as TraderEvaluationRow | undefined) ?? null;
}

/**
 * Reclaim rows stuck in 'processing' (a worker crashed mid-fetch) back to 'pending'.
 * Single-worker model: any 'processing' row at worker STARTUP is orphaned. Without
 * this, enqueueEvaluation's in-flight dedup would block that address forever.
 */
export async function resetStuckProcessing(): Promise<number> {
  const { data, error } = await getServiceRoleClient()
    .from('evaluation_requests')
    .update({ status: 'pending' })
    .eq('status', 'processing')
    .select('id');
  if (error) throw new Error(`resetStuckProcessing failed: ${error.message}`);
  return data?.length ?? 0;
}

/**
 * Drain ONE pending request: claim → fetch → compute → persist → mark done. Returns
 * the processed address, or null when the queue is empty. WORKER-ONLY (heavy fetch).
 * Single-worker model → a plain status flip is sufficient claim semantics.
 */
export async function processNextEvaluation(windowDays = DEFAULT_WINDOW_DAYS): Promise<string | null> {
  const client = getServiceRoleClient();
  const { data: pend } = await client
    .from('evaluation_requests')
    .select('id, leader_address')
    .eq('status', 'pending')
    .order('requested_at', { ascending: true })
    .limit(1);
  const req = pend?.[0] as { id: string; leader_address: string } | undefined;
  if (!req) return null;
  // Atomic claim: only proceed if WE flipped pending→processing (guards a 2nd worker
  // instance racing the same row); otherwise try the next pending.
  const { data: claimed } = await client
    .from('evaluation_requests')
    .update({ status: 'processing' })
    .eq('id', req.id)
    .eq('status', 'pending')
    .select('id');
  if (!claimed || claimed.length === 0) return processNextEvaluation(windowDays);
  try {
    const addr = req.leader_address;
    const sinceMs = Date.now() - windowDays * DAY;
    const [state, fillsRes] = await Promise.all([
      fetchClearinghouseState(addr),
      fetchAllFills(addr, { sinceMs, maxFills: MAX_FILLS }),
    ]);
    if (state.stale) throw new Error('clearinghouse stale — skipping');
    const fp = computeTraderFingerprint(fillsRes.fills, state, windowDays, fillsRes.truncated);
    const { error } = await client.from('trader_evaluations').insert({
      leader_address: addr,
      verdict: fp.verdict,
      persistence_confidence: fp.persistenceConfidence,
      metrics: { ...fp.metrics, why: fp.why },
      hold_distribution: fp.holdDistribution,
      round_trip_series: fp.roundTripSeries,
      window_label: `last ${fp.windowDays}d`,
      fills_seen: fp.fillsSeen,
    });
    if (error) throw new Error(`persist failed: ${error.message}`);
    await client.from('evaluation_requests').update({ status: 'done', processed_at: new Date().toISOString() }).eq('id', req.id);
    return addr;
  } catch (e) {
    await client
      .from('evaluation_requests')
      .update({ status: 'error', processed_at: new Date().toISOString(), error: e instanceof Error ? e.message : String(e) })
      .eq('id', req.id);
    return req.leader_address;
  }
}
