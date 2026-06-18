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
  isEntryApproveEnabled,
  type EntryFormState,
} from '@/app/cockpit/components/entry-modal-helpers';

const baseForm: EntryFormState = {
  coin: 'ETH',
  side: 'sell',
  riskUsd: 50,
  stopFrac: 0.04,
  leverage: 5,
  thesis: 'manual short',
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
  it('is "side sz coin" lowercased', () => {
    expect(entryLiveConfirmPhrase('sell', 0.625, 'ETH')).toBe('sell 0.625 eth');
  });

  it('matches case-insensitively and trimmed', () => {
    expect(entryLivePhraseMatches('sell', 0.625, 'ETH', '  SELL 0.625 eth ')).toBe(true);
    expect(entryLivePhraseMatches('sell', 0.625, 'ETH', 'buy 0.625 eth')).toBe(false);
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
    expect(isEntryApproveEnabled('live', p, false, false, 'sell 0.625 eth')).toBe(true);
  });

  it('LIVE: a matching phrase still cannot bypass the liq gate', () => {
    const p = buildEntryPreview(baseForm, 2000)!;
    expect(isEntryApproveEnabled('live', p, true, false, 'sell 0.625 eth')).toBe(false);
    expect(isEntryApproveEnabled('live', p, true, true, 'sell 0.625 eth')).toBe(true);
  });
});

describe('defaultEntryForm', () => {
  it('defaults to a long on the given coin', () => {
    const f = defaultEntryForm('btc');
    expect(f.coin).toBe('BTC');
    expect(f.side).toBe('buy');
    expect(f.riskUsd).toBeGreaterThan(0);
    expect(f.stopFrac).toBeGreaterThan(0);
  });
});
