/**
 * When the scout consumer is due (PURE).
 *
 * The NAS scout-watch daemon used to start the headless consumer itself: every 30 min,
 * or after 10 min when an act-class trigger was waiting. The consumer now runs on the
 * HTPC from a 5-minute timer (ops/htpc), and the daemon runs with
 * SCOUT_CONSUMER_INTERVAL_MIN=0. This module keeps the same two cadences, read from
 * shared state: the `scout-cycle` heartbeat age and the unconsumed act triggers.
 */

export const CONSUMER_INTERVAL_MS = 30 * 60_000;
export const CONSUMER_ACT_INTERVAL_MS = 10 * 60_000;

export interface ConsumerDueInput {
  now: number;
  /** last_tick_at of the `scout-cycle` heartbeat, or null when the row is absent. */
  lastCycleAtMs: number | null;
  /** Count of unconsumed triggers with urgency 'act'. */
  unconsumedActTriggers: number;
}

export interface ConsumerDueVerdict {
  due: boolean;
  reason: string;
}

export function isConsumerDue(input: ConsumerDueInput): ConsumerDueVerdict {
  const { now, lastCycleAtMs, unconsumedActTriggers } = input;
  if (lastCycleAtMs === null || !Number.isFinite(lastCycleAtMs)) {
    return { due: true, reason: 'no scout-cycle heartbeat' };
  }
  const ageMs = now - lastCycleAtMs;
  const ageMin = Math.round(ageMs / 60_000);
  if (ageMs >= CONSUMER_INTERVAL_MS) return { due: true, reason: `last cycle ${ageMin} min ago` };
  if (unconsumedActTriggers > 0 && ageMs >= CONSUMER_ACT_INTERVAL_MS) {
    return { due: true, reason: `${unconsumedActTriggers} act trigger(s) waiting, last cycle ${ageMin} min ago` };
  }
  return { due: false, reason: `last cycle ${ageMin} min ago, ${unconsumedActTriggers} act trigger(s) waiting` };
}
