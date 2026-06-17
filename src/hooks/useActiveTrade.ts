'use client';

/**
 * useActiveTrade — assembles the chart's trade overlay (entry / stop / target)
 * from the live position (usePositionPnl) + the current Safe-Exit plan
 * (useSafeExitPlan), filtered to the displayed coin. The exit plan's reduce-only
 * limit price is the protective STOP for a long-into-bid / short-into-ask close;
 * we surface it as the stop line. No target is tracked server-side yet, so it is
 * left null (the chart simply omits the target line).
 *
 * Returns null when there is no open position for the coin (chart renders clean).
 */

import { usePositionPnl } from './usePositionPnl';
import { useSafeExitPlan } from './useSafeExitPlan';
import type { ActiveTrade } from '@/app/cockpit/components/chart/candle-chart-helpers';

export function useActiveTrade(sessionId: string | null, coin: string): ActiveTrade | null {
  const { positions } = usePositionPnl(sessionId);
  const { plan } = useSafeExitPlan(sessionId);

  const norm = coin.trim().toUpperCase();
  const pos = positions.find((p) => p.side !== 'flat' && p.coin.toUpperCase() === norm);
  if (!pos) return null;

  // The exit plan's limit (when it's a resting limit close for THIS coin) is the
  // protective price the operator is watching against — surface it as the stop.
  const stopPx =
    plan && plan.intent.coin?.toUpperCase() === norm && typeof plan.intent.limitPx === 'number'
      ? plan.intent.limitPx
      : null;

  return {
    side: pos.side === 'short' ? 'short' : 'long',
    entryPx: pos.avgEntryPx || null,
    stopPx,
    targetPx: null,
  };
}
