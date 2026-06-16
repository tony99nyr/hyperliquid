import { describe, it, expect } from 'vitest';
import {
  emptyPosition,
  applyFill,
  applyFills,
  unrealizedPnl,
  avgEntry,
  totalPnl,
} from '@/lib/trading/pnl-business-logic';
import type { CanonicalFill } from '@/types/fill';

function fill(partial: Partial<CanonicalFill> & Pick<CanonicalFill, 'side' | 'px' | 'sz'>): CanonicalFill {
  return {
    clientIntentId: partial.clientIntentId ?? 'intent-1',
    sessionId: partial.sessionId ?? 'session-1',
    coin: partial.coin ?? 'ETH',
    side: partial.side,
    px: partial.px,
    sz: partial.sz,
    notionalUsd: partial.notionalUsd ?? partial.px * partial.sz,
    feeUsd: partial.feeUsd ?? 0,
    reduceOnly: partial.reduceOnly ?? false,
    partial: partial.partial ?? false,
    source: partial.source ?? 'paper',
    hlOrderId: partial.hlOrderId ?? null,
    hlRaw: partial.hlRaw ?? null,
    filledAt: partial.filledAt ?? 0,
  };
}

describe('pnl-business-logic', () => {
  describe('emptyPosition', () => {
    it('is flat with zeroed fields', () => {
      const p = emptyPosition('ETH');
      expect(p).toEqual({
        coin: 'ETH',
        side: 'flat',
        sz: 0,
        avgEntryPx: 0,
        realizedPnlUsd: 0,
        feesPaidUsd: 0,
      });
    });
  });

  describe('applyFill — opening + adding (long)', () => {
    it('opens a long from flat', () => {
      const p = applyFill(emptyPosition('ETH'), fill({ side: 'buy', px: 2000, sz: 1 }));
      expect(p.side).toBe('long');
      expect(p.sz).toBe(1);
      expect(p.avgEntryPx).toBe(2000);
      expect(p.realizedPnlUsd).toBe(0);
    });

    it('blends avg entry when adding to a long', () => {
      let p = applyFill(emptyPosition('ETH'), fill({ side: 'buy', px: 2000, sz: 1 }));
      p = applyFill(p, fill({ side: 'buy', px: 3000, sz: 1 }));
      expect(p.side).toBe('long');
      expect(p.sz).toBe(2);
      expect(p.avgEntryPx).toBe(2500); // (2000*1 + 3000*1) / 2
    });
  });

  describe('applyFill — closing realizes P&L', () => {
    it('realizes profit closing a long above entry', () => {
      let p = applyFill(emptyPosition('ETH'), fill({ side: 'buy', px: 2000, sz: 2 }));
      p = applyFill(p, fill({ side: 'sell', px: 2500, sz: 1 }));
      // closed 1 unit at +500
      expect(p.realizedPnlUsd).toBe(500);
      expect(p.side).toBe('long');
      expect(p.sz).toBe(1);
      expect(p.avgEntryPx).toBe(2000); // surviving size keeps entry
    });

    it('fully closes a long to flat', () => {
      let p = applyFill(emptyPosition('ETH'), fill({ side: 'buy', px: 2000, sz: 1 }));
      p = applyFill(p, fill({ side: 'sell', px: 1800, sz: 1 }));
      expect(p.side).toBe('flat');
      expect(p.sz).toBe(0);
      expect(p.avgEntryPx).toBe(0);
      expect(p.realizedPnlUsd).toBe(-200); // closed at a loss
    });
  });

  describe('applyFill — shorts', () => {
    it('opens a short and profits when price falls', () => {
      let p = applyFill(emptyPosition('ETH'), fill({ side: 'sell', px: 2000, sz: 1 }));
      expect(p.side).toBe('short');
      expect(p.avgEntryPx).toBe(2000);
      p = applyFill(p, fill({ side: 'buy', px: 1500, sz: 1 }));
      expect(p.side).toBe('flat');
      expect(p.realizedPnlUsd).toBe(500); // short entry 2000, cover 1500 → +500
    });
  });

  describe('applyFill — flipping past zero', () => {
    it('closes the long and opens a short at the fill price', () => {
      let p = applyFill(emptyPosition('ETH'), fill({ side: 'buy', px: 2000, sz: 1 }));
      p = applyFill(p, fill({ side: 'sell', px: 2200, sz: 3 }));
      // closed 1 long unit at +200; remaining 2 open short at 2200
      expect(p.realizedPnlUsd).toBe(200);
      expect(p.side).toBe('short');
      expect(p.sz).toBe(2);
      expect(p.avgEntryPx).toBe(2200);
    });
  });

  describe('applyFill — fees + guards', () => {
    it('accumulates fees', () => {
      const p = applyFill(emptyPosition('ETH'), fill({ side: 'buy', px: 2000, sz: 1, feeUsd: 1.5 }));
      expect(p.feesPaidUsd).toBe(1.5);
    });

    it('throws on coin mismatch', () => {
      expect(() => applyFill(emptyPosition('ETH'), fill({ coin: 'BTC', side: 'buy', px: 1, sz: 1 }))).toThrow();
    });

    it('zero-size fill only moves fees', () => {
      const p = applyFill(emptyPosition('ETH'), fill({ side: 'buy', px: 2000, sz: 0, feeUsd: 0.25 }));
      expect(p.side).toBe('flat');
      expect(p.feesPaidUsd).toBe(0.25);
    });
  });

  describe('unrealizedPnl / avgEntry / totalPnl', () => {
    it('marks a long to market', () => {
      const p = applyFill(emptyPosition('ETH'), fill({ side: 'buy', px: 2000, sz: 2 }));
      expect(unrealizedPnl(p, 2100)).toBe(200); // (2100-2000)*2
      expect(avgEntry(p)).toBe(2000);
    });

    it('flat has zero unrealized', () => {
      expect(unrealizedPnl(emptyPosition('ETH'), 5000)).toBe(0);
      expect(avgEntry(emptyPosition('ETH'))).toBe(0);
    });

    it('totalPnl nets realized + unrealized − fees', () => {
      let p = applyFill(emptyPosition('ETH'), fill({ side: 'buy', px: 2000, sz: 2, feeUsd: 2 }));
      p = applyFill(p, fill({ side: 'sell', px: 2500, sz: 1, feeUsd: 1 }));
      // realized +500, fees 3, open 1 unit @2000 marked at 2600 → +600
      expect(totalPnl(p, 2600)).toBe(500 + 600 - 3);
    });
  });

  describe('reduce-only enforcement (paper must match live — HL rejects overshoot)', () => {
    it('a reduce-only sell LARGER than the open long closes to flat, never flips', () => {
      const long = applyFill(emptyPosition('ETH'), fill({ side: 'buy', px: 2000, sz: 2 }));
      const after = applyFill(long, fill({ side: 'sell', px: 2200, sz: 5, reduceOnly: true }));
      expect(after.side).toBe('flat');
      expect(after.sz).toBe(0);
      expect(after.realizedPnlUsd).toBe(400); // only the 2 that closed: (2200-2000)*2
    });

    it('a reduce-only buy against a SHORT only shrinks it', () => {
      const short = applyFill(emptyPosition('ETH'), fill({ side: 'sell', px: 3000, sz: 3 }));
      const after = applyFill(short, fill({ side: 'buy', px: 2900, sz: 1, reduceOnly: true }));
      expect(after.side).toBe('short');
      expect(after.sz).toBe(2);
      expect(after.realizedPnlUsd).toBe(100); // (3000-2900)*1
    });

    it('a reduce-only fill on the SAME side closes nothing (fees only)', () => {
      const long = applyFill(emptyPosition('ETH'), fill({ side: 'buy', px: 2000, sz: 2 }));
      const after = applyFill(long, fill({ side: 'buy', px: 2100, sz: 1, reduceOnly: true, feeUsd: 0.3 }));
      expect(after.side).toBe('long');
      expect(after.sz).toBe(2);
      expect(after.avgEntryPx).toBe(2000);
      expect(after.feesPaidUsd).toBe(0.3);
    });

    it('a reduce-only fill against a flat position is a no-op (fees only)', () => {
      const after = applyFill(emptyPosition('ETH'), fill({ side: 'sell', px: 2000, sz: 1, reduceOnly: true, feeUsd: 0.2 }));
      expect(after.side).toBe('flat');
      expect(after.feesPaidUsd).toBe(0.2);
    });

    it('a NON-reduce-only oversell still flips (regular behavior preserved)', () => {
      const long = applyFill(emptyPosition('ETH'), fill({ side: 'buy', px: 2000, sz: 2 }));
      const after = applyFill(long, fill({ side: 'sell', px: 2200, sz: 5 }));
      expect(after.side).toBe('short');
      expect(after.sz).toBe(3);
      expect(after.avgEntryPx).toBe(2200);
    });
  });

  describe('defensive guards', () => {
    it('throws on a non-finite fill price', () => {
      expect(() => applyFill(emptyPosition('ETH'), fill({ side: 'buy', px: NaN, sz: 1 }))).toThrow(/non-finite/);
    });
    it('marks a SHORT position correctly (unrealized + total)', () => {
      const short = applyFill(emptyPosition('ETH'), fill({ side: 'sell', px: 3000, sz: 2, feeUsd: 1 }));
      expect(unrealizedPnl(short, 2800)).toBe(400); // (3000-2800)*2
      expect(totalPnl(short, 2800)).toBe(400 - 1);
    });
  });

  describe('applyFills sequence', () => {
    it('folds a sequence deterministically', () => {
      const p = applyFills('ETH', [
        fill({ side: 'buy', px: 2000, sz: 1 }),
        fill({ side: 'buy', px: 2200, sz: 1 }),
        fill({ side: 'sell', px: 2400, sz: 1 }),
      ]);
      expect(p.sz).toBe(1);
      expect(p.avgEntryPx).toBe(2100); // blended (2000+2200)/2
      expect(p.realizedPnlUsd).toBe(300); // closed 1 @ 2400 vs avg 2100
    });
  });
});
