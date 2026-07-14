/**
 * PURE, AUTHORITY-FREE ladder trigger evaluator (architecture §5).
 *
 * Given a rung's pre-authorized trigger spec + a market snapshot built from the most
 * recent COMPLETED candle, decide ONLY whether the condition is met. It emits
 * `{ rungId, conditionMet, reason }` and NOTHING ELSE — no order, no key, no I/O, no
 * decision to fire. The same evaluator feeds the paper sink (scout) and the live sink
 * (`/ladder/fire-rung`); because it holds zero execution authority, a routing bug can
 * never move money — the live sink re-validates mode/author/armed/precondition before
 * any fill. Build it once; keep it authority-free.
 *
 * INVARIANT §3.4 (fail-closed on stale): a stale or malformed snapshot NEVER reports
 * `conditionMet: true`. A lagged candle can't open at a phantom price. Triggers are
 * evaluated on completed candles only (the daemon must pass the completed bar, never
 * the in-progress one).
 */

import type { LadderRung, RungTriggerKind } from './ladder-types';

/** Market read for one coin, built from the most recent COMPLETED candle + live funding.
 *  `stale` is set by the daemon when the feed is lagged/missing — fail-closed. */
export interface RungMarketSnapshot {
  coin: string;
  /** Close of the most recent COMPLETED candle (the level price triggers compare to). */
  completedClose: number;
  /** Volume of that completed candle (for volume triggers). */
  completedVolume?: number;
  /** Current funding rate, same sign/units the rung's threshold uses (for funding triggers). */
  fundingRate?: number;
  /** Named indicator values for indicator triggers (e.g. { rsi14: 71.2 }). */
  indicators?: Record<string, number>;
  /** Feed staleness flag — when true the evaluator fails closed (never met). */
  stale?: boolean;
}

export interface RungConditionResult {
  rungId: string;
  coin: string;
  conditionMet: boolean;
  /** Human-readable one-liner for the log / preview (why it did or didn't fire). */
  reason: string;
}

const KINDS_NEEDING_PRICE: RungTriggerKind[] = ['price_above', 'price_below'];

/**
 * Evaluate ONE rung against its coin's snapshot. PURE. Returns conditionMet=false
 * (with a reason) whenever the snapshot is stale, missing, or the trigger params are
 * incomplete — fail-closed, never throw.
 */
export function evaluateRungTrigger(rung: LadderRung, snapshot: RungMarketSnapshot | undefined): RungConditionResult {
  const base = { rungId: rung.id, coin: rung.coin };

  if (!snapshot) {
    return { ...base, conditionMet: false, reason: `no ${rung.coin} snapshot — fail-closed` };
  }
  // Defense-in-depth: the snapshot MUST be for this rung's coin. If the daemon ever
  // mis-keys snapshotsByCoin, comparing a triggerPx against the wrong coin's price
  // could fire on a phantom level — fail closed rather than trust the lookup.
  if (snapshot.coin?.toUpperCase() !== rung.coin.toUpperCase()) {
    return { ...base, conditionMet: false, reason: `snapshot coin ${snapshot.coin} ≠ rung coin ${rung.coin} — fail-closed` };
  }
  if (snapshot.stale) {
    return { ...base, conditionMet: false, reason: `${rung.coin} feed stale — fail-closed` };
  }
  // A FINITE, positive completed close is required for any price-based reasoning
  // (Number.isFinite rejects Infinity/NaN, which would otherwise pass `> 0`).
  if (KINDS_NEEDING_PRICE.includes(rung.triggerKind) && !(Number.isFinite(snapshot.completedClose) && snapshot.completedClose > 0)) {
    return { ...base, conditionMet: false, reason: `${rung.coin} has no finite completed close — fail-closed` };
  }

  switch (rung.triggerKind) {
    case 'price_above': {
      if (rung.triggerPx == null || !(rung.triggerPx > 0)) {
        return { ...base, conditionMet: false, reason: 'price_above missing triggerPx — fail-closed' };
      }
      const met = snapshot.completedClose >= rung.triggerPx;
      return { ...base, conditionMet: met, reason: `${rung.coin} close ${snapshot.completedClose} ${met ? '≥' : '<'} ${rung.triggerPx} (break up)` };
    }
    case 'price_below': {
      if (rung.triggerPx == null || !(rung.triggerPx > 0)) {
        return { ...base, conditionMet: false, reason: 'price_below missing triggerPx — fail-closed' };
      }
      const met = snapshot.completedClose <= rung.triggerPx;
      return { ...base, conditionMet: met, reason: `${rung.coin} close ${snapshot.completedClose} ${met ? '≤' : '>'} ${rung.triggerPx} (break down)` };
    }
    case 'volume': {
      const minVolume = rung.triggerMeta?.minVolume;
      if (minVolume == null || !(minVolume > 0)) {
        return { ...base, conditionMet: false, reason: 'volume trigger missing minVolume — fail-closed' };
      }
      if (snapshot.completedVolume == null || !Number.isFinite(snapshot.completedVolume)) {
        return { ...base, conditionMet: false, reason: `${rung.coin} has no completed volume — fail-closed` };
      }
      const met = snapshot.completedVolume >= minVolume;
      return { ...base, conditionMet: met, reason: `${rung.coin} vol ${snapshot.completedVolume} ${met ? '≥' : '<'} ${minVolume}` };
    }
    case 'funding': {
      const op = rung.triggerMeta?.op;
      const threshold = rung.triggerMeta?.fundingRate;
      if ((op !== 'above' && op !== 'below') || threshold == null || !Number.isFinite(threshold)) {
        return { ...base, conditionMet: false, reason: 'funding trigger missing op/fundingRate — fail-closed' };
      }
      if (snapshot.fundingRate == null || !Number.isFinite(snapshot.fundingRate)) {
        return { ...base, conditionMet: false, reason: `${rung.coin} has no funding rate — fail-closed` };
      }
      const met = op === 'above' ? snapshot.fundingRate >= threshold : snapshot.fundingRate <= threshold;
      return { ...base, conditionMet: met, reason: `${rung.coin} funding ${snapshot.fundingRate} ${op} ${threshold} → ${met}` };
    }
    case 'indicator': {
      // EXIT-ONLY, enforced in depth: arm validation rejects it, the fire path refuses
      // it, and the evaluator never reports an exposure-increasing indicator rung met.
      if (rung.action === 'open' || rung.action === 'add') {
        return { ...base, conditionMet: false, reason: 'indicator triggers are exit-only — fail-closed on open/add' };
      }
      const op = rung.triggerMeta?.op;
      const name = rung.triggerMeta?.indicatorName;
      const threshold = rung.triggerMeta?.indicatorValue;
      if ((op !== 'above' && op !== 'below') || !name || threshold == null || !Number.isFinite(threshold)) {
        return { ...base, conditionMet: false, reason: 'indicator trigger missing op/name/value — fail-closed' };
      }
      const actual = snapshot.indicators?.[name];
      if (actual == null || !Number.isFinite(actual)) {
        return { ...base, conditionMet: false, reason: `${rung.coin} has no indicator '${name}' — fail-closed` };
      }
      // Optional price floor: the exit only becomes eligible beyond floorPx (side-aware).
      // A present-but-invalid floor fails CLOSED — never fire on a malformed guard.
      const floorPx = rung.triggerMeta?.floorPx;
      if (floorPx !== undefined) {
        if (!(Number.isFinite(floorPx) && floorPx > 0)) {
          return { ...base, conditionMet: false, reason: 'indicator floorPx invalid — fail-closed' };
        }
        if (!(Number.isFinite(snapshot.completedClose) && snapshot.completedClose > 0)) {
          return { ...base, conditionMet: false, reason: `${rung.coin} has no finite completed close for floorPx — fail-closed` };
        }
        const beyondFloor = rung.side === 'long' ? snapshot.completedClose >= floorPx : snapshot.completedClose <= floorPx;
        if (!beyondFloor) {
          return { ...base, conditionMet: false, reason: `${rung.coin} close ${snapshot.completedClose} not beyond floor ${floorPx} (${rung.side}) — indicator gated` };
        }
      }
      const met = op === 'above' ? actual >= threshold : actual <= threshold;
      return { ...base, conditionMet: met, reason: `${rung.coin} ${name} ${actual} ${op} ${threshold} → ${met}${floorPx !== undefined ? ` (floor ${floorPx} cleared)` : ''}` };
    }
    default: {
      // Exhaustive — an unknown kind fails closed rather than throwing.
      return { ...base, conditionMet: false, reason: `unknown trigger kind '${String(rung.triggerKind)}' — fail-closed` };
    }
  }
}

/**
 * Evaluate every PENDING rung against its coin's snapshot. PURE. Only rungs with
 * `status === 'pending'` are considered (a fired/skipped/cancelled rung never
 * re-evaluates). Returns one result per pending rung — the daemon/route decides what
 * to do with the met ones; this function decides nothing about execution.
 */
export function evaluateLadderRungs(
  rungs: LadderRung[],
  snapshotsByCoin: Record<string, RungMarketSnapshot>,
): RungConditionResult[] {
  // Normalize the snapshot keys to UPPER once so the lookup has a single convention
  // (callers may key raw or upper); evaluateRungTrigger still re-asserts coin match.
  const byUpper: Record<string, RungMarketSnapshot> = {};
  for (const [k, v] of Object.entries(snapshotsByCoin)) byUpper[k.toUpperCase()] = v;
  return rungs
    .filter((r) => r.status === 'pending')
    .map((r) => evaluateRungTrigger(r, byUpper[r.coin.toUpperCase()]));
}
