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
});
