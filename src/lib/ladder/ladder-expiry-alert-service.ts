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
import { expiryAlertVerdict } from './ladder-expiry-alert-business-logic';
import { writeAnalysisLog } from '@/lib/cockpit/analysis-log-service';
import { getActiveSession } from '@/lib/cockpit/session-service';
import { sendDiscord } from '@/lib/infrastructure/notify/discord-notify';

export interface ExpiryAlertSummary {
  checked: number;
  alerted: string[];
}

export async function runExpiryAlerts(now = Date.now()): Promise<ExpiryAlertSummary> {
  const armed = await listLaddersWithRungs('armed');
  const summary: ExpiryAlertSummary = { checked: armed.length, alerted: [] };
  if (armed.length === 0) return summary;

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
  return summary;
}
