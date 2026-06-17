/**
 * PURE builders for the trader-detail "Mirror this →" surface.
 *
 * Execution is Claude-proposes / you-approve — the UI CANNOT place a trade. So
 * "Mirror this" does NOT fake auto-execution; it surfaces the exact
 * `pnpm skill:run-session` command the operator runs in their Claude session,
 * pre-filled from the trader's largest open position. No I/O, no React.
 */

import type { HlPosition } from '@/lib/hyperliquid/hyperliquid-info-service';
import type { OrderSide } from '@/types/fill';

export interface MirrorTarget {
  coin: string;
  side: OrderSide;
  /** The position's notional (USD) — used only to rank "top" position. */
  notionalUsd: number;
}

/**
 * Pick the trader's TOP open position (largest absolute notional) as the mirror
 * target, mapping long→buy / short→sell. Returns null when they hold nothing.
 * PURE.
 */
export function pickMirrorTarget(positions: HlPosition[]): MirrorTarget | null {
  let best: HlPosition | null = null;
  for (const p of positions) {
    if (p.size <= 0) continue;
    const notional = Math.abs(p.positionValue) || p.size * (p.entryPx ?? 0);
    if (!best || notional > (Math.abs(best.positionValue) || 0)) best = p;
  }
  if (!best) return null;
  return {
    coin: best.coin,
    side: best.side === 'short' ? 'sell' : 'buy',
    notionalUsd: Math.abs(best.positionValue),
  };
}

export interface MirrorCommandInput {
  target: MirrorTarget;
  leaderAddress: string;
  /** Risk budget (USD) the operator wants to put on the mirror (default 100). */
  riskUsd?: number;
  /** Stop distance as a fraction of entry (default 0.05 = 5%). */
  stopFrac?: number;
}

/** Shell-escape a thesis string for safe inclusion in the surfaced command. */
function quote(s: string): string {
  return `"${s.replace(/"/g, '\\"')}"`;
}

/**
 * Build the exact `pnpm skill:run-session` command to mirror the target. PURE.
 * The operator copies this and runs it in their Claude session — the approval
 * popup still gates execution (NO-AUTO-FIRE). Never executes anything itself.
 */
export function buildMirrorCommand(input: MirrorCommandInput): string {
  const { target, leaderAddress } = input;
  const risk = input.riskUsd ?? 100;
  const stop = input.stopFrac ?? 0.05;
  const thesis = `mirror ${shortAddr(leaderAddress)} ${target.side === 'buy' ? 'long' : 'short'} ${target.coin}`;
  return [
    'pnpm skill:run-session',
    `--coin ${target.coin}`,
    `--side ${target.side}`,
    `--leader ${leaderAddress}`,
    `--risk ${risk}`,
    `--stop-frac ${stop}`,
    `--thesis ${quote(thesis)}`,
  ].join(' ');
}

/** 0x1234…abcd short form for the thesis. PURE. */
export function shortAddr(addr: string): string {
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}
