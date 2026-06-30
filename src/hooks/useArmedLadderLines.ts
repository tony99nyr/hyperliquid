'use client';

/**
 * useArmedLadderLines — pending entry levels of ARMED ladders for ONE coin, as chart
 * price-lines for the main cockpit chart. Polls the armed-ladder endpoint and maps each
 * armed `open` rung's trigger to a side-coloured dashed line tagged with the ladder id8
 * (so the operator sees WHERE an armed ladder will enter, on the chart they're watching).
 *
 * Side-coloured + dashed distinguishes a not-yet-fired ARMED level from the solid active-
 * trade lines. Empty (no overlay) when the coin has no armed open rung.
 */

import { useMemo } from 'react';
import { usePolledEndpoint } from './usePolledEndpoint';
import { buildArmedEntryLines } from '@/lib/ladder/ladder-projection-business-logic';
import type { TradePriceLine } from '@/app/cockpit/components/chart/candle-chart-helpers';
import type { LadderWithRungs } from '@/lib/ladder/ladder-types';

// Armed-ladder line palette (matches ZONE_COLORS — long green / short red). Inlined so a
// hook needn't import the cockpit component styles.
const LONG = '#19c98a';
const SHORT = '#f24d5e';

// Module-scope (stable identity) so usePolledEndpoint's effect deps don't churn every render.
const pickArmed = (j: Record<string, unknown>): LadderWithRungs[] | undefined =>
  Array.isArray(j.ladders) ? (j.ladders as LadderWithRungs[]) : undefined;

export function useArmedLadderLines(coin: string): TradePriceLine[] {
  const { data } = usePolledEndpoint<LadderWithRungs[]>(
    '/api/cockpit/ladder?status=armed&withRungs=1',
    true,
    pickArmed,
    8000,
  );
  return useMemo(
    () =>
      buildArmedEntryLines(data ?? [], coin).map((l) => ({
        price: l.price,
        title: l.title,
        color: l.side === 'long' ? LONG : SHORT,
        dashed: true,
      })),
    [data, coin],
  );
}
