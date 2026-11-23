/**
 * Scout heartbeat staleness — PURE decision logic. The Jul-16 review's #1
 * operational finding: the decision engine died silently for 16h because
 * nothing watched the consumer heartbeat. This module decides when a heartbeat
 * row is stale enough to page and when a repeat page is due.
 */

export interface HeartbeatRow {
  source: string;
  lastTickAtMs: number;
  staleAlertedAtMs: number | null;
}

/** Staleness thresholds per source. The producer loops every 120s (eased from 60s
 *  on 08-11 — the fast 15m lanes are retired); the consumer cron runs every 30min —
 *  thresholds sit well past normal jitter either way. */
export const STALE_AFTER_MS: Record<string, number> = {
  'scout-watch': 30 * 60 * 1000,
  'scout-cycle': 90 * 60 * 1000,
  // Prod crons (retro 2026-10-03): both are poked every 5-10 min by two pokers;
  // 30 min stale = every poker dead or the bearer stale. Pages via the existing
  // ladder-watch checkScoutHeartbeats path — the six-week silent death class.
  reconcile: 30 * 60 * 1000,
  'auto-exit-cron': 30 * 60 * 1000,
  // The reconcile route stamps this row only on a run where the reconcile AND the
  // fill backfill both completed. Stale here while `reconcile` is fresh = the route
  // runs but skips on HL read faults: no phantom-position self-heal (2026-11-22).
  'reconcile-ok': 30 * 60 * 1000,
};

/** A heal heartbeat and its liveness parent. Both rows go stale when the route is dead,
 *  so the heal row pages only while its parent is fresh: one page per fault, not two. */
export const HEAL_PARENT: Record<string, string> = { 'reconcile-ok': 'reconcile' };

/**
 * Decide whether to judge `source` at all this tick. A heal row is skipped:
 *  - when absent: it appears on the first healthy run after deploy, and an absent row
 *    must not page as "never healed" before that run;
 *  - when its parent is absent or stale: the parent's own stale page covers that case.
 * Every other source is always judged (an absent row pages, review F7).
 */
export function shouldJudge(
  source: string,
  present: boolean,
  parentLastTickAtMs: number | null,
  now: number,
): boolean {
  const parent = HEAL_PARENT[source];
  if (parent === undefined) return true;
  if (!present || parentLastTickAtMs === null) return false;
  const parentStaleAfter = STALE_AFTER_MS[parent] ?? 0;
  return now - parentLastTickAtMs <= parentStaleAfter;
}

/** Re-page at most every 6h while stale (the operator got the message; don't spam). */
export const REALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000;

export type HeartbeatVerdict = 'ok' | 'stale-page' | 'stale-quiet';

/**
 * Decide what to do for one heartbeat row at `now`:
 *  - 'ok'          : fresh
 *  - 'stale-page'  : stale and (never paged / cooldown elapsed) — page + stamp
 *  - 'stale-quiet' : stale but paged recently — stay silent
 * Unknown sources are 'ok' (only sources with a registered threshold are watched).
 * stale_alerted_at is NEVER cleared on recovery (review F6): a crash-looping
 * daemon that ticks once per restart would erase the cooldown anchor each flap
 * and page indefinitely. The stamp IS the cooldown, across flaps.
 */
export function heartbeatVerdict(row: HeartbeatRow, now: number): HeartbeatVerdict {
  const staleAfter = STALE_AFTER_MS[row.source];
  if (staleAfter === undefined) return 'ok';
  const stale = now - row.lastTickAtMs > staleAfter;
  if (!stale) return 'ok';
  if (row.staleAlertedAtMs === null || now - row.staleAlertedAtMs > REALERT_COOLDOWN_MS) return 'stale-page';
  return 'stale-quiet';
}

/** The Discord line for a stale heartbeat. Per-source wording matters: a dead PROD
 *  cron must not page as a scout failure (review 10-03 — the wrong-runbook page). */
export function staleMessage(row: HeartbeatRow, now: number, parentDetail: string | null = null): string {
  const hours = ((now - row.lastTickAtMs) / 3_600_000).toFixed(1);
  if (row.source === 'reconcile-ok') {
    const why = parentDetail ? ` Last run: ${parentDetail.slice(0, 160)}.` : '';
    return `⚠️ **RECONCILE DEGRADED ${hours}h** — the reconcile route runs but has not completed a reconcile + fill backfill. Phantom positions can accumulate.${why} Check the HL info API and HL_ACCOUNT_ADDRESS.`;
  }
  if (row.source === 'reconcile') {
    return `⚠️ **RECONCILE CRON SILENT ${hours}h** — the ledger self-heal (venue-fill backfill) is not running. Phantom positions can accumulate. Check the pokers: the NAS .auto-exit-secret bearer and the local scout daemon, then the Vercel route.`;
  }
  if (row.source === 'auto-exit-cron') {
    return `⚠️ **AUTO-EXIT CRON SILENT ${hours}h** — the catastrophe-close scanner is not running; open live positions have NO automated risk net. Check the pokers (NAS bearer / local daemon) and the Vercel route NOW.`;
  }
  const what = row.source === 'scout-cycle' ? 'decision engine (headless consumer)' : 'trigger producer (scout-watch daemon)';
  return `⚠️ **SCOUT ${row.source.toUpperCase()} SILENT ${hours}h** — the ${what} has not ticked. Triggers ${row.source === 'scout-cycle' ? 'are piling up unconsumed' : 'are not being produced'}. Check the box + cron (see scout-repair runbook).`;
}
