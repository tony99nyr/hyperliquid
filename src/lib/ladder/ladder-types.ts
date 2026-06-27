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
  maxTotalNotionalUsd: number | null;
  maxTotalLossUsd: number | null;
  expiresAt: string | null;
  armedAt: string | null;
  disarmedAt: string | null;
  disarmReason: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A ladder plus its rungs (the shape the preview modal + fire route load). */
export interface LadderWithRungs extends Ladder {
  rungs: LadderRung[];
}
