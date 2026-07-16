import { describe, it, expect } from 'vitest';
import {
  parseCalendar,
  eventWindowState,
  DEFAULT_PRE_WINDOW_MS,
  DEFAULT_POST_WINDOW_MS,
} from '@/lib/advisory/market-state-business-logic';

const H = 3_600_000;

describe('parseCalendar', () => {
  it('parses valid rows, drops junk, sorts by print time', () => {
    const events = parseCalendar({
      events: [
        { name: 'CPI', printAt: '2026-08-12T12:30:00Z', severity: 'high' },
        { name: 'FOMC', printAt: '2026-07-29T18:00:00Z', severity: 'high' },
        { name: 'bad-date', printAt: 'not-a-date' },
        { printAt: '2026-08-01T00:00:00Z' },
        'garbage',
        { name: 'PPI', printAt: '2026-08-13T12:30:00Z', severity: 'nonsense' },
      ],
    });
    expect(events.map((e) => e.name)).toEqual(['FOMC', 'CPI', 'PPI']);
    expect(events[2].severity).toBe('medium'); // unknown severity coerces down, never up
  });

  it('returns [] for non-object / missing events', () => {
    expect(parseCalendar(null)).toEqual([]);
    expect(parseCalendar({ events: 'nope' })).toEqual([]);
  });
});

describe('eventWindowState', () => {
  const print = Date.parse('2026-07-29T18:00:00Z');
  const events = [{ name: 'FOMC', printAtMs: print, severity: 'high' as const }];

  it('outside the window: next event known, inWindow false', () => {
    const s = eventWindowState(events, print - 48 * H);
    expect(s.next?.name).toBe('FOMC');
    expect(s.hoursToPrint).toBeCloseTo(48);
    expect(s.inWindow).toBe(false);
  });

  it('inside the 12h pre-window and the 1h post-window', () => {
    expect(eventWindowState(events, print - DEFAULT_PRE_WINDOW_MS + 1).inWindow).toBe(true);
    expect(eventWindowState(events, print + DEFAULT_POST_WINDOW_MS - 1).inWindow).toBe(true);
    expect(eventWindowState(events, print + DEFAULT_POST_WINDOW_MS + 1).inWindow).toBe(false);
  });

  it('a printed event ages out after the post window; no events → nulls', () => {
    const s = eventWindowState(events, print + 2 * H);
    expect(s.next).toBeNull();
    expect(s.inWindow).toBe(false);
    expect(eventWindowState([], Date.now()).hoursToPrint).toBeNull();
  });

  it('hoursToPrint is negative just after the print (still inWindow)', () => {
    const s = eventWindowState(events, print + 30 * 60_000);
    expect(s.hoursToPrint).toBeCloseTo(-0.5);
    expect(s.inWindow).toBe(true);
  });
});
