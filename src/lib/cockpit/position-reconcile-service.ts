/**
 * Position reconciliation (I/O) — keep the cockpit's `positions` table in lock-step
 * with the REAL Hyperliquid account, so a position closed/changed directly on HL
 * (manual app close, partial fill, liquidation) can never linger as a phantom in the
 * cockpit. Reads the live account's clearinghouseState, diffs it against the cockpit's
 * LIVE-session positions via the PURE `reconcilePositions`, and writes the corrections
 * (flatten stale, resync drifted). Read-only on HL; service-role writes to Supabase.
 *
 * SAFETY: reconciliation runs ONLY on a FRESH HL read. A stale/errored read (which
 * surfaces as empty positions) must NEVER flatten real positions — so a stale read
 * short-circuits to a no-op. Fail-soft throughout (a cron must not crash).
 */

import 'server-only';
import { getServiceRoleClient } from './supabase-server';
import { getHlAccountAddress } from '@/lib/auto-exit/auto-exit-config';
import { fetchClearinghouseState } from '@/lib/hyperliquid/hyperliquid-info-service';
import { writeAnalysisLog } from './analysis-log-service';
import { extractErrorMessage } from '@/lib/infrastructure/logging/logger';
import { reconcilePositions, type CockpitPos, type HlPos } from './position-reconcile-business-logic';
import type { SupabaseClient } from '@supabase/supabase-js';

export interface ReconcileSummary {
  skipped: boolean;
  reason?: string;
  checked: number;
  flattened: number;
  resynced: number;
}

export async function reconcileLivePositions(client: SupabaseClient = getServiceRoleClient()): Promise<ReconcileSummary> {
  const addr = getHlAccountAddress();
  if (!addr) return { skipped: true, reason: 'HL_ACCOUNT_ADDRESS not set', checked: 0, flattened: 0, resynced: 0 };

  // FRESH read only — a stale/errored clearinghouse read returns no positions, which
  // must NOT be allowed to flatten real positions. Bail out instead.
  let hl: HlPos[];
  try {
    const ch = await fetchClearinghouseState(addr);
    if (ch.stale) return { skipped: true, reason: 'HL read stale — refusing to reconcile', checked: 0, flattened: 0, resynced: 0 };
    hl = ch.positions.map((p) => ({ coin: p.coin, szi: p.szi, entryPx: p.entryPx }));
  } catch (err) {
    return { skipped: true, reason: `HL read failed: ${extractErrorMessage(err)}`, checked: 0, flattened: 0, resynced: 0 };
  }

  // Cockpit's LIVE-session open positions (paper positions aren't on HL).
  const { data: liveSessions } = await client.from('sessions').select('id').eq('mode', 'live');
  const ids = (liveSessions ?? []).map((s) => (s as { id: string }).id);
  if (ids.length === 0) return { skipped: false, checked: 0, flattened: 0, resynced: 0 };

  const { data: posRows } = await client
    .from('positions')
    .select('session_id, coin, side, sz, avg_entry_px')
    .neq('side', 'flat')
    .in('session_id', ids);
  const cockpit: CockpitPos[] = (posRows ?? []).map((r) => {
    const row = r as { session_id: string; coin: string; side: 'long' | 'short' | 'flat'; sz: number; avg_entry_px: number };
    return { sessionId: row.session_id, coin: row.coin, side: row.side, sz: row.sz, avgEntryPx: row.avg_entry_px };
  });

  const actions = reconcilePositions(cockpit, hl);
  let flattened = 0;
  let resynced = 0;
  for (const a of actions) {
    // Write the target state; realized_pnl_usd / fees_paid_usd are preserved (not in
    // the update payload) so historical realized P&L isn't lost.
    const { error } = await client
      .from('positions')
      .update({ side: a.target.side, sz: a.target.sz, avg_entry_px: a.target.avgEntryPx })
      .eq('session_id', a.sessionId)
      .eq('coin', a.coin);
    if (error) continue; // fail-soft per row
    if (a.reason === 'flatten') flattened++;
    else resynced++;
    try {
      await writeAnalysisLog({
        sessionId: a.sessionId,
        source: 'reconcile',
        severity: 'info',
        message: `RECONCILE: ${a.coin} ${a.reason === 'flatten' ? 'flattened (HL holds none)' : `resynced to HL (${a.target.side} ${a.target.sz})`} — drift $${a.deltaUsd.toFixed(2)}.`,
      });
    } catch {
      /* non-critical */
    }
  }
  return { skipped: false, checked: cockpit.length, flattened, resynced };
}
