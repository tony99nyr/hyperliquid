/**
 * Pins the PURE EntryModal helpers (the self-service "＋ New Position" form):
 *  - sizing comes from the SHARED buildOpenProposal (risk-based, leverage-meta);
 *  - the proposal-ready gate composes builder-warnings + liq-inside-stop ack;
 *  - the LIVE typed-phrase invariant matches "side sz coin" exactly;
 *  - isEntryApproveEnabled mirrors the approval-popup gate (paper one-tap; live
 *    needs the exact phrase ON TOP of a ready proposal + cleared liq gate).
 */

import { describe, it, expect } from 'vitest';
import {
  buildEntryPreview,
  defaultEntryForm,
  entryLeverageRead,
  entryLiqInsideStop,
  entryLiveConfirmPhrase,
  entryLivePhraseMatches,
  entryProposalReady,
  entryTriggerError,
  isEntryApproveEnabled,
  type EntryFormState,
} from '@/app/cockpit/components/entry-modal-helpers';

const baseForm: EntryFormState = {
  coin: 'ETH',
  side: 'sell',
  timeframe: 'swing',
  riskUsd: 50,
  stopFrac: 0.04,
  leverage: 5,
  thesis: 'manual short',
  entryType: 'market',
  triggerPx: null,
};

describe('buildEntryPreview', () => {
  it('returns null when the entry price is unknown', () => {
    expect(buildEntryPreview(baseForm, null)).toBeNull();
    expect(buildEntryPreview(baseForm, 0)).toBeNull();
  });

  it('risk-sizes via the shared builder: 50 / (2000 * 0.04) = 0.625', () => {
    const p = buildEntryPreview(baseForm, 2000);
    expect(p).not.toBeNull();
    expect(p!.intent.sz).toBeCloseTo(0.625, 6);
    expect(p!.intent.reduceOnly).toBe(false);
    // A short stops ABOVE entry.
    expect(p!.stopPx).toBeCloseTo(2080, 6);
    expect(p!.warnings).toHaveLength(0);
  });

  it('surfaces builder warnings for a bad stop fraction', () => {
    const p = buildEntryPreview({ ...baseForm, stopFrac: 0 }, 2000);
    // stopFrac 0 is coerced by the builder but flagged as a warning.
    expect(p!.warnings.length).toBeGreaterThan(0);
  });

  it('does NOT warn on a blank thesis — it is OPTIONAL (route defaults it too)', () => {
    const p = buildEntryPreview({ ...baseForm, thesis: '' }, 2000);
    expect(p!.warnings).toHaveLength(0);
    // A blank-thesis, otherwise-valid setup must be Approve-ready (paper).
    expect(entryProposalReady(p, false, false)).toBe(true);
  });
});

describe('entryLeverageRead', () => {
  it('derives margin / liq from the slider value', () => {
    const p = buildEntryPreview(baseForm, 2000)!;
    const read = entryLeverageRead(baseForm, p, 2000);
    expect(read).not.toBeNull();
    // notional = 0.625 * 2000 = 1250; margin = 1250 / 5 = 250.
    expect(read!.notionalUsd).toBeCloseTo(1250, 4);
    expect(read!.marginUsd).toBeCloseTo(250, 4);
    // short liq ~ entry * (1 + 1/lev) = 2000 * 1.2 = 2400.
    expect(read!.liqPx).toBeCloseTo(2400, 4);
  });
});

describe('entryLiqInsideStop', () => {
  it('false at a safe leverage (liq well past the stop)', () => {
    const p = buildEntryPreview(baseForm, 2000)!; // 5x → liq 2400, stop 2080
    expect(entryLiqInsideStop(baseForm, p, 2000)).toBe(false);
  });

  it('true at a high leverage that liquidates before the stop', () => {
    const form = { ...baseForm, leverage: 25 }; // liq ~ 2000*1.04 = 2080 = stop
    const p = buildEntryPreview(form, 2000)!;
    expect(entryLiqInsideStop(form, p, 2000)).toBe(true);
  });
});

describe('entryLiveConfirmPhrase / matches', () => {
  it('is "side coin" lowercased (size omitted — it recomputes per tick)', () => {
    expect(entryLiveConfirmPhrase('sell', 'ETH')).toBe('sell eth');
  });

  it('matches case-insensitively and trimmed', () => {
    expect(entryLivePhraseMatches('sell', 'ETH', '  SELL eth ')).toBe(true);
    expect(entryLivePhraseMatches('sell', 'ETH', 'buy eth')).toBe(false);
  });
});

describe('entryProposalReady', () => {
  it('false without a proposal', () => {
    expect(entryProposalReady(null, false, false)).toBe(false);
  });

  it('true for a clean proposal with no liq warning', () => {
    const p = buildEntryPreview(baseForm, 2000)!;
    expect(entryProposalReady(p, false, false)).toBe(true);
  });

  it('false when liq is inside the stop and NOT acknowledged', () => {
    const p = buildEntryPreview(baseForm, 2000)!;
    expect(entryProposalReady(p, true, false)).toBe(false);
    expect(entryProposalReady(p, true, true)).toBe(true);
  });

  it('false when the builder produced warnings', () => {
    const p = buildEntryPreview({ ...baseForm, riskUsd: 0 }, 2000)!;
    expect(entryProposalReady(p, false, false)).toBe(false);
  });
});

describe('isEntryApproveEnabled', () => {
  it('PAPER: one-tap once the proposal is ready', () => {
    const p = buildEntryPreview(baseForm, 2000)!;
    expect(isEntryApproveEnabled('paper', p, false, false, '')).toBe(true);
  });

  it('PAPER: blocked while the liq gate is open', () => {
    const p = buildEntryPreview(baseForm, 2000)!;
    expect(isEntryApproveEnabled('paper', p, true, false, '')).toBe(false);
  });

  it('LIVE: needs the exact phrase ON TOP of a ready proposal', () => {
    const p = buildEntryPreview(baseForm, 2000)!; // sz 0.625
    expect(isEntryApproveEnabled('live', p, false, false, '')).toBe(false);
    expect(isEntryApproveEnabled('live', p, false, false, 'sell eth')).toBe(true);
  });

  it('LIVE: a matching phrase still cannot bypass the liq gate', () => {
    const p = buildEntryPreview(baseForm, 2000)!;
    expect(isEntryApproveEnabled('live', p, true, false, 'sell eth')).toBe(false);
    expect(isEntryApproveEnabled('live', p, true, true, 'sell eth')).toBe(true);
  });
});

describe('entryTriggerError — breakout/breakdown direction + distance (mirrors the route)', () => {
  it('null (valid) for a LONG trigger ABOVE the mark within bounds', () => {
    expect(entryTriggerError('buy', 2020, 2000)).toBeNull();
  });

  it('null (valid) for a SHORT trigger BELOW the mark within bounds', () => {
    expect(entryTriggerError('sell', 1980, 2000)).toBeNull();
  });

  it('rejects a LONG trigger AT/BELOW the mark (wrong direction)', () => {
    expect(entryTriggerError('buy', 2000, 2000)).toMatch(/above/i);
    expect(entryTriggerError('buy', 1990, 2000)).toMatch(/above/i);
  });

  it('rejects a SHORT trigger AT/ABOVE the mark (wrong direction)', () => {
    expect(entryTriggerError('sell', 2010, 2000)).toMatch(/below/i);
  });

  it('rejects a trigger that sits too close (fires instantly)', () => {
    expect(entryTriggerError('buy', 2001, 2000)).toMatch(/instantly/i); // 0.05% < 0.1%
  });

  it('rejects a trigger absurdly far from the mark', () => {
    expect(entryTriggerError('buy', 4000, 2000)).toMatch(/check the price/i); // 100% > 50%
  });

  it('asks for a price / mark when missing', () => {
    expect(entryTriggerError('buy', null, 2000)).toMatch(/trigger price/i);
    expect(entryTriggerError('buy', 2020, null)).toMatch(/mark/i);
  });
});

describe('isEntryApproveEnabled — trigger-error block', () => {
  it('an invalid trigger BLOCKS Approve even with a ready proposal + matching phrase', () => {
    const p = buildEntryPreview(baseForm, 2000)!;
    expect(isEntryApproveEnabled('live', p, false, false, 'sell eth', 'bad direction')).toBe(false);
  });

  it('a valid (null) trigger error does not block an otherwise-ready proposal', () => {
    const p = buildEntryPreview(baseForm, 2000)!;
    expect(isEntryApproveEnabled('paper', p, false, false, '', null)).toBe(true);
  });
});

describe('defaultEntryForm', () => {
  it('defaults to a long on the given coin', () => {
    const f = defaultEntryForm('btc');
    expect(f.coin).toBe('BTC');
    expect(f.side).toBe('buy');
    expect(f.riskUsd).toBeGreaterThan(0);
    expect(f.stopFrac).toBeGreaterThan(0);
    expect(f.entryType).toBe('market'); // defaults to market-now, not a resting trigger
    expect(f.triggerPx).toBeNull();
  });

  it('seeds the given side (so a SHORT opportunity opens a SHORT preview)', () => {
    expect(defaultEntryForm('eth', 'sell').side).toBe('sell');
    expect(defaultEntryForm('eth', 'buy').side).toBe('buy');
  });
});
