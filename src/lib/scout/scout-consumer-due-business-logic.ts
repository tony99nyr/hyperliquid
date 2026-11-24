/**
 * When the scout consumer is due (PURE).
 *
 * The NAS scout-watch daemon used to start the headless consumer itself: every 30 min,
 * or after 10 min when an act-class trigger was waiting. The consumer now runs on the
 * HTPC from a 5-minute timer (ops/htpc), and the daemon runs with
 * SCOUT_CONSUMER_INTERVAL_MIN=0. This module keeps the same two cadences, read from
 * shared state: the last run (heartbeat or attempt stamp) and new unconsumed act triggers.
 */

export const CONSUMER_INTERVAL_MS = 30 * 60_000;
export const CONSUMER_ACT_INTERVAL_MS = 10 * 60_000;

/**
 * The last consumer run: the later of the `scout-cycle` heartbeat and the wrapper's
 * attempt stamp. scout:trade writes the heartbeat only after a decision is handled, so a
 * failing cycle leaves it stale. The attempt stamp (written before each run) keeps a
 * failing cycle on the normal cadence, as the daemon did, instead of every timer tick.
 * Null when neither is known.
 */
export function lastConsumerRunMs(heartbeatAtMs: number | null, attemptAtMs: number | null): number | null {
  const known = [heartbeatAtMs, attemptAtMs].filter((t): t is number => t !== null && Number.isFinite(t));
  return known.length > 0 ? Math.max(...known) : null;
}

/**
 * The cutoff for "new" act triggers: the attempt stamp when it exists, else the heartbeat.
 * The attempt stamp marks the START of the last run. A trigger that fires during that run
 * may miss its claim, and the heartbeat (written at the end) would hide it.
 */
export function actTriggerCutoffMs(heartbeatAtMs: number | null, attemptAtMs: number | null): number | null {
  if (attemptAtMs !== null && Number.isFinite(attemptAtMs)) return attemptAtMs;
  return heartbeatAtMs !== null && Number.isFinite(heartbeatAtMs) ? heartbeatAtMs : null;
}

export interface ConsumerDueInput {
  now: number;
  /** From lastConsumerRunMs. */
  lastRunAtMs: number | null;
  /** Act-urgency triggers that fired AFTER the last run and are still unconsumed. Older
   *  ones do not count: the consumer claims only the newest rows, so an old unclaimed act
   *  trigger would otherwise hold the short cadence for good. */
  newActTriggers: number;
}

export interface ConsumerDueVerdict {
  due: boolean;
  reason: string;
}

export function isConsumerDue(input: ConsumerDueInput): ConsumerDueVerdict {
  const { now, lastRunAtMs, newActTriggers } = input;
  if (lastRunAtMs === null) return { due: true, reason: 'no earlier consumer run' };
  const ageMs = now - lastRunAtMs;
  const ageMin = Math.round(ageMs / 60_000);
  const intervalMs = newActTriggers > 0 ? CONSUMER_ACT_INTERVAL_MS : CONSUMER_INTERVAL_MS;
  return {
    due: ageMs >= intervalMs,
    reason: `last run ${ageMin} min ago, ${newActTriggers} new act trigger(s)`,
  };
}
