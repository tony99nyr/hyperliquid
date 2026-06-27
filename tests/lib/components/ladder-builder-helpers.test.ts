/**
 * Pins the PURE LadderBuilderModal helpers: the draft→preview path runs the SAME
 * validateLadderForArm the server runs at arm (so the modal can't show "safe" for a
 * ladder the server rejects), and the create payload mirrors the route's expected shape.
 */

import { describe, it, expect } from 'vitest';
import {
  defaultDraftLadder,
  buildLadderPreview,
  buildCreatePayload,
  type DraftLadder,
} from '@/app/cockpit/components/ladders/ladder-builder-helpers';

const NOW = 1_700_000_000_000;

function cleanDraft(): DraftLadder {
  return {
    ...defaultDraftLadder('ETH'),
    title: 'ETH breakout',
    rungs: [{ coin: 'ETH', side: 'long', action: 'open', triggerKind: 'price_above', triggerPx: 2000, riskUsd: 50, stopFrac: 0.04, leverage: 5, targetPx: null }],
  };
}

describe('buildLadderPreview', () => {
  it('a clean single-rung draft has no warnings and a bounded worst-case', () => {
    const { warnings, risk } = buildLadderPreview(cleanDraft(), NOW);
    expect(warnings).toHaveLength(0);
    // entry 2000, size 50/(2000*0.04)=0.625, stop 1920, worst fill 1920*0.9=1728,
    // adverse 272 × 0.625 = 170.
    expect(risk.aggregateWorstCaseLossUsd).toBeCloseTo(170, 0);
    expect(risk.totalNotionalUsd).toBeCloseTo(1250, 0);
    expect(risk.perCoin).toHaveLength(1);
  });

  it('surfaces the server-equivalent warnings (missing title, no rung trigger)', () => {
    const noTitle = { ...cleanDraft(), title: '  ' };
    expect(buildLadderPreview(noTitle, NOW).warnings.some((w) => /title/i.test(w))).toBe(true);
    const noTrigger = cleanDraft();
    noTrigger.rungs[0].triggerPx = null;
    expect(buildLadderPreview(noTrigger, NOW).warnings.some((w) => /triggerPx/i.test(w))).toBe(true);
  });

  it('flags a worst-case-loss cap breach (the consent number)', () => {
    const big = cleanDraft();
    big.maxTotalLossUsd = 100; // worst-case ~170 > 100
    expect(buildLadderPreview(big, NOW).warnings.some((w) => /worst-case/i.test(w))).toBe(true);
  });
});

describe('buildCreatePayload', () => {
  it('maps the draft to the route body with 1-based seq + expiry from hours', () => {
    const body = buildCreatePayload(cleanDraft(), NOW);
    expect(body.title).toBe('ETH breakout');
    expect(body.mode).toBe('paper');
    expect(body.expiresAtMs).toBe(NOW + 24 * 3_600_000);
    expect(body.rungs).toHaveLength(1);
    expect(body.rungs[0]).toMatchObject({ seq: 1, coin: 'ETH', side: 'long', action: 'open', triggerKind: 'price_above', triggerPx: 2000, riskUsd: 50, stopFrac: 0.04, leverage: 5 });
  });
});
