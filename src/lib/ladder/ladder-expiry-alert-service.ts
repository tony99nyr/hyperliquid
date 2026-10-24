/**
 * Expiry-approaching alert service — pages the operator ONCE when an armed ladder is
 * <12h from expiry with rungs still pending (Discord + analysis_log), stamping
 * ladders.expiry_alert_at as the dedupe. ADVISORY ONLY: alerting changes no ladder
 * state beyond the stamp and can never fire/disarm anything. Runs from the ladder-watch
 * cron each tick, .catch'd — an alert failure never breaks the watcher.
 */

import 'server-only';
import { getServiceRoleClient } from '@/lib/cockpit/supabase-server';
import { listLaddersWithRungs } from './ladder-service';
import { expiryAlertVerdict, residualExpiryAlertVerdict, type ResidualRead } from './ladder-expiry-alert-business-logic';
import { writeAnalysisLog } from '@/lib/cockpit/analysis-log-service';
import { getActiveSession } from '@/lib/cockpit/session-service';
import { sendDiscord } from '@/lib/infrastructure/notify/discord-notify';
import { getHlAccountAddress } from '@/lib/auto-exit/auto-exit-config';
import { fetchClearinghouseState } from '@/lib/hyperliquid/hyperliquid-info-service';
import { findAllStops } from '@/lib/trading/stop-order-service';

export interface ExpiryAlertSummary {
  checked: number;
  alerted: string[];
}

export async function runExpiryAlerts(now = Date.now()): Promise<ExpiryAlertSummary> {
  const armed = await listLaddersWithRungs('armed');
  const summary: ExpiryAlertSummary = { checked: armed.length, alerted: [] };
  const db = getServiceRoleClient();
  for (const ladder of armed) {
    const verdict = expiryAlertVerdict(ladder, now);
    if (!verdict.shouldAlert || !verdict.message) continue;

    // Stamp FIRST (conditional on still-unstamped) so a concurrent tick can't double-page;
    // losing the race → the other tick owns the alert.
    const { data, error } = await db
      .from('ladders')
      .update({ expiry_alert_at: new Date(now).toISOString() })
      .eq('id', ladder.id)
      .is('expiry_alert_at', null)
      .select('id');
    if (error || !data || data.length === 0) continue;

    summary.alerted.push(ladder.id);
    await sendDiscord(verdict.message, 'HL Ladder Guard').catch(() => {});
    const session = await getActiveSession().catch(() => null);
    if (session) await writeAnalysisLog({ sessionId: session.id, source: 'ladder-expiry-alert', severity: 'warn', message: verdict.message }).catch(() => {});
  }

  // A separate stamp survives the pre-expiry page. Existing expired rows receive a
  // stamp in the migration, so this only handles expiries after deployment.
  const { data: unstamped, error: listError } = await db.from('ladders')
    .select('id').eq('status', 'expired').is('residual_alert_at', null);
  if (listError) throw new Error(`list residual expiry alerts failed: ${listError.message}`);
  if (!unstamped?.length) return summary;
  const candidates = new Set(unstamped.map((row) => row.id as string));
  const expired = (await listLaddersWithRungs('expired')).filter((ladder) => candidates.has(ladder.id));
  const eligible = expired.filter((ladder) => ladder.mode === 'live' &&
    ladder.rungs.some((rung) => rung.status === 'fired' && (rung.action === 'open' || rung.action === 'add')));
  summary.checked += eligible.length;
  if (eligible.length === 0) return summary;

  let read: ResidualRead = { kind: 'unreadable' };
  const address = getHlAccountAddress();
  if (address) {
    try {
      const state = await fetchClearinghouseState(address, { uncached: true });
      if (!state.stale && !state.error) {
        const stops = await findAllStops().catch(() => null);
        read = { kind: 'readable', positions: state.positions, stops };
      }
    } catch { /* The verdict pages the operator when the position is unreadable. */ }
  }
  for (const ladder of eligible) {
    const verdict = residualExpiryAlertVerdict(ladder, read);
    if (!verdict.shouldAlert || !verdict.message) continue;
    const { data, error } = await db.from('ladders')
      .update({ residual_alert_at: new Date(now).toISOString() })
      .eq('id', ladder.id).eq('status', 'expired').is('residual_alert_at', null).select('id');
    if (error || !data?.length) continue;
    summary.alerted.push(ladder.id);
    await sendDiscord(verdict.message, 'HL Ladder Guard').catch(() => {});
    const session = await getActiveSession().catch(() => null);
    if (session) await writeAnalysisLog({ sessionId: session.id, source: 'ladder-expiry-alert', severity: 'warn', message: verdict.message }).catch(() => {});
  }
  return summary;
}
