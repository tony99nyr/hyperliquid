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
import type { LadderRung, LadderWithRungs } from './ladder-types';
import { expiryAlertVerdict, residualExpiryAlertVerdict, type ResidualRead } from './ladder-expiry-alert-business-logic';
import { writeAnalysisLog } from '@/lib/cockpit/analysis-log-service';
import { getActiveSession } from '@/lib/cockpit/session-service';
import { sendDiscord } from '@/lib/infrastructure/notify/discord-notify';
import { getHlAccountAddress } from '@/lib/auto-exit/auto-exit-config';
import { fetchClearinghouseState } from '@/lib/hyperliquid/hyperliquid-info-service';
import { findAllStops } from '@/lib/trading/stop-order-service';

/** How long an expired ladder settles before a quiet residual check stamps it. */
const RESIDUAL_SETTLE_MS = 10 * 60_000;

export interface ExpiryAlertSummary {
  checked: number;
  alerted: string[];
  error?: string;
}

const isEntry = (rung: LadderRung) => rung.action === 'open' || rung.action === 'add';

/** The entry rungs with any fire on record. A real fill whose rung status write failed
 *  still has its fire row, and an unknown outcome can be marked failed yet fill, so the
 *  residual check treats every such rung as fired (a flat read then stamps it quietly).
 *  Returns null when the fire ledger is unreadable. */
async function entryRungsWithFire(db: ReturnType<typeof getServiceRoleClient>, ladders: LadderWithRungs[]): Promise<Set<string> | null> {
  const rungIds = ladders.flatMap((ladder) => ladder.rungs.filter(isEntry).map((rung) => rung.id));
  if (rungIds.length === 0) return new Set();
  const { data, error } = await db.from('ladder_fires').select('rung_id').in('rung_id', rungIds);
  if (error || !data) return null;
  return new Set(data.map((row) => String((row as { rung_id: string }).rung_id)));
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
  // Load the candidates by id, archived or not: a ladder archived before it was armed
  // expires as an archived row, and the full expired history is not read every tick.
  const loaded = await listLaddersWithRungs('expired', { ids: unstamped.map((row) => row.id as string) });
  const entryFires = await entryRungsWithFire(db, loaded);
  const expired = loaded.map((ladder) => ({ ...ladder,
    rungs: ladder.rungs.map((rung) => entryFires?.has(rung.id) ? { ...rung, status: 'fired' as const } : rung) }));
  const hasResidualRisk = (ladder: LadderWithRungs) => ladder.mode === 'live' &&
    ladder.rungs.some((rung) => rung.status === 'fired' && isEntry(rung));
  const eligible = expired.filter(hasResidualRisk);
  // A ladder that needs no page is stamped too, so the candidate list drains. Stamp it
  // only once it has settled: a fire that passed the guards just before expiry can still
  // fill after the watcher expired the ladder. An unreadable fire ledger stamps nothing.
  const settled = (ladder: LadderWithRungs) =>
    ladder.disarmedAt !== null && now - Date.parse(ladder.disarmedAt) >= RESIDUAL_SETTLE_MS;
  const quiet = entryFires ? expired.filter((ladder) => !hasResidualRisk(ladder) && settled(ladder)).map((ladder) => ladder.id) : [];
  summary.checked += eligible.length;

  let read: ResidualRead = { kind: 'unreadable' };
  const address = eligible.length ? getHlAccountAddress() : null;
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
    if (!verdict.shouldAlert || !verdict.message) {
      // Flat on a good read: a later same-side position belongs to someone else.
      if (read.kind === 'readable' && settled(ladder)) quiet.push(ladder.id);
      continue;
    }
    const { data, error } = await db.from('ladders')
      .update({ residual_alert_at: new Date(now).toISOString() })
      .eq('id', ladder.id).eq('status', 'expired').is('residual_alert_at', null).select('id');
    if (error || !data?.length) continue;
    summary.alerted.push(ladder.id);
    await sendDiscord(verdict.message, 'HL Ladder Guard').catch(() => {});
    const session = await getActiveSession().catch(() => null);
    if (session) await writeAnalysisLog({ sessionId: session.id, source: 'ladder-expiry-alert', severity: 'warn', message: verdict.message }).catch(() => {});
  }
  if (quiet.length) {
    const { error } = await db.from('ladders').update({ residual_alert_at: new Date(now).toISOString() })
      .in('id', quiet).eq('status', 'expired').is('residual_alert_at', null);
    if (error) summary.error = `stamp quiet residual expiry alerts failed: ${error.message}`;
  }
  return summary;
}
