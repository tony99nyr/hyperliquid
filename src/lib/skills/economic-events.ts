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
  /** Minutes before the print the prep-alert fires (default 30). Set 0 for an
   *  AWARENESS-ONLY entry: it still feeds the desk read, the scout blackout and the
   *  drafter expiry clamp, but it never fires the prep ping. */
  prepLeadMinutes?: number;
}

export const ECONOMIC_EVENTS: EconEvent[] = [
  {
    name: 'FOMC (Oct)',
    atIso: '2026-10-28T18:00:00Z',
    note:
      'Rate decision 14:00 ET / 18:00 UTC (Oct 27-28 meeting; EDT still in effect) + presser 18:30. Warsh Fed #2 — ' +
      'binary macro, straddle it. Opens a 48h catalyst corridor: MSFT+GOOGL earnings ~20:00 UTC the same evening, ' +
      'ECB + MSTR/COIN/AMZN Thursday, BoJ Friday — manage any straddle residual deliberately through it.',
    straddleCoin: 'BTC',
    prepLeadMinutes: 30,
  },
  {
    name: 'ECB',
    atIso: '2026-10-29T13:15:00Z',
    note:
      'Rate decision 14:15 CET / 13:15 UTC + Lagarde presser 14:45 CET. A hold at 2.50% is priced ~93%. ' +
      'Weak BTC transmission — awareness only, no straddle.',
    prepLeadMinutes: 0,
  },
  {
    name: 'Earnings cluster (MSTR + COIN + AMZN)',
    atIso: '2026-10-29T20:00:00Z',
    note:
      'After the US close (16:00 ET), calls ~17:00 ET. Strategy and Coinbase are the two listed BTC proxies and ' +
      'print the same evening as Amazon. Awareness only — context for residual/ladder risk, not a straddle event.',
    prepLeadMinutes: 0,
  },
  {
    name: 'BoJ',
    atIso: '2026-10-30T03:00:00Z',
    note:
      'Statement floats ~02:30-04:00 UTC (Quarterly Outlook Report; presser 06:30 UTC). A hold at 1.25% is ' +
      'near-consensus after the Sep 18 hike. A surprise hike = yen-carry unwind = real BTC risk. Awareness only.',
    prepLeadMinutes: 0,
  },
  {
    name: 'BoE',
    atIso: '2026-11-05T12:00:00Z',
    note: 'Bank Rate decision 12:00 London (GMT) + Monetary Policy Report presser. Lowest BTC beta of the majors — awareness only.',
    prepLeadMinutes: 0,
  },
  {
    name: 'NFP (Oct jobs)',
    atIso: '2026-11-06T13:30:00Z',
    note: 'BLS Employment Situation 08:30 ET / 13:30 UTC (EST from Nov 1; verified BLS schedule). Binary US macro — straddle it.',
    straddleCoin: 'BTC',
    prepLeadMinutes: 30,
  },
  {
    name: 'CPI (Oct data)',
    atIso: '2026-11-10T13:30:00Z',
    note: 'BLS CPI 08:30 ET / 13:30 UTC (EST; verified BLS schedule). Binary macro — straddle it.',
    straddleCoin: 'BTC',
    prepLeadMinutes: 30,
  },
  {
    name: 'NVIDIA earnings (date unconfirmed)',
    atIso: '2026-11-18T21:20:00Z',
    note:
      'Q3 FY27 after the US close (~16:20 ET). DATE UNCONFIRMED (Nov 18 inferred; retro-checked 2026-10-26) — ' +
      'NVIDIA confirms ~3-4 weeks ahead; verify on ' +
      'investor relations before relying on it. The AI-capex bellwether trades like scheduled macro for the whole ' +
      'risk complex, BTC included. Awareness only.',
    prepLeadMinutes: 0,
  },
  {
    name: 'FOMC (Dec)',
    atIso: '2026-12-09T19:00:00Z',
    note:
      'Rate decision 14:00 ET / 19:00 UTC (Dec 8-9 meeting; EST) + presser 19:30. Dot-plot/SEP meeting, ' +
      'Warsh Fed #3 — binary macro, straddle it.',
    straddleCoin: 'BTC',
    prepLeadMinutes: 30,
  },
];
