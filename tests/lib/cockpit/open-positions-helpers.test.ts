import { describe, it, expect } from 'vitest';
import {
  liquidationPrice,
  liqColorFor,
  liqBarWidth,
  isAligned,
  positionHealth,
  stopStatus,
  uPnlPct,
  quoteExit,
} from '@/app/cockpit/components/open-positions-helpers';
import { ZONE_COLORS } from '@/app/cockpit/components/panel-styles';

describe('open-positions-helpers', () => {
  describe('liquidationPrice (mmr 0.004)', () => {
    it('puts a long liq below entry', () => {
      const liq = liquidationPrice('long', 1000, 10);
      // 1000 * (1 - 0.1 + 0.004) = 904
      expect(liq).toBeCloseTo(904);
    });
    it('puts a short liq above entry', () => {
      const liq = liquidationPrice('short', 1000, 10);
      // 1000 * (1 + 0.1 - 0.004) = 1096
      expect(liq).toBeCloseTo(1096);
    });
    it('returns null for invalid inputs', () => {
      expect(liquidationPrice('long', 0, 10)).toBeNull();
      expect(liquidationPrice('long', 1000, 0)).toBeNull();
    });
  });

  describe('liqColorFor — green >14%, amber 6–14%, red <6%', () => {
    it('reds tight proximity', () => {
      expect(liqColorFor(3)).toBe(ZONE_COLORS.danger);
    });
    it('ambers mid proximity', () => {
      expect(liqColorFor(10)).toBe(ZONE_COLORS.warn);
    });
    it('greens comfortable proximity', () => {
      expect(liqColorFor(20)).toBe(ZONE_COLORS.ok);
    });
  });

  describe('liqBarWidth — closer to liq ⇒ fuller bar', () => {
    it('clamps to [6%, 100%]', () => {
      expect(liqBarWidth(0)).toBe('100%');
      expect(liqBarWidth(40)).toBe('6%'); // 100 - 120 < 6 → 6
      expect(liqBarWidth(null)).toBe('0%');
    });
    it('scales linearly in the middle', () => {
      expect(liqBarWidth(10)).toBe('70%'); // 100 - 30
    });
  });

  describe('isAligned vs regime', () => {
    it('short aligns with bearish, fights bullish', () => {
      expect(isAligned('short', 'bearish')).toBe(true);
      expect(isAligned('short', 'bullish')).toBe(false);
    });
    it('long aligns with bullish, fights bearish', () => {
      expect(isAligned('long', 'bullish')).toBe(true);
      expect(isAligned('long', 'bearish')).toBe(false);
    });
    it('neutral regime is always aligned', () => {
      expect(isAligned('long', 'neutral')).toBe(true);
      expect(isAligned('short', 'neutral')).toBe(true);
    });
  });

  describe('positionHealth', () => {
    it('builds an ALIGNED short in a bearish regime with a liq bar', () => {
      const h = positionHealth({ side: 'short', entryPx: 1000, markPx: 1000, leverage: 5, regime: 'bearish' });
      expect(h.aligned).toBe(true);
      expect(h.alignLabel).toBe('ALIGNED ✓');
      expect(h.liqPx).not.toBeNull();
      expect(h.liqDistPct).not.toBeNull();
      expect(h.liqBarWidth.endsWith('%')).toBe(true);
    });
    it('flags a FIGHTING long in a bearish regime', () => {
      const h = positionHealth({ side: 'long', entryPx: 1000, markPx: 1000, leverage: 5, regime: 'bearish' });
      expect(h.aligned).toBe(false);
      expect(h.alignLabel).toBe('FIGHTING ⚠');
    });
    it('prefers an exchange-supplied liq price when present', () => {
      const h = positionHealth({ side: 'long', entryPx: 1000, markPx: 1000, leverage: 5, liqPxOverride: 850, regime: 'neutral' });
      expect(h.liqPx).toBe(850);
    });
  });

  describe('uPnlPct', () => {
    it('is positive for a long in profit', () => {
      expect(uPnlPct('long', 100, 110)).toBeCloseTo(10);
    });
    it('is positive for a short in profit (mark below entry)', () => {
      expect(uPnlPct('short', 100, 90)).toBeCloseTo(10);
    });
    it('is null without prices', () => {
      expect(uPnlPct('long', null, 110)).toBeNull();
    });
  });

  describe('quoteExit (partial close math)', () => {
    it('quotes a 50% close of a winning long net of fee', () => {
      const q = quoteExit({ side: 'long', size: 4, entryPx: 100, markPx: 110, frac: 0.5, currentEquityUsd: 1000 });
      expect(q.closeSize).toBeCloseTo(2);
      expect(q.realizedGrossUsd).toBeCloseTo((110 - 100) * 2); // 20
      expect(q.feeUsd).toBeCloseTo(110 * 2 * 0.00035);
      expect(q.realizedNetUsd).toBeCloseTo(20 - q.feeUsd);
      // resulting equity = currentEquity - fee
      expect(q.resultingEquityUsd).toBeCloseTo(1000 - q.feeUsd);
    });
    it('quotes a full close of a losing short', () => {
      const q = quoteExit({ side: 'short', size: 2, entryPx: 100, markPx: 120, frac: 1, currentEquityUsd: 500 });
      expect(q.closeSize).toBeCloseTo(2);
      expect(q.realizedGrossUsd).toBeCloseTo((120 - 100) * 2 * -1); // -40
      expect(q.realizedNetUsd).toBeLessThan(0);
    });
    it('clamps the fraction to [0,1]', () => {
      const q = quoteExit({ side: 'long', size: 2, entryPx: 100, markPx: 110, frac: 2, currentEquityUsd: 0 });
      expect(q.closeSize).toBeCloseTo(2);
    });
  });

  describe('stopStatus', () => {
    it('PROTECTED when a resting stop exists, with % distance from the mark', () => {
      const s = stopStatus({ triggerPx: 1672 }, 1616, 'live');
      expect(s.state).toBe('protected');
      expect(s.triggerPx).toBe(1672);
      expect(s.distPct).toBeCloseTo((Math.abs(1616 - 1672) / 1616) * 100, 6);
    });
    it('protected with null distance when the mark is unknown', () => {
      const s = stopStatus({ triggerPx: 1672 }, null, 'live');
      expect(s.state).toBe('protected');
      expect(s.distPct).toBeNull();
    });
    it('UNPROTECTED in live when no stop rests (real exposure)', () => {
      expect(stopStatus(null, 1616, 'live').state).toBe('unprotected');
      expect(stopStatus({ triggerPx: null }, 1616, 'live').state).toBe('unprotected');
    });
    it('N/A in paper when no stop rests (paper has no exchange stops — not a warning)', () => {
      expect(stopStatus(null, 1616, 'paper').state).toBe('na');
      expect(stopStatus(undefined, 1616, 'paper').state).toBe('na');
    });
  });
});
