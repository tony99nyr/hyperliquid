/**
 * Auto-exit lock (I/O) — the per-(session, coin) anti-double-close + cooldown.
 *
 * acquire: reap any expired lock for the key, then INSERT a fresh active lock.
 * The partial unique index (migration 0008) guarantees ONE active lock per key,
 * so a concurrent NAS+cron race resolves to a single winner (the loser gets a
 * unique violation → null). On SUCCESS the caller LEAVES the lock active until
 * expires_at (that IS the cooldown); on FAILURE the caller releases it so the
 * next cycle can retry.
 *
 * NOTE: this module never imports the fill path — it is execution-free (see the
 * lib/auto-exit no-execute static test).
 */

import { getServiceRoleClient } from '@/lib/cockpit/supabase-server';
import type { SupabaseClient } from '@supabase/supabase-js';

/** Postgres unique-violation SQLSTATE — the concurrent-loser signal. */
const UNIQUE_VIOLATION = '23505';

export interface ExitLock {
  id: string;
  sessionId: string;
  coin: string;
  /** Epoch ms when the lock (and its cooldown) expires. */
  expiresAt: number;
}

export interface AcquireOpts {
  reason: string;
  nowMs: number;
  /** Active window: doubles as the cooldown (success keeps the lock until here). */
  ttlMs: number;
}

/**
 * Try to acquire the active lock for (session, coin). Returns the lock on
 * success, or null when one is already held / the key is within its cooldown.
 */
export async function acquireExitLock(
  sessionId: string,
  coin: string,
  opts: AcquireOpts,
  client: SupabaseClient = getServiceRoleClient(),
): Promise<ExitLock | null> {
  const c = coin.toUpperCase();
  const nowIso = new Date(opts.nowMs).toISOString();

  // 1) Reap an expired (stuck or cooled-down) lock for this key so it can't block
  //    forever. eq(released,false) + lt(expires_at, now) — no null-filter needed.
  const reap = await client
    .from('auto_exit_locks')
    .update({ released: true, released_at: nowIso, outcome: 'expired' })
    .eq('session_id', sessionId)
    .eq('coin', c)
    .eq('released', false)
    .lt('expires_at', nowIso);
  if (reap.error) throw new Error(`acquireExitLock reap failed: ${reap.error.message}`);

  // 2) Atomic claim. The partial unique index makes the second concurrent INSERT
  //    fail with 23505 → that caller backs off.
  const expiresAt = opts.nowMs + opts.ttlMs;
  const { data, error } = await client
    .from('auto_exit_locks')
    .insert({
      session_id: sessionId,
      coin: c,
      reason: opts.reason,
      acquired_at: nowIso,
      expires_at: new Date(expiresAt).toISOString(),
      released: false,
    })
    .select('id')
    .single();
  if (error) {
    if (error.code === UNIQUE_VIOLATION) return null; // held or cooling down
    throw new Error(`acquireExitLock failed: ${error.message}`);
  }
  return { id: (data as { id: string }).id, sessionId, coin: c, expiresAt };
}

/**
 * Release a held lock. Call on FAILURE/partial (so the next cycle retries). Do
 * NOT call on a clean full close — leaving it active until expiry IS the cooldown.
 */
export async function releaseExitLock(
  id: string,
  outcome: string,
  client: SupabaseClient = getServiceRoleClient(),
): Promise<void> {
  const { error } = await client
    .from('auto_exit_locks')
    .update({ released: true, released_at: new Date().toISOString(), outcome })
    .eq('id', id);
  if (error) throw new Error(`releaseExitLock failed: ${error.message}`);
}
