/** Event prep side lane. The feature flag defaults off; arming remains manual. */
import { prepDueEvent } from '@/lib/skills/event-calendar-business-logic';
import type { EconEvent } from '@/lib/skills/economic-events';
import { runEventPrepAlert } from './event-prep-alert-service';
import { prepEventStraddle } from './event-straddle-prep-service';
import { eventStraddlePrepDeps } from './event-straddle-prep-io';

interface CronDeps {
  ping(now: number): Promise<{ pinged: string | null; skipped?: string }>;
  prep(input: { event: EconEvent; now: number }): Promise<{ created: boolean; ids: [string, string] } | { dry: true }>;
  /** The calendar lookup; injectable so tests do not depend on the live calendar. */
  due?: typeof prepDueEvent;
}

const defaultDeps: CronDeps = {
  ping: runEventPrepAlert,
  prep: (input) => prepEventStraddle(input, eventStraddlePrepDeps),
};

export async function runEventPrepCron(now: number, enabled: boolean, deps: CronDeps = defaultDeps) {
  if (!enabled) return deps.ping(now);
  const event = (deps.due ?? prepDueEvent)(now);
  if (!event) return { created: false, skipped: 'no-event-in-prep-window' };
  const result = await deps.prep({ event, now });
  return { event: event.name, ...result };
}
