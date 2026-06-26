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
  /** True when a run would flatten EVERY live position (≥2) — a likely wrong-account
   *  (agent vs master) or HL-outage signature. Surfaced + alerted, not blocked. */
  suspicious?: boolean;
}

export async function reconcileLivePositions(client: SupabaseClient = getServiceRoleClient()): Promise<ReconcileSummary> {
  const addr = getHlAccountAddress();
  if (!addr) return { skipped: true, reason: 'HL_ACCOUNT_ADDRESS not set', checked: 0, flattened: 0, resynced: 0 };

  // FRESH read only — a stale/errored clearinghouse read returns no positions, which
  // must NOT be allowed to flatten real positions. Bail out instead.
  let hl: HlPos[];
  try {
    const ch = await fetchClearinghouseState(addr, { uncached: true }); // cron: once per tick, skip the Blob-backed Data Cache
    if (ch.stale) return { skipped: true, reason: 'HL read stale — refusing to reconcile', checked: 0, flattened: 0, resynced: 0 };
    hl = ch.positions.map((p) => ({ coin: p.coin, szi: p.szi, entryPx: p.entryPx, leverage: p.leverage }));
  } catch (err) {
    return { skipped: true, reason: `HL read failed: ${extractErrorMessage(err)}`, checked: 0, flattened: 0, resynced: 0 };
  }

  // Cockpit's LIVE-session open positions (paper positions aren't on HL).
  const { data: liveSessions } = await client.from('sessions').select('id').eq('mode', 'live');
  const ids = (liveSessions ?? []).map((s) => (s as { id: string }).id);
  if (ids.length === 0) return { skipped: false, checked: 0, flattened: 0, resynced: 0 };

  const { data: posRows } = await client
    .from('positions')
    .select('session_id, coin, side, sz, avg_entry_px, leverage, updated_at')
    .neq('side', 'flat')
    .in('session_id', ids);
  const cockpit: CockpitPos[] = (posRows ?? []).map((r) => {
    const row = r as { session_id: string; coin: string; side: 'long' | 'short' | 'flat'; sz: number; avg_entry_px: number; leverage: number | null; updated_at: string };
    const t = Date.parse(row.updated_at);
    return { sessionId: row.session_id, coin: row.coin, side: row.side, sz: row.sz, avgEntryPx: row.avg_entry_px, leverage: row.leverage, updatedAtMs: Number.isFinite(t) ? t : undefined };
  });

  // nowMs feeds the PURE freshness guard — a just-written row (mid-settlement / behind
  // the clearinghouse cache) is not reconciled, so a real new position can't be flattened.
  const actions = reconcilePositions(cockpit, hl, { nowMs: Date.now() });

  // BLAST-RADIUS TRIPWIRE: flattening EVERY live position (≥2) in one run is the
  // signature of a wrong HL_ACCOUNT_ADDRESS (agent vs master → empty account) or an HL
  // outage. Most often it's a legit full-close, so we ALERT + flag (never block — a
  // block would leave the cockpit stuck showing positions that are really closed).
  // NOTE: a freshness-skipped row makes flattenCount < cockpit.length, so a coincident
  // just-opened position can suppress this alert — it only ever MISSES an alert, never
  // causes a wrong flatten (the freshness guard already protected the fresh row).
  const flattenCount = actions.filter((a) => a.reason === 'flatten').length;
  const suspicious = flattenCount >= 2 && flattenCount === cockpit.length;
  if (suspicious) {
    try {
      await writeAnalysisLog({
        sessionId: actions[0]?.sessionId ?? ids[0],
        source: 'reconcile',
        severity: 'danger',
        message: `RECONCILE flattened ALL ${cockpit.length} live positions in one run — if you did NOT just close everything, verify HL_ACCOUNT_ADDRESS is the MASTER account (not the agent) and that HL isn't degraded.`,
      });
    } catch {
      /* non-critical */
    }
  }

  let flattened = 0;
  let resynced = 0;
  for (const a of actions) {
    // Write the target state; realized_pnl_usd / fees_paid_usd are preserved (not in
    // the update payload) so historical realized P&L isn't lost. Leverage is only
    // written when HL reported one on a resync (never nulled — a flatten omits it).
    const payload: { side: string; sz: number; avg_entry_px: number; leverage?: number } = {
      side: a.target.side,
      sz: a.target.sz,
      avg_entry_px: a.target.avgEntryPx,
    };
    if (a.target.leverage != null) payload.leverage = a.target.leverage;
    const { error } = await client
      .from('positions')
      .update(payload)
      .eq('session_id', a.sessionId)
      .eq('coin', a.coin.trim().toUpperCase());
    if (error) continue; // fail-soft per row
    if (a.reason === 'flatten') flattened++;
    else resynced++;
    try {
      await writeAnalysisLog({
        sessionId: a.sessionId,
        source: 'reconcile',
        severity: 'info',
        message: `RECONCILE: ${a.coin} ${a.reason === 'flatten' ? 'flattened (HL holds none)' : `resynced to HL (${a.target.side} ${a.target.sz}${a.target.leverage != null ? ` @ ${Math.round(a.target.leverage)}x` : ''})`} — drift $${a.deltaUsd.toFixed(2)}.`,
      });
    } catch {
      /* non-critical */
    }
  }
  return { skipped: false, checked: cockpit.length, flattened, resynced, suspicious };
}
