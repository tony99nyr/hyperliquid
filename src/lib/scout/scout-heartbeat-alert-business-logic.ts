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

/** Staleness thresholds per source. The producer loops every 60s; the consumer
 *  cron runs every 30min — thresholds sit well past normal jitter. */
export const STALE_AFTER_MS: Record<string, number> = {
  'scout-watch': 30 * 60 * 1000,
  'scout-cycle': 90 * 60 * 1000,
};

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

/** The Discord line for a stale heartbeat. */
export function staleMessage(row: HeartbeatRow, now: number): string {
  const hours = ((now - row.lastTickAtMs) / 3_600_000).toFixed(1);
  const what = row.source === 'scout-cycle' ? 'decision engine (headless consumer)' : 'trigger producer (scout-watch daemon)';
  return `⚠️ **SCOUT ${row.source.toUpperCase()} SILENT ${hours}h** — the ${what} has not ticked. Triggers ${row.source === 'scout-cycle' ? 'are piling up unconsumed' : 'are not being produced'}. Check the box + cron (see scout-repair runbook).`;
}
