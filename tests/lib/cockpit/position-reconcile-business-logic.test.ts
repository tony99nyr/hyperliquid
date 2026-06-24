import { describe, it, expect } from 'vitest';
import {
  reconcilePositions,
  RECONCILE_MIN_DELTA_USD,
  type CockpitPos,
  type HlPos,
} from '@/lib/cockpit/position-reconcile-business-logic';

const cp = (over: Partial<CockpitPos> & Pick<CockpitPos, 'coin' | 'side' | 'sz'>): CockpitPos => ({
  sessionId: 's1',
  avgEntryPx: 100,
  ...over,
});

describe('reconcilePositions', () => {
  it('FLATTENS a cockpit position HL no longer holds (the manual-HL-close desync)', () => {
    const cockpit = [cp({ coin: 'SOL', side: 'short', sz: 18, avgEntryPx: 69 })];
    const hl: HlPos[] = []; // HL is flat
    const actions = reconcilePositions(cockpit, hl);
    expect(actions).toHaveLength(1);
    expect(actions[0].reason).toBe('flatten');
    expect(actions[0].target).toEqual({ side: 'flat', sz: 0, avgEntryPx: 0 });
  });

  it('RESYNCS size/side when HL holds a different amount (missed partial fill)', () => {
    const cockpit = [cp({ coin: 'ETH', side: 'long', sz: 2, avgEntryPx: 2000 })];
    const hl: HlPos[] = [{ coin: 'ETH', szi: 1.2, entryPx: 1990 }]; // HL has less, different entry
    const actions = reconcilePositions(cockpit, hl);
    expect(actions).toHaveLength(1);
    expect(actions[0].reason).toBe('resync');
    expect(actions[0].target).toEqual({ side: 'long', sz: 1.2, avgEntryPx: 1990 });
  });

  it('mirrors a SIDE FLIP (HL shows the opposite direction)', () => {
    const cockpit = [cp({ coin: 'BTC', side: 'long', sz: 0.1, avgEntryPx: 60000 })];
    const hl: HlPos[] = [{ coin: 'BTC', szi: -0.1, entryPx: 60000 }]; // now short on HL
    const actions = reconcilePositions(cockpit, hl);
    expect(actions[0].reason).toBe('resync');
    expect(actions[0].target.side).toBe('short');
    expect(actions[0].target.sz).toBe(0.1);
  });

  it('NO action when cockpit + HL agree', () => {
    const cockpit = [cp({ coin: 'ETH', side: 'long', sz: 1, avgEntryPx: 2000 })];
    const hl: HlPos[] = [{ coin: 'ETH', szi: 1, entryPx: 2000 }];
    expect(reconcilePositions(cockpit, hl)).toEqual([]);
  });

  it('ignores a sub-$1 divergence (dust / FP noise)', () => {
    // 0.004 ETH @ $2000 = $8 delta... pick a delta below the floor: 0.0004 ETH = $0.80
    const cockpit = [cp({ coin: 'ETH', side: 'long', sz: 1.0004, avgEntryPx: 2000 })];
    const hl: HlPos[] = [{ coin: 'ETH', szi: 1.0, entryPx: 2000 }]; // delta 0.0004 * 2000 = $0.80 < $1
    expect(reconcilePositions(cockpit, hl)).toEqual([]);
  });

  it('skips already-flat cockpit rows', () => {
    const cockpit = [cp({ coin: 'SOL', side: 'flat', sz: 0 })];
    expect(reconcilePositions(cockpit, [])).toEqual([]);
  });

  it('does NOT add an HL position the cockpit has no row for', () => {
    const cockpit: CockpitPos[] = []; // cockpit knows nothing
    const hl: HlPos[] = [{ coin: 'HYPE', szi: 5, entryPx: 30 }];
    expect(reconcilePositions(cockpit, hl)).toEqual([]);
  });

  it('the dust floor constant is $1', () => {
    expect(RECONCILE_MIN_DELTA_USD).toBe(1);
  });

  it('FLATTENS even when px is 0 (no entry known) — a phantom must clear regardless', () => {
    const cockpit = [cp({ coin: 'SOL', side: 'short', sz: 18, avgEntryPx: 0 })];
    const actions = reconcilePositions(cockpit, []); // HL flat, px=0
    expect(actions).toHaveLength(1);
    expect(actions[0].reason).toBe('flatten');
  });

  it('RESYNCS UP when HL holds MORE than the cockpit recorded', () => {
    const cockpit = [cp({ coin: 'ETH', side: 'long', sz: 1, avgEntryPx: 2000 })];
    const hl: HlPos[] = [{ coin: 'ETH', szi: 2.5, entryPx: 2000 }];
    const actions = reconcilePositions(cockpit, hl);
    expect(actions[0].reason).toBe('resync');
    expect(actions[0].target.sz).toBe(2.5);
  });

  describe('leverage drift', () => {
    it('RESYNCS leverage when HL holds the same size but a different leverage', () => {
      const cockpit = [cp({ coin: 'ETH', side: 'long', sz: 1, avgEntryPx: 2000, leverage: 5 })];
      const hl: HlPos[] = [{ coin: 'ETH', szi: 1, entryPx: 2000, leverage: 10 }];
      const actions = reconcilePositions(cockpit, hl);
      expect(actions).toHaveLength(1);
      expect(actions[0].reason).toBe('resync');
      expect(actions[0].target.leverage).toBe(10);
    });

    it('BACKFILLS leverage when the cockpit row has none but HL reports one', () => {
      const cockpit = [cp({ coin: 'ETH', side: 'long', sz: 1, avgEntryPx: 2000, leverage: null })];
      const hl: HlPos[] = [{ coin: 'ETH', szi: 1, entryPx: 2000, leverage: 7 }];
      const actions = reconcilePositions(cockpit, hl);
      expect(actions).toHaveLength(1);
      expect(actions[0].target.leverage).toBe(7);
    });

    it('does NOT resync when leverage agrees (integer compare) and size is in sync', () => {
      const cockpit = [cp({ coin: 'ETH', side: 'long', sz: 1, avgEntryPx: 2000, leverage: 10 })];
      const hl: HlPos[] = [{ coin: 'ETH', szi: 1, entryPx: 2000, leverage: 10 }];
      expect(reconcilePositions(cockpit, hl)).toEqual([]);
    });

    it('does NOT churn on a fractional cockpit leverage that rounds to the HL integer (no write loop)', () => {
      // HL applies integers; a stored 10.4 must compare-equal to HL's 10 so the
      // cron converges (else it would re-resync every cycle forever).
      const cockpit = [cp({ coin: 'ETH', side: 'long', sz: 1, avgEntryPx: 2000, leverage: 10.4 })];
      const hl: HlPos[] = [{ coin: 'ETH', szi: 1, entryPx: 2000, leverage: 10 }];
      expect(reconcilePositions(cockpit, hl)).toEqual([]);
    });

    it('PRESERVES the precise cockpit entry on a leverage-only resync (no entryPx clobber)', () => {
      // size in sync; only leverage drifts. HL reports a tick-rounded entry that
      // must NOT overwrite the cockpit's folded entry.
      const cockpit = [cp({ coin: 'ETH', side: 'long', sz: 1, avgEntryPx: 2000.37, leverage: 5 })];
      const hl: HlPos[] = [{ coin: 'ETH', szi: 1, entryPx: 2000, leverage: 10 }];
      const actions = reconcilePositions(cockpit, hl);
      expect(actions).toHaveLength(1);
      expect(actions[0].target.avgEntryPx).toBe(2000.37); // cockpit entry retained
      expect(actions[0].target.sz).toBe(1);
      expect(actions[0].target.leverage).toBe(10);
    });

    it('does NOT resync on leverage when HL reports none (can not assert drift)', () => {
      const cockpit = [cp({ coin: 'ETH', side: 'long', sz: 1, avgEntryPx: 2000, leverage: 5 })];
      const hl: HlPos[] = [{ coin: 'ETH', szi: 1, entryPx: 2000, leverage: null }];
      expect(reconcilePositions(cockpit, hl)).toEqual([]);
    });

    it('carries the HL leverage into a SIZE-drift resync too', () => {
      const cockpit = [cp({ coin: 'ETH', side: 'long', sz: 2, avgEntryPx: 2000, leverage: 5 })];
      const hl: HlPos[] = [{ coin: 'ETH', szi: 1.2, entryPx: 1990, leverage: 8 }];
      const actions = reconcilePositions(cockpit, hl);
      expect(actions[0].reason).toBe('resync');
      expect(actions[0].target.sz).toBe(1.2);
      expect(actions[0].target.leverage).toBe(8);
    });

    it('a flatten never carries leverage', () => {
      const cockpit = [cp({ coin: 'SOL', side: 'short', sz: 18, avgEntryPx: 69, leverage: 5 })];
      const actions = reconcilePositions(cockpit, []); // HL flat
      expect(actions[0].reason).toBe('flatten');
      expect(actions[0].target.leverage).toBeUndefined();
    });
  });

  describe('freshness guard (cache-lag race)', () => {
    const hlFlat: HlPos[] = []; // HL holds nothing

    it('does NOT flatten a row written within the freshness window', () => {
      const now = 1_000_000;
      const cockpit = [cp({ coin: 'SOL', side: 'short', sz: 18, avgEntryPx: 69, updatedAtMs: now - 10_000 })]; // 10s old
      expect(reconcilePositions(cockpit, hlFlat, { nowMs: now })).toEqual([]); // too fresh → skipped
    });

    it('DOES flatten a row older than the freshness window (a real manual-HL close)', () => {
      const now = 1_000_000;
      const cockpit = [cp({ coin: 'SOL', side: 'short', sz: 18, avgEntryPx: 69, updatedAtMs: now - 120_000 })]; // 2m old
      const actions = reconcilePositions(cockpit, hlFlat, { nowMs: now });
      expect(actions).toHaveLength(1);
      expect(actions[0].reason).toBe('flatten');
    });

    it('without nowMs the guard is inert (back-compat)', () => {
      const cockpit = [cp({ coin: 'SOL', side: 'short', sz: 18, avgEntryPx: 69, updatedAtMs: 5 })];
      expect(reconcilePositions(cockpit, hlFlat)).toHaveLength(1); // no nowMs → not skipped
    });
  });
});
