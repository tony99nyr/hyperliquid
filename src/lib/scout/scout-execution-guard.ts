/**
 * The autonomous scout's hard safety boundary. The scout is the ONE path in the
 * system that executes WITHOUT a human approval popup — that autonomy is allowed
 * for PAPER fills only. This guard is the single, testable assertion that keeps
 * real funds behind the human gate: scout auto-execution refuses to run unless
 * the process is in paper mode.
 *
 * Live trading the scout proposes is surfaced to the human and goes through the
 * existing `requireApproval` popup (Tier-1) — never this path. Pinning this in a
 * unit test is the no-auto-fire-for-real-money guarantee.
 */

import type { TradingMode } from '@/types/fill';

export class ScoutLiveExecutionError extends Error {
  constructor() {
    super(
      'Scout auto-execution is PAPER-ONLY. Refusing to fire in live mode — real-money ' +
        'trades must go through the human approval popup (Tier-1), never the autonomous scout.',
    );
    this.name = 'ScoutLiveExecutionError';
  }
}

/**
 * Throw unless `mode` is 'paper'. Call this immediately before any scout-initiated
 * `executeIntent`. There is intentionally NO flag or env that relaxes it.
 */
export function assertScoutPaperMode(mode: TradingMode): void {
  if (mode !== 'paper') throw new ScoutLiveExecutionError();
}

/**
 * KILLED lanes — pre-registered forward tests whose kill bar has FIRED (see
 * docs/scout/playbook.md reviews + docs/scout/PREREGISTRATION_*.md). Deterministic
 * enforcement at the execution point: prose in the playbook and context-only cycle
 * sections proved insufficient — after the 08-07 daemon revival a stale cycle
 * directive churned 42 trend-follow trades PAST its fired n=15 bar (08-13 review).
 * A lane on this list can NEVER open a new paper position; EXITS are always allowed
 * (a killed lane must still be able to flatten). Un-killing a lane is a deliberate
 * code change with a fresh pre-registration, never a runtime flag.
 */
export const KILLED_LANES: ReadonlySet<string> = new Set(['directional', 'reversion', 'trend-follow', 'leader-follow']);

/**
 * REGISTERED lanes — the ONLY lanes a scout open may carry (allowlist; 08-15). The
 * blocklist above catches killed experiments; this catches the OTHER failure class the
 * 08-15 review surfaced: an unregistered lane (no frozen rule, no kill bar) quietly
 * starting to trade — leader-follow ran 3 churn trades as an unregistered "control".
 * A lane gets ON this list by having a pre-registration doc (docs/scout/PREREGISTRATION_*)
 * or being a passive benchmark; anything else is refused at the execution point.
 */
export const REGISTERED_LANES: ReadonlySet<string> = new Set([
  'htf-trend', // PREREGISTRATION_htf-trend.md
  'compression-straddle', // PREREGISTRATION_compression-straddle.md
  'breakdown-short', // PREREGISTRATION_rubric-crossing.md (short side)
  'reclaim-long', // PREREGISTRATION_rubric-crossing.md (long side)
  'vault', // passive benchmark (HLP buy-hold)
  'carry', // passive benchmark (Δ-neutral funding)
]);

export class ScoutUnregisteredLaneError extends Error {
  constructor(lane: string) {
    super(
      `Scout lane '${lane}' is not REGISTERED — every tradeable lane needs a frozen pre-registration ` +
        '(docs/scout/PREREGISTRATION_*.md) + a kill bar BEFORE its first trade. Add it to REGISTERED_LANES ' +
        'with its pre-reg, or use a registered lane.',
    );
    this.name = 'ScoutUnregisteredLaneError';
  }
}

export class ScoutKilledLaneError extends Error {
  constructor(lane: string) {
    super(
      `Scout lane '${lane}' is KILLED — its pre-registered kill bar fired (see docs/scout/playbook.md). ` +
        'Refusing to OPEN. Exits of existing positions remain allowed. A revival requires a NEW pre-registration.',
    );
    this.name = 'ScoutKilledLaneError';
  }
}

/** Lanes exempt from the directional-risk gates (passive benchmarks, not bets). */
export const PASSIVE_LANES: ReadonlySet<string> = new Set(['vault', 'carry']);

/** The correlated-majors group: positions here move as ONE beta bet (ρ≈0.8+). */
export const CORRELATED_MAJORS: ReadonlySet<string> = new Set(['BTC', 'ETH', 'SOL', 'HYPE']);

/** Max concurrent same-direction directional positions across the correlated majors.
 *  Born 08-20: the scout stacked FOUR simultaneous longs (ETH/BTC/SOL/HYPE htf-trend)
 *  — statistically one ~4x-weighted beta bet. Two expresses a thesis; four is leverage. */
export const MAX_SAME_DIRECTION_MAJORS = 2;

export class ScoutPortfolioCapError extends Error {
  constructor(openCount: number) {
    super(
      `Portfolio cap: ${openCount} same-direction positions already open across the correlated majors ` +
        `(max ${MAX_SAME_DIRECTION_MAJORS}) — correlated majors move as ONE bet; refusing to stack another. ` +
        'Stand down or wait for an exit.',
    );
    this.name = 'ScoutPortfolioCapError';
  }
}

/** Throw when opening a directional major would exceed the same-direction cap.
 *  `sameDirectionOpenCount` = CURRENT open directional positions in this direction
 *  among CORRELATED_MAJORS (excluding this coin — one-per-coin is enforced separately). */
export function assertPortfolioCap(lane: string, coin: string, sameDirectionOpenCount: number): void {
  if (PASSIVE_LANES.has(lane.trim().toLowerCase())) return;
  if (!CORRELATED_MAJORS.has(coin.trim().toUpperCase())) return;
  if (sameDirectionOpenCount >= MAX_SAME_DIRECTION_MAJORS) throw new ScoutPortfolioCapError(sameDirectionOpenCount);
}

/** No NEW directional entries inside this window before a scheduled binary print
 *  (FOMC/CPI/Jackson-Hole class). The scout traded blind into the July FOMC; a binary
 *  print is a coin-flip on a mechanical lane's edge — the forward test should not
 *  contain it. Exits are never gated. */
export const EVENT_ENTRY_BLACKOUT_HOURS = 48;

/** Entries stay blacked out this long AFTER a print too — the vol event is the speech/
 *  release window, not the timestamp (a blackout lifting at 14:00:01 re-legalized
 *  opens mid-keynote; review 08-20). */
export const EVENT_POST_PRINT_BUFFER_HOURS = 4;

export class ScoutEventBlackoutError extends Error {
  constructor(eventName: string, hoursOut: number) {
    super(
      hoursOut >= 0
        ? `Event blackout: '${eventName}' prints in ~${hoursOut.toFixed(0)}h (< ${EVENT_ENTRY_BLACKOUT_HOURS}h) — ` +
          'no new directional paper entries into a scheduled binary. Manage/close existing positions only.'
        : `Event blackout: '${eventName}' printed ~${Math.abs(hoursOut).toFixed(1)}h ago (post-print window ` +
          `${EVENT_POST_PRINT_BUFFER_HOURS}h) — the vol event is still live; no new directional entries yet.`,
    );
    this.name = 'ScoutEventBlackoutError';
  }
}

/** Throw when a directional open lands inside the pre-event blackout. `msToEvent`
 *  null/undefined = no event in the horizon → clear. */
export function assertEventClear(lane: string, eventName: string | null, msToEvent: number | null | undefined): void {
  if (PASSIVE_LANES.has(lane.trim().toLowerCase())) return;
  if (msToEvent == null || !Number.isFinite(msToEvent)) return;
  const hoursOut = msToEvent / 3_600_000;
  if (hoursOut <= EVENT_ENTRY_BLACKOUT_HOURS) throw new ScoutEventBlackoutError(eventName ?? 'scheduled event', hoursOut);
}

/** Hard per-trade risk cap at the EXECUTOR (not the prompt, not the parser's 500
 *  ceiling): the 08-19 anchor bug put a $50-risk entry (~6% of paper equity) in the
 *  ledger because sizing lived in prose. Floor-risk experiments never need more. */
export const SCOUT_MAX_RISK_USD = 15;
/** A stop tighter than this is a noise-harvest, not an invalidation (quant review:
 *  sub-1% stops on majors are ~coin-flips intraday). */
export const SCOUT_MIN_STOP_FRAC = 0.01;

/** Throw if `lane` is killed. Call before any scout-initiated OPEN (never on exits).
 *  Matches a killed name exactly OR as a `<killed>-` prefix, so variant tags cannot
 *  resurrect a killed strategy under an alias — e.g. the daemon's old trigger wording
 *  said "reversion-extreme lane", and `--lane reversion-extreme` must die with
 *  `reversion` (a genuine successor gets a genuinely NEW name, like htf-trend). */
export function assertLaneAlive(lane: string): void {
  const norm = lane.trim().toLowerCase();
  for (const killed of KILLED_LANES) {
    if (norm === killed || norm.startsWith(`${killed}-`)) throw new ScoutKilledLaneError(lane);
  }
  // Allowlist second (the killed check first gives the clearer message for known-dead
  // lanes): anything not explicitly registered is refused — no unregistered lane can
  // quietly start trading again.
  if (!REGISTERED_LANES.has(norm)) throw new ScoutUnregisteredLaneError(lane);
}
