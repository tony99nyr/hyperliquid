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
  /** Owning paper session — surfaced so the headless model can close by (session,coin). */
  sessionId?: string;
  side: Side;
  /** Health engine score 0–100, or null when unavailable. */
  healthScore: number | null;
  unrealizedPnlUsd: number;
  /** Protective stop price, when known (from the safe-exit plan). */
  stopPx?: number | null;
  /** Take-profit target, when known (scout reversion lane — positions.target_px). */
  targetPx?: number | null;
  markPx: number;
}

export type ScoutTriggerKind =
  | 'rubric-go' // a side crossed up into GO
  | 'rubric-jump' // opportunity moved by ≥ jumpThreshold since last cycle
  | 'price-move' // |Δ mark| ≥ moveThresholdPct in ONE cycle (fast spike)
  | 'price-drift' // |Δ mark| ≥ driftThresholdPct vs a rolling anchor (slow trend — either direction)
  | 'position-health-drop' // open position health fell sharply / below the floor
  | 'position-near-stop' // open position is within nearStopPct of its stop
  | 'position-at-target' // open position reached its take-profit target (mechanical reversion exit)
  | 'leader-action' // a rated leader opened/flipped/added big (leader-follow lane wake)
  | 'reversion-extreme'; // a |z|≥minZ statistical stretch printed in a non-trending regime (the fade lane)

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

/** One row from the trader-watch `leader_actions` feed (subset the detector needs). */
export interface ScoutLeaderActionRead {
  /** Feed row id (dedup key across restarts is the timestamp cursor, not ids). */
  id: string | number;
  leaderAddress: string;
  coin: string;
  /** Feed kind: 'open' | 'add' | 'reduce' | 'flip' | 'close' (unknowns are dropped). */
  kind: string;
  newSide: string | null;
  notionalUsd: number;
  /** Signed size change in coin units (positive = grew). */
  sizeDelta: number;
  entryPx: number | null;
  detectedAtMs: number;
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
  /** Cursor (epoch ms) — leader_actions at or before this were already emitted. */
  lastLeaderActionMs?: number;
  /** key `${COIN}:${side}` → epoch ms a reversion-extreme was last EMITTED. A |z|≥minZ
   *  stretch persists across bars; this de-dups to one wake per episode (cooldown). */
  lastReversionEmit?: Record<string, number>;
  /** Epoch ms the daemon last RAN the reversion candle-scan (sub-cadence gate). */
  lastReversionScanAt?: number;
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
  /** Leader open/flip/add below this notional (USD) is noise — no wake. */
  leaderMinNotionalUsd: number;
  /** Max leader-action triggers per cycle (a whale rebalancing burst ≠ N wakes). */
  leaderMaxPerCycle: number;
  /** How often (ms) the daemon runs the heavier reversion candle-scan. 15m candles
   *  don't update faster than 15m, so this is a sub-cadence well below the 60s tick.
   *  0 disables the scan entirely. */
  reversionScanIntervalMs: number;
  /** Don't re-emit a reversion-extreme for the same coin:side within this (ms). A
   *  |z|≥minZ stretch persists across bars; one wake per episode, not one per scan. */
  reversionCooldownMs: number;
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
  leaderMinNotionalUsd: 1_000_000, // rated-whale conviction floor (adds below $1M are churn)
  leaderMaxPerCycle: 5,
  // DISABLED (08-13 review): the reversion-extreme lane is KILLED (21-day bar fired,
  // n=12, −0.55R) — but the daemon kept emitting 'act' triggers whose note invited the
  // fade under the alias 'reversion-extreme' lane (the same stale-directive class that
  // churned trend-follow 42 trades past its bar). 0 turns the scan + its triggers +
  // their candle load off; re-enable ONLY with a freshly pre-registered fade lane.
  reversionScanIntervalMs: 0,
  reversionCooldownMs: 2 * 60 * 60 * 1000, // one wake per coin:side per ~2h episode (≈ the fade hold)
};

export function emptyScoutState(): ScoutState {
  return { lastOpportunity: {}, lastBadge: {}, lastMark: {}, lastHealth: {}, driftAnchorPx: {}, driftAnchorAt: {}, lastLeaderActionMs: 0, lastReversionEmit: {}, lastReversionScanAt: 0 };
}

const sideKey = (coin: string, side: Side): string => `${coin.toUpperCase()}:${side}`;
const coinKey = (coin: string): string => coin.toUpperCase();

export interface DetectScoutTriggersInput {
  rubric: ScoutRubricRead[];
  marks: ScoutMarketRead[];
  positions: ScoutPositionRead[];
  /** Recent rated-leader actions (trader-watch feed) — may be empty. */
  leaderActions?: ScoutLeaderActionRead[];
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
    lastLeaderActionMs: prev.lastLeaderActionMs ?? 0,
    // Reversion scan state is owned by the sub-cadence scan (reversionTriggersFromHits),
    // not this cheap detector — carry it through untouched.
    lastReversionEmit: { ...(prev.lastReversionEmit ?? {}) },
    lastReversionScanAt: prev.lastReversionScanAt ?? 0,
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

    // Take-profit target reached — the MECHANICAL reversion exit (target is always on
    // the profit side, so a favorable cross = target hit; no band). Fires every tick
    // while past target (like near-stop) so the model can't sit on a winner past its
    // registered target — an 'act' wake to close now. target_px is set only for lanes
    // that pass --target (reversion), so this never fires on an untargeted position.
    if (p.targetPx != null && p.targetPx > 0 && p.markPx > 0) {
      const hit = p.side === 'long' ? p.markPx >= p.targetPx : p.markPx <= p.targetPx;
      if (hit) {
        triggers.push({
          kind: 'position-at-target',
          coin: coinKey(p.coin),
          side: p.side,
          urgency: 'act',
          detail: `${coinKey(p.coin)} ${p.side} reached target ${p.targetPx} (mark ${p.markPx}) — CLOSE per the registered reversion exit (mechanical, no discretion)`,
          at: now,
        });
      }
    }
  }

  // --- Leader actions (leader-follow lane, "info"): a rated whale opened / flipped /
  // added ≥ leaderMinNotionalUsd. This is an EVENT cursor over an independent feed —
  // unlike the level detectors above, a skipped event is LOST, not re-read next
  // cycle, so the cursor semantics differ deliberately:
  //   - cursor 0 (first-ever cycle / corrupt state file) BASELINES to `now` and
  //     emits nothing — a 6h-old whale open is a bad wake, matching how the level
  //     detectors baseline on first sight;
  //   - a rebalancing burst emits only the NEWEST leaderMaxPerCycle (most recent =
  //     most actionable); the cursor still advances past the whole burst;
  //   - reduces/closes never wake (shrinking risk ≠ opportunity).
  const cursor = prev.lastLeaderActionMs ?? 0;
  if (cursor === 0) {
    state.lastLeaderActionMs = now;
  } else {
    let newestSeen = cursor;
    const fresh = (input.leaderActions ?? []).filter((a) => a.detectedAtMs > cursor);
    for (const a of fresh) if (a.detectedAtMs > newestSeen) newestSeen = a.detectedAtMs;
    const qualifies = (a: ScoutLeaderActionRead): boolean => {
      const k = a.kind === 'open' || a.kind === 'flip' || a.kind === 'add' ? a.kind : null;
      if (!k) return false;
      if (!(a.notionalUsd >= cfg.leaderMinNotionalUsd)) return false;
      if (k === 'add' && !(a.sizeDelta > 0)) return false;
      return true;
    };
    const emit = fresh
      .filter(qualifies)
      .sort((a, b) => a.detectedAtMs - b.detectedAtMs)
      .slice(-cfg.leaderMaxPerCycle); // newest N, kept in ascending order
    for (const a of emit) {
      const kind = a.kind === 'open' || a.kind === 'flip' ? a.kind : 'add';
      const side = a.newSide === 'long' || a.newSide === 'short' ? a.newSide : undefined;
      triggers.push({
        kind: 'leader-action',
        coin: coinKey(a.coin),
        side: side as Side | undefined,
        urgency: 'info',
        detail: `leader ${a.leaderAddress.slice(0, 10)} ${kind.toUpperCase()} ${side ?? '?'} ${coinKey(a.coin)} $${(a.notionalUsd / 1e6).toFixed(2)}M${a.entryPx != null ? ` @ ${a.entryPx}` : ''} (leader-follow lane candidate)`,
        at: now,
      });
    }
    state.lastLeaderActionMs = newestSeen;
  }

  return { triggers, state };
}

/** True when any trigger is risk-class ("act") — the daemon flags these for priority handling. */
export function hasActTrigger(triggers: ScoutTrigger[]): boolean {
  return triggers.some((t) => t.urgency === 'act');
}

/** One reversion-extreme hit from the scan (subset the trigger builder needs; the full
 *  shape with levels lives in reversion-scan-service). Type-only coupling — this module
 *  stays pure and I/O-free. */
export interface ReversionHitLite {
  coin: string;
  side: Side;
  z: number;
  er: number;
  regime: string;
  regimeConf: number;
  mark: number;
  stop: number;
  target: number;
}

/**
 * PURE: turn reversion-scan hits into `reversion-extreme` triggers, de-duped so a
 * persistent stretch wakes the model ONCE per episode, not every scan. A |z|≥minZ
 * dislocation stays elevated across several bars; without the cooldown the daemon
 * would re-emit the same setup every scan interval and spam the feed. urgency 'act'
 * because a fresh fade is time-sensitive (the edge decays as price reverts) — it also
 * lets the daemon shorten the consumer cadence to participate before the setup is gone.
 * Returns the next state (carry `lastReversionEmit` + `lastReversionScanAt`).
 */
export function reversionTriggersFromHits(
  hits: ReversionHitLite[],
  prev: ScoutState,
  now: number,
  cfg: ScoutTriggerConfig = DEFAULT_SCOUT_TRIGGER_CONFIG,
): { triggers: ScoutTrigger[]; state: ScoutState } {
  const lastEmit: Record<string, number> = { ...(prev.lastReversionEmit ?? {}) };
  const triggers: ScoutTrigger[] = [];
  for (const h of hits) {
    const key = sideKey(h.coin, h.side);
    const prevAt = lastEmit[key] ?? 0;
    if (now - prevAt < cfg.reversionCooldownMs) continue; // still cooling down for this coin:side → no re-wake
    lastEmit[key] = now;
    triggers.push({
      kind: 'reversion-extreme',
      coin: coinKey(h.coin),
      side: h.side,
      urgency: 'act',
      detail:
        `${h.side.toUpperCase()} fade z=${h.z.toFixed(2)} ER=${h.er.toFixed(2)} ` +
        `regime=${h.regime}/${Math.round(h.regimeConf * 100)}% mark=${h.mark} stop=${h.stop} tgt=${h.target} ` +
        `(reversion-extreme lane — re-validate freshness before acting)`,
      at: now,
    });
  }
  return { triggers, state: { ...prev, lastReversionEmit: lastEmit, lastReversionScanAt: now } };
}
