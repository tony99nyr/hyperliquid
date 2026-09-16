/**
 * Economic-event calendar — the source of truth for scheduled macro events the desk
 * trades (FOMC, CPI, NFP, …). Edit this list to add/remove events. A TS const (not a
 * JSON file read at runtime) so it's compiled into both the desk-review script AND the
 * production cron bundle without fragile fs access.
 *
 * `prepLeadMinutes` is how long before the print the event-prep alert fires (default 30)
 * — enough time to run `straddle:prep` off a fresh reference and arm. Remove past events
 * during curation; a stale-but-future typo just shows up wrong in the desk read.
 */

export interface EconEvent {
  /** Short name shown on the desk + in the ping (e.g. "FOMC"). */
  name: string;
  /** ISO-8601 UTC of the print/decision (e.g. "2026-07-29T18:00:00Z"). */
  atIso: string;
  /** One-liner of context (what it is, presser time, etc.). */
  note?: string;
  /** Suggested straddle asset for the event play (BTC = cleanest macro proxy). */
  straddleCoin?: string;
  /** Minutes before the print the prep-alert fires (default 30). */
  prepLeadMinutes?: number;
}

export const ECONOMIC_EVENTS: EconEvent[] = [
  {
    name: 'Jackson Hole — Warsh keynote',
    atIso: '2026-08-28T14:00:00Z',
    note:
      "Kevin Warsh's FIRST keynote as Fed chair (symposium Aug 27-29, theme: financial innovation/payments). " +
      'A new chair debuting policy tone = outsized headline risk vs a routine JH speech. Keynote ~10:00 ET.',
    straddleCoin: 'BTC',
    prepLeadMinutes: 30,
  },
  {
    name: 'CPI (Aug data)',
    atIso: '2026-09-11T12:30:00Z',
    note: 'BLS CPI 08:30 ET. Inflation print into the Sep FOMC — binary macro.',
    straddleCoin: 'BTC',
    prepLeadMinutes: 30,
  },
  {
    name: 'FOMC',
    atIso: '2026-09-16T18:00:00Z',
    note: 'Rate decision 18:00 UTC + press conference 18:30. First decision of the Warsh Fed — binary macro, straddle it.',
    straddleCoin: 'BTC',
    prepLeadMinutes: 30,
  },
  {
    name: 'CPI (Sep data)',
    atIso: '2026-10-14T12:30:00Z',
    note: 'BLS CPI 08:30 ET (verified BLS schedule). Binary macro — straddle it.',
    straddleCoin: 'BTC',
    prepLeadMinutes: 30,
  },
  {
    name: 'FOMC (Oct)',
    atIso: '2026-10-28T18:00:00Z',
    note: 'Rate decision 14:00 ET / 18:00 UTC (Oct 27-28 meeting; EDT still in effect) + presser 18:30. Warsh Fed #2 — binary macro, straddle it.',
    straddleCoin: 'BTC',
    prepLeadMinutes: 30,
  },
];
