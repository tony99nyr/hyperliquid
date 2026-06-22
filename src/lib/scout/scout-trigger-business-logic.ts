/**
 * PURE scout-trigger logic — the FREE deterministic layer of the autonomous
 * paper scout. Given the latest deterministic reads (rubric scores, fresh marks,
 * open paper positions) and the prior cycle's state, decide whether anything
 * MATERIAL just happened that is worth waking a (cheap) model to look at.
 *
 * This costs ZERO model tokens — it is plain comparison logic the `scout-watch`
 * daemon runs every ~60s. A model is only invoked when this emits a trigger, so
 * Opus/Sonnet usage is rationed to moments that actually matter (the inverted
 * loop). No I/O here — the daemon fetches inputs + persists `state`. Fixture-tested.
 *
 * Triggers are deduped via transition detection against `prev` state: a side that
 * STAYS at GO does not re-fire every cycle; only the NO-EDGE/WATCH → GO crossing
 * does. Likewise health-floor fires once on the downward crossing, not repeatedly.
 */

export type Side = 'long' | 'short';

/** Latest rubric read for one coin×side (mapped from rubric_scores by the daemon). */
export interface ScoutRubricRead {
  coin: string;
  side: Side;
  /** 0–100 deterministic opportunity score. */
  opportunity: number;
  badge: 'GO' | 'WATCH' | 'NO-EDGE';
}

/** Fresh mark for a coin. */
export interface ScoutMarketRead {
  coin: string;
  markPx: number;
}

/** An open PAPER position the scout is managing (mapped from positions by the daemon). */
export interface ScoutPositionRead {
  coin: string;
  side: Side;
  /** Health engine score 0–100, or null when unavailable. */
  healthScore: number | null;
  unrealizedPnlUsd: number;
  /** Protective stop price, when known (from the safe-exit plan). */
  stopPx?: number | null;
  markPx: number;
}

export type ScoutTriggerKind =
  | 'rubric-go' // a side crossed up into GO
  | 'rubric-jump' // opportunity moved by ≥ jumpThreshold since last cycle
  | 'price-move' // |Δ mark| ≥ moveThresholdPct in ONE cycle (fast spike)
  | 'price-drift' // |Δ mark| ≥ driftThresholdPct vs a rolling anchor (slow trend — either direction)
  | 'position-health-drop' // open position health fell sharply / below the floor
  | 'position-near-stop'; // open position is within nearStopPct of its stop

/** "info" = a fresh opportunity to consider; "act" = open-position risk (escalate first). */
export type ScoutUrgency = 'info' | 'act';

export interface ScoutTrigger {
  kind: ScoutTriggerKind;
  coin: string;
  side?: Side;
  urgency: ScoutUrgency;
  /** Human-readable one-liner the cycle prompt / log shows. */
  detail: string;
  /** Epoch ms — INJECTED (no Date.now() in pure code). */
  at: number;
}

/** Carried between cycles by the daemon so transitions (not levels) drive triggers. */
export interface ScoutState {
  /** key `${COIN}:${side}` → last opportunity score. */
  lastOpportunity: Record<string, number>;
  /** key `${COIN}:${side}` → last badge. */
  lastBadge: Record<string, string>;
  /** key `COIN` → last mark. */
  lastMark: Record<string, number>;
  /** key `${COIN}:${side}` → last position health score. */
  lastHealth: Record<string, number>;
  /** key `COIN` → rolling drift anchor price (does NOT update every cycle, so a
   *  slow cumulative move accumulates against it — catches grinds the per-cycle
   *  `lastMark` delta misses). Resets on a drift trigger or after driftWindowMs. */
  driftAnchorPx: Record<string, number>;
  /** key `COIN` → epoch ms the drift anchor was set. */
  driftAnchorAt: Record<string, number>;
}

export interface ScoutTriggerConfig {
  /** Fire when a side crosses up into GO. */
  goBadge: boolean;
  /** Opportunity-score delta (points) that fires `rubric-jump`. */
  jumpThreshold: number;
  /** |Δ mark| as a percent that fires `price-move`. */
  moveThresholdPct: number;
  /** Health-point drop in one cycle that fires `position-health-drop`. */
  healthDropThreshold: number;
  /** Absolute health below which a position is flagged (on the downward crossing). */
  healthFloor: number;
  /** Distance to stop, as a fraction of mark, that fires `position-near-stop`. */
  nearStopPct: number;
  /** Cumulative |Δ mark| (%) vs the rolling anchor that fires `price-drift` (slow trend). */
  driftThresholdPct: number;
  /** Anchor max age (ms): if no drift trigger fires within this, re-anchor (rolling window). */
  driftWindowMs: number;
}

export const DEFAULT_SCOUT_TRIGGER_CONFIG: ScoutTriggerConfig = {
  goBadge: true,
  jumpThreshold: 15,
  moveThresholdPct: 0.6,
  healthDropThreshold: 15,
  healthFloor: 35,
  nearStopPct: 0.004, // within 0.4% of the stop
  driftThresholdPct: 1.0, // a ≥1% cumulative move (either way) vs the anchor wakes the scout
  driftWindowMs: 4 * 60 * 60 * 1000, // re-anchor every ~4h if no drift trigger fired
};

export function emptyScoutState(): ScoutState {
  return { lastOpportunity: {}, lastBadge: {}, lastMark: {}, lastHealth: {}, driftAnchorPx: {}, driftAnchorAt: {} };
}

const sideKey = (coin: string, side: Side): string => `${coin.toUpperCase()}:${side}`;
const coinKey = (coin: string): string => coin.toUpperCase();

export interface DetectScoutTriggersInput {
  rubric: ScoutRubricRead[];
  marks: ScoutMarketRead[];
  positions: ScoutPositionRead[];
  /** Epoch ms — INJECTED. */
  now: number;
}

/**
 * Compare the latest reads against `prev` and emit material triggers + the next
 * state. PURE: same inputs → identical output. The returned `state` MUST be
 * carried into the next call (the daemon persists it in-process / to disk).
 */
export function detectScoutTriggers(
  input: DetectScoutTriggersInput,
  prev: ScoutState,
  cfg: ScoutTriggerConfig = DEFAULT_SCOUT_TRIGGER_CONFIG,
): { triggers: ScoutTrigger[]; state: ScoutState } {
  const { rubric, marks, positions, now } = input;
  const triggers: ScoutTrigger[] = [];
  const state: ScoutState = {
    lastOpportunity: { ...prev.lastOpportunity },
    lastBadge: { ...prev.lastBadge },
    lastMark: { ...prev.lastMark },
    lastHealth: { ...prev.lastHealth },
    driftAnchorPx: { ...(prev.driftAnchorPx ?? {}) },
    driftAnchorAt: { ...(prev.driftAnchorAt ?? {}) },
  };

  // --- Rubric: GO crossing + opportunity jumps (opportunity layer, "info"). ---
  for (const r of rubric) {
    const k = sideKey(r.coin, r.side);
    const prevOpp = prev.lastOpportunity[k];
    const prevBadge = prev.lastBadge[k];

    if (cfg.goBadge && r.badge === 'GO' && prevBadge !== 'GO') {
      triggers.push({
        kind: 'rubric-go',
        coin: coinKey(r.coin),
        side: r.side,
        urgency: 'info',
        detail: `${coinKey(r.coin)} ${r.side} crossed into GO (opp ${Math.round(r.opportunity)})`,
        at: now,
      });
    } else if (
      prevOpp !== undefined &&
      Math.abs(r.opportunity - prevOpp) >= cfg.jumpThreshold
    ) {
      const dir = r.opportunity >= prevOpp ? '↑' : '↓';
      triggers.push({
        kind: 'rubric-jump',
        coin: coinKey(r.coin),
        side: r.side,
        urgency: 'info',
        detail: `${coinKey(r.coin)} ${r.side} opportunity ${dir} ${Math.round(prevOpp)}→${Math.round(r.opportunity)}`,
        at: now,
      });
    }

    state.lastOpportunity[k] = r.opportunity;
    state.lastBadge[k] = r.badge;
  }

  // --- Price: fast moves since last cycle (opportunity layer, "info"). ---
  for (const m of marks) {
    const k = coinKey(m.coin);
    const prevMark = prev.lastMark[k];
    if (prevMark !== undefined && prevMark > 0) {
      const movePct = ((m.markPx - prevMark) / prevMark) * 100;
      if (Math.abs(movePct) >= cfg.moveThresholdPct) {
        triggers.push({
          kind: 'price-move',
          coin: k,
          urgency: 'info',
          detail: `${k} moved ${movePct >= 0 ? '+' : ''}${movePct.toFixed(2)}% (${prevMark}→${m.markPx})`,
          at: now,
        });
      }
    }
    state.lastMark[k] = m.markPx;

    // Cumulative DRIFT vs a rolling anchor — catches a slow trend (either
    // direction) that never trips the per-cycle move threshold. The anchor only
    // resets on a drift trigger or after driftWindowMs, so a sustained grind
    // accumulates against it. THIS is what a +1.5%/2h move trips that the
    // per-cycle delta misses.
    const anchor = prev.driftAnchorPx?.[k];
    const anchorAt = prev.driftAnchorAt?.[k];
    if (anchor === undefined || anchor <= 0) {
      state.driftAnchorPx[k] = m.markPx;
      state.driftAnchorAt[k] = now;
    } else {
      const driftPct = ((m.markPx - anchor) / anchor) * 100;
      if (Math.abs(driftPct) >= cfg.driftThresholdPct) {
        triggers.push({
          kind: 'price-drift',
          coin: k,
          urgency: 'info',
          detail: `${k} drifted ${driftPct >= 0 ? '+' : ''}${driftPct.toFixed(2)}% vs anchor (${anchor}→${m.markPx}) — slow ${driftPct >= 0 ? 'rally' : 'selloff'}`,
          at: now,
        });
        state.driftAnchorPx[k] = m.markPx; // re-anchor at the trigger point
        state.driftAnchorAt[k] = now;
      } else if (anchorAt !== undefined && now - anchorAt > cfg.driftWindowMs) {
        state.driftAnchorPx[k] = m.markPx; // rolling re-anchor (no trigger)
        state.driftAnchorAt[k] = now;
      }
    }
  }

  // --- Open positions: health drops + stop proximity (risk layer, "act"). ---
  for (const p of positions) {
    const k = sideKey(p.coin, p.side);

    if (p.healthScore != null) {
      const prevHealth = prev.lastHealth[k];
      const crossedFloor =
        p.healthScore < cfg.healthFloor && (prevHealth === undefined || prevHealth >= cfg.healthFloor);
      const sharpDrop = prevHealth !== undefined && prevHealth - p.healthScore >= cfg.healthDropThreshold;
      if (crossedFloor || sharpDrop) {
        triggers.push({
          kind: 'position-health-drop',
          coin: coinKey(p.coin),
          side: p.side,
          urgency: 'act',
          detail: crossedFloor
            ? `${coinKey(p.coin)} ${p.side} health below floor (${Math.round(p.healthScore)})`
            : `${coinKey(p.coin)} ${p.side} health dropped ${Math.round(prevHealth!)}→${Math.round(p.healthScore)}`,
          at: now,
        });
      }
      state.lastHealth[k] = p.healthScore;
    }

    if (p.stopPx != null && p.stopPx > 0 && p.markPx > 0) {
      const distFrac = Math.abs(p.markPx - p.stopPx) / p.markPx;
      // Only fire when the mark is on the losing side of (or at) the stop band.
      const adverse = p.side === 'long' ? p.markPx <= p.stopPx * (1 + cfg.nearStopPct) : p.markPx >= p.stopPx * (1 - cfg.nearStopPct);
      if (distFrac <= cfg.nearStopPct && adverse) {
        triggers.push({
          kind: 'position-near-stop',
          coin: coinKey(p.coin),
          side: p.side,
          urgency: 'act',
          detail: `${coinKey(p.coin)} ${p.side} within ${(distFrac * 100).toFixed(2)}% of stop (${p.stopPx})`,
          at: now,
        });
      }
    }
  }

  return { triggers, state };
}

/** True when any trigger is risk-class ("act") — the daemon flags these for priority handling. */
export function hasActTrigger(triggers: ScoutTrigger[]): boolean {
  return triggers.some((t) => t.urgency === 'act');
}
