import { describe, it, expect } from 'vitest';
import { upcomingEvents, prepDueEvent, eventDeskLine } from '@/lib/skills/event-calendar-business-logic';
import type { EconEvent } from '@/lib/skills/economic-events';

const FOMC = '2026-07-29T18:00:00Z';
const events: EconEvent[] = [
  { name: 'FOMC', atIso: FOMC, straddleCoin: 'BTC', prepLeadMinutes: 30 },
  { name: 'CPI', atIso: '2026-08-12T12:30:00Z', straddleCoin: 'BTC' },
];
const at = (iso: string) => Date.parse(iso);

describe('upcomingEvents', () => {
  it('returns future events within the horizon, soonest first', () => {
    const u = upcomingEvents(at('2026-07-27T12:00:00Z'), 30, events);
    expect(u.map((e) => e.name)).toEqual(['FOMC', 'CPI']);
    expect(u[0].daysOut).toBe(2); // Jul 27 12:00 → Jul 29 18:00 = 2d 6h
    expect(u[0].hoursOut).toBe(6);
  });

  it('drops past events and events beyond the horizon', () => {
    const u = upcomingEvents(at('2026-07-30T00:00:00Z'), 10, events); // FOMC passed, CPI >10d out
    expect(u).toHaveLength(0);
  });

  it('prepDue is true only inside [print − prepLead, print]', () => {
    expect(upcomingEvents(at('2026-07-29T17:20:00Z'), 1, events)[0].prepDue).toBe(false); // 40m out > 30m lead
    expect(upcomingEvents(at('2026-07-29T17:35:00Z'), 1, events)[0].prepDue).toBe(true); // 25m out ≤ 30m lead
    expect(upcomingEvents(at('2026-07-29T18:01:00Z'), 1, events)).toHaveLength(0); // print passed → gone
  });
});

describe('prepDueEvent', () => {
  it('surfaces the event whose prep window is active, else null', () => {
    expect(prepDueEvent(at('2026-07-29T17:35:00Z'), events)?.name).toBe('FOMC');
    expect(prepDueEvent(at('2026-07-29T15:00:00Z'), events)).toBeNull(); // 3h out — not yet
  });
});

describe('eventDeskLine', () => {
  it('days-out format + straddle coin', () => {
    const e = upcomingEvents(at('2026-07-27T12:00:00Z'), 30, events)[0];
    expect(eventDeskLine(e)).toBe('⏰ FOMC in 2d 6h (2026-07-29 18:00 UTC) — straddle BTC');
  });
  it('flags PREP + ARM NOW when the window is active', () => {
    const e = upcomingEvents(at('2026-07-29T17:35:00Z'), 1, events)[0];
    expect(eventDeskLine(e)).toContain('🚨 PREP + ARM NOW');
  });
});
