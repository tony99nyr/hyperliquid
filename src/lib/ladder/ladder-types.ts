/**
 * Armed Ladder — shared TypeScript types (mirror of migration 0023).
 *
 * A ladder is an operator-authored, multi-rung execution plan; each rung is a
 * {deterministic trigger → pre-authorized order}. These types are the contract
 * shared by the persistence layer, the PURE trigger evaluator, the arm/fire routes,
 * the NAS watcher, and the preview modal — ONE shape so nothing drifts.
 *
 * Authority lives in the fire route, NEVER in these types or the evaluator.
 */

export type LadderAuthor = 'operator' | 'scout';
export type LadderMode = 'paper' | 'live';
export type LadderStatus = 'draft' | 'armed' | 'disarmed' | 'done' | 'expired';
export type LadderSide = 'long' | 'short';

/** What a rung DOES when it fires. open/add INCREASE exposure (gated by the
 *  pyramiding guardrails); reduce/close DECREASE it (reduce-only). */
export type RungAction = 'open' | 'add' | 'reduce' | 'close';

/** The deterministic trigger kind. price_above/price_below are natively
 *  HL-expressible; volume/funding/indicator need the watcher (HL triggers are
 *  price-on-mark only). All evaluated on COMPLETED candles (never the in-progress bar). */
export type RungTriggerKind = 'price_above' | 'price_below' | 'volume' | 'funding' | 'indicator';

// --- Momentum indicator names: the SINGLE source of truth (pure — importable by the
// evaluator, arm validation, AND the server-only publisher without a purity violation).
// Rename here and every producer/consumer moves together; a stray literal elsewhere
// would fail closed (indicator absent → no fire), so keep them ALL on these exports. ---
export const MOMENTUM_STALL_LONG = 'momentum-stall-long';
export const MOMENTUM_STALL_SHORT = 'momentum-stall-short';
export const SUPPORTED_INDICATOR_NAMES: readonly string[] = [MOMENTUM_STALL_LONG, MOMENTUM_STALL_SHORT];
/** The stall indicator measuring signals AGAINST a position of `side`. */
export const momentumStallIndicatorName = (side: LadderSide): string =>
  side === 'long' ? MOMENTUM_STALL_LONG : MOMENTUM_STALL_SHORT;

/** Where `now` sits relative to an armed ladder's evaluation window. ONE predicate for
 *  the watcher + the fire path (their ACTIONS differ; the time semantics must not). */
export type LadderWindowState = 'expired' | 'before-window' | 'active';
export function ladderWindowState(l: { expiresAt: string | null; activeFrom: string | null }, now: number): LadderWindowState {
  if (l.expiresAt && now >= Date.parse(l.expiresAt)) return 'expired';
  if (l.activeFrom && now < Date.parse(l.activeFrom)) return 'before-window';
  return 'active';
}

export type RungStatus = 'pending' | 'fired' | 'skipped' | 'failed' | 'cancelled';

/** A single pre-authorized order within a ladder. */
export interface LadderRung {
  id: string;
  ladderId: string;
  /** Order within the ladder (1-based). */
  seq: number;
  coin: string;
  side: LadderSide;
  action: RungAction;
  triggerKind: RungTriggerKind;
  /** Price level for price_above / price_below. */
  triggerPx: number | null;
  /** Params for volume / funding / indicator triggers (see the evaluator). */
  triggerMeta: RungTriggerMeta | null;
  /** Explicit size, OR null when risk-based (riskUsd + stopFrac, server-sized). */
  sizeCoins: number | null;
  /** reduce/close ONLY: trim this FRACTION (0,1] of the CURRENT live position at fire,
   *  instead of the absolute sizeCoins (path-independent — robust to which rungs filled).
   *  Preferred over sizeCoins by the fire path; null = use sizeCoins (or full close). */
  reduceFrac: number | null;
  riskUsd: number | null;
  stopFrac: number | null;
  leverage: number | null;
  /** The protective bracket this rung rests atomically with its fill. */
  stopPx: number | null;
  targetPx: number | null;
  status: RungStatus;
  /** Deterministic per-rung client order id (= `${ladderId}:${id}`) — exchange-level
   *  double-fire rejection. Set at arm time. */
  cloid: string | null;
}

/** Trigger parameters for the non-price (watcher-only) kinds. A discriminated bag —
 *  the evaluator reads only the fields its `triggerKind` needs. */
export interface RungTriggerMeta {
  /** volume: completed-candle volume must be >= this. */
  minVolume?: number;
  /** funding/indicator: comparison direction. */
  op?: 'above' | 'below';
  /** funding: the funding-rate threshold (same units as the snapshot's fundingRate). */
  fundingRate?: number;
  /** indicator: the named indicator + threshold (snapshot.indicators[name]). */
  indicatorName?: string;
  indicatorValue?: number;
  /** price_above/price_below OPEN/ADD rungs (optional): require momentum SUPPORT at the
   *  price trigger — fires only when `momentum-stall-<side>` shows ≤ momentumMaxFlips
   *  signals against the direction (default 0: clean tape/book/volume). RESTRICTIVE
   *  ONLY: it can delay/prevent an entry, never cause one; missing momentum data
   *  fails closed (no entry on blind data). */
  momentumConfirm?: boolean;
  /** Max stall signals against the direction the confirm tolerates (default 0, max 2). */
  momentumMaxFlips?: number;
  /** indicator (optional): a price FLOOR the completed close must also clear before the
   *  indicator can fire — long reduce: close ≥ floorPx; short reduce: close ≤ floorPx.
   *  This is how a momentum exit is prevented from firing before the move has paid
   *  ("exit on stall, but only above X"). Absent = indicator alone decides. */
  floorPx?: number;
}

/** The armed plan. */
export interface Ladder {
  id: string;
  title: string;
  thesis: string | null;
  author: LadderAuthor;
  mode: LadderMode;
  status: LadderStatus;
  /** Arm-time live-state snapshot hash (precondition re-checked at fire). */
  preconditionHash: string | null;
  /** OCO group (one-cancels-other): ladders sharing this id are mutually exclusive — the
   *  first to FIRE a rung auto-disarms every other armed ladder in the group. Used to make
   *  a long+short straddle (two ladders, since long+short can't share one) self-managing.
   *  null = ungrouped (default; behaves exactly as a standalone ladder). The OCO action
   *  only DISARMS — it can never open/add/move money. */
  ocoGroupId: string | null;
  /** Copy-thesis tag: the wallet this ladder follows. When set, the leader guard
   *  AUTO-DISARMS the armed ladder if the trader-watch feed shows the leader closed or
   *  flipped the coin after arming (disarm-only — the guard can never fire anything).
   *  null = not a copy trade. */
  leaderAddress: string | null;
  maxTotalNotionalUsd: number | null;
  maxTotalLossUsd: number | null;
  expiresAt: string | null;
  /** Earliest evaluation/fire time (ISO); null = active immediately on arm. The
   *  activation window is PURELY RESTRICTIVE — it can only prevent fires. */
  activeFrom: string | null;
  armedAt: string | null;
  disarmedAt: string | null;
  disarmReason: string | null;
  /** Soft-archive tombstone: when set, the ladder is hidden from the active UI lists but
   *  KEPT in the DB for the audit trail. Only a non-armed ladder can be archived. */
  archivedAt: string | null;
  /** Once-only dedupe stamp: when the expiry-approaching alert has paged the operator. */
  expiryAlertAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A ladder plus its rungs (the shape the preview modal + fire route load). */
export interface LadderWithRungs extends Ladder {
  rungs: LadderRung[];
}
