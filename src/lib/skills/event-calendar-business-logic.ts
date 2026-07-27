/**
 * Event-calendar — PURE (fixture-tested). Turns the ECONOMIC_EVENTS list into the
 * upcoming-events view the desk-review leads with + the prep-window check the cron
 * reminder fires on. No Date.now() — the caller injects `now`, so it's deterministic.
 */

import { ECONOMIC_EVENTS, type EconEvent } from './economic-events';

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

export interface UpcomingEvent extends EconEvent {
  atMs: number;
  msOut: number;
  daysOut: number; // whole days
  hoursOut: number; // whole hours after the days
  prepLeadMs: number;
  /** now is inside [print − prepLead, print] — the window to prep + arm the straddle. */
  prepDue: boolean;
}

/** Future events within `horizonDays`, soonest first, with time-out + prep-window fields. PURE. */
export function upcomingEvents(now: number, horizonDays = 10, events: EconEvent[] = ECONOMIC_EVENTS): UpcomingEvent[] {
  return events
    .map((e) => ({ e, atMs: Date.parse(e.atIso) }))
    .filter((x) => Number.isFinite(x.atMs) && x.atMs > now && x.atMs - now <= horizonDays * DAY)
    .sort((a, b) => a.atMs - b.atMs)
    .map(({ e, atMs }) => {
      const msOut = atMs - now;
      const prepLeadMs = Math.max(0, (e.prepLeadMinutes ?? 30)) * MIN;
      return {
        ...e,
        atMs,
        msOut,
        daysOut: Math.floor(msOut / DAY),
        hoursOut: Math.floor((msOut % DAY) / HOUR),
        prepLeadMs,
        prepDue: msOut > 0 && msOut <= prepLeadMs,
      };
    });
}

/** The single event whose prep window is active right now (soonest), or null. PURE. */
export function prepDueEvent(now: number, events: EconEvent[] = ECONOMIC_EVENTS): UpcomingEvent | null {
  return upcomingEvents(now, 1, events).find((e) => e.prepDue) ?? null;
}

/** One-line desk descriptor. PURE. */
export function eventDeskLine(e: UpcomingEvent): string {
  const when =
    e.daysOut > 0
      ? `${e.daysOut}d ${e.hoursOut}h`
      : e.hoursOut > 0
        ? `${e.hoursOut}h ${Math.floor((e.msOut % HOUR) / MIN)}m`
        : `${Math.floor(e.msOut / MIN)}m`;
  const iso = new Date(e.atMs).toISOString().slice(0, 16).replace('T', ' ');
  return `⏰ ${e.name} in ${when} (${iso} UTC)${e.straddleCoin ? ` — straddle ${e.straddleCoin}` : ''}${e.prepDue ? '  🚨 PREP + ARM NOW' : ''}`;
}
