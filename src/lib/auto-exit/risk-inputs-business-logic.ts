/**
 * PURE risk-input assembly for Layer-1 auto-exit.
 *
 * Turns the cockpit `Position` (always available) + live mark + the OPTIONAL HL
 * clearinghouse position (live + HL_ACCOUNT_ADDRESS) + the latest health into the
 * `AutoExitInputs` the pure `shouldAutoExit` decision consumes — and resolves
 * which thresholds are applicable given whether clearinghouse data was available.
 *
 * Key property: unrealized P&L is ALWAYS computable (mark vs avg entry), so the
 * loss + health triggers work in every mode. liquidationPx + margin come only
 * from clearinghouse, so when it's absent those triggers are DISABLED in the
 * resolved thresholds (rather than firing "dataDegraded" on every cycle).
 *
 * No I/O. Pinned by tests/lib/auto-exit/risk-inputs-business-logic.test.ts.
 */

import type { Position } from '@/types/position';
import type { HlPosition } from '@/lib/hyperliquid/hyperliquid-info-service';
import type { AutoExitInputs, AutoExitThresholds } from '@/lib/trading/auto-exit-business-logic';

/** The versioned config shape (data/auto-exit/*.json). */
export interface AutoExitConfig {
  liqProximityPct: number;
  maxLossUsd: number | null;
  maxLossPctOfMargin: number | null;
  minHealthScore: number | null;
  hardExitAlerts: string[];
  /**
   * Active-lock window (ms). Doubles as the re-fire cooldown for an UNKNOWN-outcome
   * fire (the close threw → lock held this long before a retry can re-acquire) and
   * as the stuck-lock reaper window (serverless death before release).
   */
  lockTtlMs: number;
}

/** Unrealized P&L in USD from the cockpit position + mark. long: (mark−entry)·sz; short inverts. */
export function computeUnrealizedPnlUsd(position: Pick<Position, 'side' | 'sz' | 'avgEntryPx'>, markPx: number): number {
  if (position.side === 'flat') return 0;
  const dir = position.side === 'long' ? 1 : -1;
  return (markPx - position.avgEntryPx) * position.sz * dir;
}

export interface BuildInputsArgs {
  position: Position;
  markPx: number;
  /** From clearinghouseState (live + address); null/undefined when unavailable. */
  hlPosition?: HlPosition | null;
  healthScore?: number | null;
  alerts?: string[];
}

/** Assemble `AutoExitInputs`. Prefers clearinghouse uPnL/liq/margin when present. */
export function buildAutoExitInputs(a: BuildInputsArgs): AutoExitInputs {
  // flat should be filtered upstream; default to 'short' is never reached for a real call.
  const side: 'long' | 'short' = a.position.side === 'long' ? 'long' : 'short';
  const hasCh = a.hlPosition != null;
  const upnl =
    hasCh && Number.isFinite(a.hlPosition!.unrealizedPnl)
      ? a.hlPosition!.unrealizedPnl
      : computeUnrealizedPnlUsd(a.position, a.markPx);
  return {
    coin: a.position.coin,
    side,
    markPx: a.markPx,
    liquidationPx: a.hlPosition?.liquidationPx ?? null,
    unrealizedPnlUsd: upnl,
    // NaN when clearinghouse is absent — but resolveThresholds() disables the
    // margin-pct trigger in that case, so it's never read.
    marginUsd: hasCh ? a.hlPosition!.marginUsed : Number.NaN,
    healthScore: a.healthScore ?? null,
    alerts: a.alerts ?? [],
  };
}

/**
 * Resolve the applicable thresholds. Without clearinghouse data the liq-proximity
 * (needs liq px) and max-loss-%-of-margin (needs margin) triggers are disabled;
 * the always-computable loss-USD + health triggers remain.
 */
export function resolveThresholds(config: AutoExitConfig, hasClearinghouse: boolean): AutoExitThresholds {
  return {
    liqProximityPct: hasClearinghouse ? config.liqProximityPct : 0,
    maxLossUsd: config.maxLossUsd,
    maxLossPctOfMargin: hasClearinghouse ? config.maxLossPctOfMargin : null,
    minHealthScore: config.minHealthScore,
    hardExitAlerts: config.hardExitAlerts,
  };
}
