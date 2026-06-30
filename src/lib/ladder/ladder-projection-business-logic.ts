/**
 * PURE per-rung PROJECTION + PROXIMITY — the numbers the operator reads to answer
 * "where will it fire, how close is it, and what's the trade?" for EACH rung. No I/O,
 * no React, no keys — fixture-testable, shared by the detail modal and the cockpit's
 * Armed-Ladders panel so the two surfaces never drift.
 *
 * Projection reuses the canonical arm-time resolution (`resolveArmRung`) so what's shown
 * here is exactly what ARM consents to and FIRE executes (entry = trigger, risk-sized
 * size, derived stop). Reward/R:R are display-only (target is optional).
 */

import { resolveArmRung } from './ladder-arm-business-logic';
import { rungWorstCaseLoss } from './ladder-risk-business-logic';
import type { LadderRung, LadderSide, RungTriggerKind } from './ladder-types';

/** The full trade a rung projects: levels, size, and the risk/reward read. */
export interface RungProjection {
  entryPx: number | null;
  stopPx: number | null;
  targetPx: number | null;
  sizeCoins: number | null;
  leverage: number | null;
  /** entry · size (USD). */
  notionalUsd: number | null;
  /** notional / leverage (USD). */
  marginUsd: number | null;
  /** Clean risk to the stop: |entry − stop| · size (≈ the configured riskUsd). */
  riskUsd: number | null;
  /** Honest max risk: the stop fires as an HL market-on-trigger and SLIPS the full 10%
   *  tolerance (worstStopFill). Always ≥ riskUsd — this is the number that can actually
   *  hit the account, so the card must show it, not just the clean stop risk. */
  slippedRiskUsd: number | null;
  /** |entry − stop| / entry. */
  stopPct: number | null;
  /** Reward at the target: |target − entry| · size (null when no target). */
  rewardUsd: number | null;
  /** |target − entry| / entry (null when no target). */
  targetPct: number | null;
  /** reward / risk (null when either is missing). */
  rrRatio: number | null;
}

/** Project a rung into its readable trade. PURE. */
export function projectRung(rung: LadderRung): RungProjection {
  const a = resolveArmRung(rung);
  const { entryPx, stopPx, sizeCoins, leverage } = a;
  const targetPx = rung.targetPx;
  const has = (v: number | null | undefined): v is number => v != null && Number.isFinite(v) && v > 0;

  const notionalUsd = has(entryPx) && has(sizeCoins) ? entryPx * sizeCoins : null;
  const marginUsd = notionalUsd != null && has(leverage) ? notionalUsd / leverage : null;

  const riskUsd = has(entryPx) && has(stopPx) && has(sizeCoins) ? Math.abs(entryPx - stopPx) * sizeCoins : null;
  // The real, slippage-bounded loss the stop can take (market-on-trigger, 10% tol). 0 → null.
  const slipped = rungWorstCaseLoss({ side: rung.side, action: rung.action, entryPx, sizeCoins, stopPx });
  const slippedRiskUsd = slipped > 0 ? slipped : null;
  const stopPct = has(entryPx) && has(stopPx) ? Math.abs(entryPx - stopPx) / entryPx : null;

  const rewardUsd = has(entryPx) && has(targetPx) && has(sizeCoins) ? Math.abs(targetPx - entryPx) * sizeCoins : null;
  const targetPct = has(entryPx) && has(targetPx) ? Math.abs(targetPx - entryPx) / entryPx : null;
  const rrRatio = rewardUsd != null && riskUsd != null && riskUsd > 0 ? rewardUsd / riskUsd : null;

  return { entryPx, stopPx, targetPx: targetPx ?? null, sizeCoins, leverage, notionalUsd, marginUsd, riskUsd, slippedRiskUsd, stopPct, rewardUsd, targetPct, rrRatio };
}

/** Where the live mark sits relative to a rung's price trigger — the "is it close?" read. */
export interface RungProximity {
  /** True once the mark is through the level (fires on the next completed 15m close). */
  primed: boolean;
  /** Fractional distance still to cover (0 when primed). */
  pct: number;
  /** Which way the mark must move to trigger. */
  direction: 'up' | 'down' | null;
  /** The trigger level. */
  toPx: number | null;
}

/**
 * Distance from the live mark to a price trigger. Null for non-price triggers or a
 * missing/invalid mark (the caller renders nothing then). PURE — the single home for
 * the proximity math both the modal and the cockpit panel consume.
 */
export function rungProximity(
  trigger: { triggerKind: RungTriggerKind; triggerPx: number | null },
  markPx: number | null | undefined,
): RungProximity | null {
  if (markPx == null || !(markPx > 0) || trigger.triggerPx == null || !(trigger.triggerPx > 0)) return null;
  if (trigger.triggerKind === 'price_above') {
    if (markPx >= trigger.triggerPx) return { primed: true, pct: 0, direction: 'up', toPx: trigger.triggerPx };
    return { primed: false, pct: (trigger.triggerPx - markPx) / markPx, direction: 'up', toPx: trigger.triggerPx };
  }
  if (trigger.triggerKind === 'price_below') {
    if (markPx <= trigger.triggerPx) return { primed: true, pct: 0, direction: 'down', toPx: trigger.triggerPx };
    return { primed: false, pct: (markPx - trigger.triggerPx) / markPx, direction: 'down', toPx: trigger.triggerPx };
  }
  return null;
}

/** A single horizontal level to overlay on the ladder chart (rung trigger/stop/target). */
export interface LadderChartLine {
  price: number;
  /** 'trigger' | 'stop' | 'target' — the caller maps these to colors. */
  role: 'trigger' | 'stop' | 'target';
  side: LadderSide;
  /** Short axis label, e.g. "R1 ▲" / "R1 stop" / "R1 tp" (or just "ENTRY" for a lone rung). */
  title: string;
  seq: number;
}

/**
 * Build the chart overlay lines for a coin's rungs (trigger + stop + target each). For a
 * single rung the labels are the plain ENTRY/STOP/TARGET; for several they carry the rung
 * seq so the operator can tell which level is which. Only price-triggered rungs contribute
 * a trigger line (a volume/funding rung has no chart level). PURE.
 */
export function buildLadderChartLines(rungs: LadderRung[], coin: string): LadderChartLine[] {
  const mine = rungs.filter((r) => r.coin.toUpperCase() === coin.toUpperCase());
  const lone = mine.length === 1;
  const lines: LadderChartLine[] = [];
  for (const r of mine) {
    const p = projectRung(r);
    const tag = lone ? '' : `R${r.seq} `;
    const arrow = r.triggerKind === 'price_above' ? '▲' : r.triggerKind === 'price_below' ? '▼' : '';
    if (p.entryPx != null && (r.triggerKind === 'price_above' || r.triggerKind === 'price_below')) {
      lines.push({ price: p.entryPx, role: 'trigger', side: r.side, seq: r.seq, title: lone ? 'ENTRY' : `${tag}${arrow}`.trim() });
    }
    if (p.stopPx != null) lines.push({ price: p.stopPx, role: 'stop', side: r.side, seq: r.seq, title: lone ? 'STOP' : `${tag}stop` });
    if (p.targetPx != null) lines.push({ price: p.targetPx, role: 'target', side: r.side, seq: r.seq, title: lone ? 'TARGET' : `${tag}tp` });
  }
  return lines;
}

/** The entry (trigger) level of an ARMED, still-PENDING `open` rung, tagged with the
 *  ladder's id8 so the operator can tell which ladder a line belongs to. */
export interface ArmedEntryLine {
  price: number;
  side: LadderSide;
  /** Up (price_above) or down (price_below) breakout. */
  dir: 'up' | 'down';
  /** First 8 chars of the ladder id (matches the `arm <id8>` phrase). */
  ladderId8: string;
  title: string;
}

/**
 * Across several armed ladders, the pending `open`-rung entry levels for ONE coin — for
 * overlaying on the main cockpit chart so the operator sees where their armed entries sit.
 * ONLY `open` rungs that are still `pending` and price-triggered (the at-a-glance "where
 * will this ladder enter"); stops/targets/adds stay in the detail modal. Each line carries
 * the ladder id8 in its title. PURE.
 */
export function buildArmedEntryLines(ladders: { id: string; rungs: LadderRung[] }[], coin: string): ArmedEntryLine[] {
  const out: ArmedEntryLine[] = [];
  for (const l of ladders) {
    const id8 = l.id.slice(0, 8);
    for (const r of l.rungs) {
      if (r.action !== 'open' || r.status !== 'pending') continue;
      if (r.coin.toUpperCase() !== coin.toUpperCase()) continue;
      if (r.triggerKind !== 'price_above' && r.triggerKind !== 'price_below') continue;
      if (r.triggerPx == null || !(r.triggerPx > 0)) continue;
      const dir = r.triggerKind === 'price_above' ? 'up' : 'down';
      out.push({ price: r.triggerPx, side: r.side, dir, ladderId8: id8, title: `⚡${id8} ${dir === 'up' ? '▲' : '▼'}` });
    }
  }
  return out;
}
