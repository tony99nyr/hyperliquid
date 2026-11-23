/**
 * Cron-poke planning — PURE. Decides which prod-cron calls a poker must send to
 * Vercel. Vercel Hobby caps Active CPU at 4 hours a month (hit on 2026-11-22), so
 * each avoided call counts.
 *
 * - The NAS tick always pokes the reconcile. A complete run proves that Vercel, the
 *   bearer and the HL reads work, every 5 min.
 * - The NAS tick skips the auto-exit poke only when the reconcile ran completely AND
 *   a strict read confirmed that no live position is open. The route would scan an
 *   empty list and do nothing. Once an hour it pokes anyway, and after a failed poke
 *   it keeps poking until one succeeds: a broken auto-exit route then never gets a
 *   fresh 'ok' stamp, so its heartbeat goes stale and pages while the book is flat.
 * - The office-box poker (scout:watch) pokes only when the NAS kept both heartbeats
 *   fresh and no NAS poke failed, so it stays a fallback and does not double the calls.
 */

/** The heartbeat detail marker that the NAS writes or that the route writes for a NAS poke. */
export const NAS_POKER_MARK = 'via nas';

/** The heartbeat sources the prod crons stamp. */
export const PROD_CRON_SOURCES = ['reconcile', 'auto-exit-cron'] as const;

/** The hourly probe window: the NAS ticks every 5 min, so exactly one tick an hour lands in it. */
export const PROBE_WINDOW_MINUTES = 5;

/** True when the reconcile route answered 2xx and neither the reconcile nor the backfill skipped. */
export function reconcileRanCompletely(httpOk: boolean, body: unknown): boolean {
  if (!httpOk || typeof body !== 'object' || body === null) return false;
  const b = body as { ok?: unknown; skipped?: unknown; backfill?: { skipped?: unknown } };
  return b.ok === true && b.skipped === false && b.backfill?.skipped === false;
}

/**
 * Skip the auto-exit poke? `liveOpenPositions` is null when the strict read failed;
 * `lastAutoExitStatus` is the 'auto-exit-cron' heartbeat status (null when unread).
 * Anything short of "the reconcile ran, the book is confirmed flat and the last
 * auto-exit poke did not fail" pokes, and so does the first tick of each hour.
 */
export function canSkipAutoExitPoke(input: {
  reconcileComplete: boolean;
  liveOpenPositions: number | null;
  lastAutoExitStatus: string | null;
  utcMinute: number;
}): boolean {
  return (
    input.reconcileComplete &&
    input.liveOpenPositions === 0 &&
    input.lastAutoExitStatus !== null &&
    input.lastAutoExitStatus !== NAS_POKE_FAILED &&
    input.utcMinute >= PROBE_WINDOW_MINUTES
  );
}

/** The UTC minute at the START of the nas-watch tick (`raw`, zero-padded "00".."59"),
 * so a slow tick still lands its hourly probe. Anything else gives `fallback`. */
export function tickUtcMinute(raw: string | undefined, fallback: number): number {
  return raw !== undefined && /^\d{1,2}$/.test(raw) && Number(raw) < 60 ? Number(raw) : fallback;
}

export interface PokerHeartbeat {
  source: string;
  lastTickAtMs: number;
  status: string | null;
  detail: string | null;
}

/** The status the NAS writes when a poke failed. A 'degraded' route run still counts as
 * covered: the office box would get the same result and only spend Vercel CPU. */
export const NAS_POKE_FAILED = 'nas-poke-failed';

/** The office box skips its poke when the NAS stamped both cron heartbeats recently. */
export const NAS_FRESH_MS = 12 * 60 * 1000;

export function nasCoversProdCrons(rows: PokerHeartbeat[], now: number, freshMs: number = NAS_FRESH_MS): boolean {
  return PROD_CRON_SOURCES.every((source) => {
    const row = rows.find((r) => r.source === source);
    return (
      row !== undefined &&
      row.status !== NAS_POKE_FAILED &&
      Number.isFinite(row.lastTickAtMs) &&
      now - row.lastTickAtMs <= freshMs &&
      (row.detail ?? '').includes(NAS_POKER_MARK)
    );
  });
}
