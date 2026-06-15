/**
 * THE key seam test (ADR-0001). A paper-source fill and a live-source fill with
 * identical px/sz/coin/side MUST fold to identical position + P&L outcomes. The
 * ONLY field that differs is `source` (recorded for audit, never branched on).
 *
 * This pins down the hard requirement: downstream code is mode-unaware. If
 * anyone ever adds a `if (fill.source === ...)` to the position/pnl path, the
 * two outcomes diverge and this test fails.
 */

import { describe, it, expect } from 'vitest';
import type { CanonicalFill, TradingMode } from '@/types/fill';
import { applyFills } from '@/lib/trading/pnl-business-logic';
import { nextPosition } from '@/lib/trading/position-tracker';

/** Same economics, two sources. hlOrderId/hlRaw populated only for live. */
function fillWithSource(source: TradingMode, base: Pick<CanonicalFill, 'side' | 'px' | 'sz'> & Partial<CanonicalFill>): CanonicalFill {
  return {
    clientIntentId: base.clientIntentId ?? 'intent-x',
    sessionId: base.sessionId ?? 'session-x',
    coin: base.coin ?? 'ETH',
    side: base.side,
    px: base.px,
    sz: base.sz,
    notionalUsd: base.px * base.sz,
    feeUsd: base.feeUsd ?? 0.5,
    reduceOnly: base.reduceOnly ?? false,
    partial: base.partial ?? false,
    source,
    hlOrderId: source === 'live' ? 'hl-12345' : null,
    hlRaw: source === 'live' ? { oid: 12345, status: 'filled' } : null,
    filledAt: base.filledAt ?? 1_700_000_000_000,
  };
}

describe('mode-agnosticism (the seam guarantee)', () => {
  it('identical paper vs live fills fold to identical single-fill positions', () => {
    const economics = { side: 'buy' as const, px: 2000, sz: 1.5, feeUsd: 0.75 };
    const paper = fillWithSource('paper', economics);
    const live = fillWithSource('live', economics);

    // Only `source` (and the live-only HL metadata) differs.
    expect(paper.source).toBe('paper');
    expect(live.source).toBe('live');
    expect(live.hlOrderId).not.toBeNull();
    expect(paper.hlOrderId).toBeNull();

    const fromPaper = nextPosition(undefined, paper);
    const fromLive = nextPosition(undefined, live);

    expect(fromPaper).toEqual(fromLive);
  });

  it('identical paper vs live fill SEQUENCES fold to identical positions + P&L', () => {
    const sequence: Array<Pick<CanonicalFill, 'side' | 'px' | 'sz'> & Partial<CanonicalFill>> = [
      { side: 'buy', px: 2000, sz: 2, feeUsd: 1 },
      { side: 'buy', px: 2200, sz: 1, feeUsd: 0.5 },
      { side: 'sell', px: 2500, sz: 2, feeUsd: 1.25 },
      { side: 'sell', px: 2300, sz: 2, feeUsd: 1 }, // flips long → short
    ];

    const paperFills = sequence.map((e) => fillWithSource('paper', e));
    const liveFills = sequence.map((e) => fillWithSource('live', e));

    const paperPos = applyFills('ETH', paperFills);
    const livePos = applyFills('ETH', liveFills);

    // The whole position — side, size, avg entry, realized P&L, fees — matches.
    expect(paperPos).toEqual(livePos);
  });

  it('mark-to-market is identical because the position is identical', () => {
    const economics = { side: 'sell' as const, px: 3000, sz: 1 };
    const paperPos = applyFills('ETH', [fillWithSource('paper', economics)]);
    const livePos = applyFills('ETH', [fillWithSource('live', economics)]);
    expect(paperPos.avgEntryPx).toBe(livePos.avgEntryPx);
    expect(paperPos.side).toBe(livePos.side);
  });
});
