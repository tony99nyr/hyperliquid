import { describe, it, expect } from 'vitest';
import { buildHtfTrendLadderPlan, htfDraftWindow, htfEventBlackout, htfPlanNumbers, htfTrendAlertMessage, htfTrendSignal, htfTrendTitle, parseHtfTrendTitle, selectHtfDrafts, htfEntryOver, htfClosedArmedOpener, isStaleHtfDraft, isSpentHtfArmed, HTF_SPENT_GRACE_MS, needsHtfHousekeeping, htfSpentReason, htfSpentDisarmMessage, type HtfTrendSignal } from '@/lib/ladder/htf-trend-alert-business-logic';
import { validateLadderForArm, resolveArmRung } from '@/lib/ladder/ladder-arm-business-logic';
import { DAY_MS } from '@/lib/ladder/ladder-htf-exit-business-logic';
import { htfChannelExitIndicatorName, type LadderRung, type LadderWithRungs } from '@/lib/ladder/ladder-types';
import type { HtfTrendRead } from '@/lib/scout/htf-trend-signal-business-logic';

const DAY = Date.UTC(2026, 10, 14);
const sig = (side: 'long' | 'short', coin = 'BTC', stopFrac = 0.06): HtfTrendSignal => ({ coin, side, signalCloseMs: DAY, closePx: side === 'long' ? 110 : 90, channelPx: 100, stopFrac, exitPx: side === 'long' ? 95 : 105 });
const read = (side: 'long' | 'short' | null): HtfTrendRead => ({ latestClose: 110, don20High: 100, don20Low: 90, don10High: 105, don10Low: 95, atr: 2, breakout: side ? { side, entryPx: 110, stopPx: 100, stopFrac: 0.06, exitPx: 95 } : null });
const rung = (r: Partial<LadderRung> = {}): LadderRung => ({ id: 'r', ladderId: 'l', seq: 1, coin: 'BTC', side: 'long', action: 'open', triggerKind: 'price_above', triggerPx: 100, triggerMeta: null, sizeCoins: null, reduceFrac: null, riskUsd: 10, stopFrac: 0.06, leverage: 2, stopPx: null, targetPx: null, status: 'pending', cloid: null, ...r });
const ladder = (title: string, status: LadderWithRungs['status'], deadline = DAY + 4 * 3_600_000, side: 'long' | 'short' = 'long', extra: LadderRung[] = []): LadderWithRungs => ({ id: 'ladder-id-1234', title, thesis: null, author: 'operator', mode: 'live', status, preconditionHash: null, ocoGroupId: null, leaderAddress: null, maxTotalNotionalUsd: 400, maxTotalLossUsd: 100, anchorPx: null, expiresAt: new Date(DAY + 90 * DAY_MS).toISOString(), activeFrom: null, armedAt: null, disarmedAt: null, disarmReason: null, archivedAt: null, expiryAlertAt: null, createdAt: new Date(DAY).toISOString(), updatedAt: new Date(DAY).toISOString(), rungs: [rung({ side, triggerMeta: { entryDeadlineMs: deadline } }), ...extra] });

describe('HTF timing and titles', () => {
  it('opens the default drafting window after settle and closes at the cutoff', () => {
    expect(htfDraftWindow(DAY + 30_000).open).toBe(false);
    expect(htfDraftWindow(DAY + 60_000).open).toBe(true);
    expect(htfDraftWindow(DAY + 2 * 3_600_000 + 59 * 60_000 + 59_000).open).toBe(true);
    expect(htfDraftWindow(DAY + 3 * 3_600_000).open).toBe(false);
    expect(htfDraftWindow(DAY + 4 * 3_600_000).open).toBe(false);
    expect(htfDraftWindow(NaN).open).toBe(false);
    expect(htfDraftWindow(DAY).entryDeadlineMs).toBe(DAY + 4 * 3_600_000);
  });
  it('applies the event blackout boundaries', () => {
    expect(htfEventBlackout(48 * 3_600_000)).toBe(true);
    expect(htfEventBlackout(3_600_000)).toBe(true);
    expect(htfEventBlackout(-3 * 3_600_000)).toBe(true);
    expect(htfEventBlackout(48 * 3_600_000 + 1)).toBe(false);
    expect(htfEventBlackout(null)).toBe(false);
  });
  it('round trips the title with the UTC date of the closed bar', () => {
    const title = htfTrendTitle('btc', 'long', DAY);
    expect(title).toContain('BTC htf-trend long 2026-11-13');
    expect(parseHtfTrendTitle(title)).toEqual({ coin: 'BTC', side: 'long', signalDate: '2026-11-13' });
    for (const invalid of ['BTC runaway long today', 'BTC trend-follow long today', 'prefix htf-trend long 2026-11-13', `${title} extra`, title.replace(' (auto-draft, review and arm)', '')]) expect(parseHtfTrendTitle(invalid)).toBeNull();
  });
});

describe('HTF signal and plan', () => {
  it('selects the channel by side and fails closed on invalid read fields', () => {
    expect(htfTrendSignal('btc', read('long'), DAY)?.channelPx).toBe(100);
    expect(htfTrendSignal('btc', read('short'), DAY)?.channelPx).toBe(90);
    expect(htfTrendSignal('btc', read(null), DAY)).toBeNull();
    for (const field of ['entryPx', 'stopFrac', 'exitPx'] as const) {
      const broken = read('long'); broken.breakout![field] = NaN;
      expect(htfTrendSignal('BTC', broken, DAY)).toBeNull();
    }
    const badChannel = read('long'); badChannel.don20High = 0;
    expect(htfTrendSignal('BTC', badChannel, DAY)).toBeNull();
  });
  it('sizes risk and slipped losses with integer caps', () => {
    expect(htfPlanNumbers(sig('long', 'BTC', 0.06)).riskUsd).toBe(10);
    const small = htfPlanNumbers(sig('long', 'BTC', 0.01));
    expect(small.riskUsd).toBe(4); expect(small.notionalUsd).toBe(400);
    for (const side of ['long', 'short'] as const) {
      const n = htfPlanNumbers(sig(side));
      expect(n.slippedLossUsd).toBeCloseTo(n.notionalUsd * (0.1 + (side === 'long' ? 0.9 : 1.1) * 0.06));
      expect(Number.isInteger(n.maxTotalLossUsd)).toBe(true);
      expect(Number.isInteger(n.maxTotalNotionalUsd)).toBe(true);
      expect(n.maxTotalLossUsd).toBeGreaterThanOrEqual(n.slippedLossUsd + n.notionalUsd * 0.3 * 90 / 365);
    }
  });
  it.each(['long', 'short'] as const)('builds and validates a %s lane', (side) => {
    const signal = sig(side);
    const plan = buildHtfTrendLadderPlan(signal);
    expect(plan).toMatchObject({ mode: 'live', author: 'operator' });
    expect(plan.rungs).toHaveLength(2);
    const [open, close] = plan.rungs;
    expect(open).toMatchObject({ action: 'open', triggerKind: side === 'long' ? 'price_above' : 'price_below', triggerPx: 100, stopFrac: 0.06 });
    expect(open.stopPx).toBeUndefined();
    expect(open.targetPx).toBeUndefined();
    expect(open.triggerMeta?.entryDeadlineMs).toBe(DAY + 4 * 3_600_000);
    expect(open.triggerMeta?.momentumConfirm).toBeUndefined();
    expect(close).toMatchObject({ action: 'close', triggerKind: 'indicator', triggerMeta: { op: 'above', indicatorValue: 0.5, indicatorName: htfChannelExitIndicatorName(side) } });
    expect(plan.expiresAtMs).toBe(DAY + 90 * DAY_MS);
    expect(plan.anchorPx).toBeUndefined();
    expect(parseHtfTrendTitle(plan.title)).toMatchObject({ coin: 'BTC', side, signalDate: '2026-11-13' });
    expect(plan.thesis).not.toContain('—');
    for (const stopFrac of [0.03, 0.06, 0.12]) {
      const candidate = buildHtfTrendLadderPlan(sig(side, 'BTC', stopFrac));
      const rungs = candidate.rungs.map((p, i) => resolveArmRung({ id: `r${i}`, ladderId: 'l', seq: p.seq, coin: p.coin, side: p.side, action: p.action, triggerKind: p.triggerKind, triggerPx: p.triggerPx ?? null, triggerMeta: p.triggerMeta ?? null, riskUsd: p.riskUsd ?? null, stopFrac: p.stopFrac ?? null, leverage: p.leverage ?? null, reduceFrac: p.reduceFrac ?? null, stopPx: p.stopPx ?? null, targetPx: p.targetPx ?? null, status: 'pending' } as LadderRung));
      const result = validateLadderForArm({ title: candidate.title, thesis: candidate.thesis, expiresAtMs: candidate.expiresAtMs ?? null, activeFromMs: null, caps: { maxTotalNotionalUsd: candidate.maxTotalNotionalUsd ?? null, maxTotalLossUsd: candidate.maxTotalLossUsd ?? null }, rungs, now: DAY + 10 * 60_000, coinMaxLeverage: () => 20, fundingRateByCoin: { BTC: 0.0000125 } });
      expect(result.warnings).toEqual([]);
      const rateAgainst = side === 'long' ? 0.0000685 : -0.0000685;
      const highFunding = validateLadderForArm({ title: candidate.title, thesis: candidate.thesis, expiresAtMs: candidate.expiresAtMs ?? null, activeFromMs: null, caps: { maxTotalNotionalUsd: candidate.maxTotalNotionalUsd ?? null, maxTotalLossUsd: candidate.maxTotalLossUsd ?? null }, rungs, now: DAY + 10 * 60_000, coinMaxLeverage: () => 20, fundingRateByCoin: { BTC: rateAgainst } });
      expect(highFunding.warnings.join(' ')).toMatch(/funding/i);
    }
  });
});

describe('HTF alert and book decisions', () => {
  it('includes the operator details and a normalised cockpit link', () => {
    const message = htfTrendAlertMessage(sig('long'), 'abcdefgh123456', 'https://example.test/');
    expect(message).toContain('BTC'); expect(message).toContain('LONG'); expect(message).toContain('abcdefgh');
    expect(message).toContain('04:00 UTC'); expect(message).toContain('https://example.test/cockpit?tab=ladders');
    expect(message).not.toContain('—');
  });
  it('marks stale and spent ladders only after the entry deadline', () => {
    const draft = ladder(htfTrendTitle('BTC', 'long', DAY), 'draft');
    expect(isStaleHtfDraft(draft, DAY + 3 * 3_600_000)).toBe(false);
    expect(isStaleHtfDraft(draft, DAY + 4 * 3_600_000)).toBe(true);
    expect(isStaleHtfDraft({ ...draft, title: 'ordinary ladder' }, DAY + 5 * 3_600_000)).toBe(false);
    const armed = { ...draft, status: 'armed' as const };
    const late = DAY + 4 * 3_600_000 + HTF_SPENT_GRACE_MS;
    const long = [{ coin: 'BTC', side: 'long' as const }];
    expect(htfClosedArmedOpener(armed, DAY + 3 * 3_600_000)).toBeNull();
    expect(htfClosedArmedOpener(armed, late)?.id).toBe('r');
    expect(htfClosedArmedOpener(draft, late)).toBeNull();
    expect(htfClosedArmedOpener({ ...armed, title: 'ordinary ladder' }, late)).toBeNull();
    // Before the deadline, and for a ladder of another drafter: never spent.
    expect(isSpentHtfArmed(armed, DAY + 3 * 3_600_000, [], false)).toBe(false);
    expect(isSpentHtfArmed({ ...armed, title: 'ordinary ladder' }, late, [], false)).toBe(false);
    // Never entered: spent, even when the operator holds a manual position of its side.
    expect(isSpentHtfArmed(armed, late, [], false)).toBe(true);
    expect(isSpentHtfArmed(armed, late, long, false)).toBe(true);
    // Entered (a fire on record, or the opener is `fired`): spent only when its side is flat.
    expect(isSpentHtfArmed(armed, late, long, true)).toBe(false);
    expect(isSpentHtfArmed(armed, late, [], true)).toBe(true);
    expect(isSpentHtfArmed(armed, late, [{ coin: 'BTC', side: 'short' }], true)).toBe(true);
    const entered = { ...armed, rungs: [{ ...armed.rungs[0], status: 'fired' as const }] };
    expect(isSpentHtfArmed(entered, late, long, false)).toBe(false);
    expect(isSpentHtfArmed(entered, late, [], false)).toBe(true);
    expect(htfEntryOver(draft, DAY + 4 * 3_600_000)).toBe(true);
    expect(htfClosedArmedOpener(armed, late - 1)).toBeNull();
    expect(htfClosedArmedOpener(armed, late)?.id).toBe('r');
    expect(needsHtfHousekeeping(draft, late)).toBe(true);
    expect(needsHtfHousekeeping(armed, late)).toBe(true);
    expect(htfSpentReason(armed, late, [], false)).toBe('never-entered');
    expect(htfSpentReason(armed, late, [], true)).toBe('flat');
    expect(htfSpentReason(armed, late, [{ coin: 'BTC', side: 'long' }], true)).toBeNull();
    expect(htfSpentDisarmMessage(armed, 'never-entered')).toContain('never entered');
    expect(htfSpentDisarmMessage(armed, 'flat')).toContain('no position');
  });
  it('selects drafts in universe order and reports each exclusion', () => {
    const signals = [sig('long', 'HYPE'), sig('long', 'SOL'), sig('long', 'ETH'), sig('long', 'BTC'), sig('long', 'DOGE')];
    const base = { signals, now: DAY + 2 * 3_600_000, ladders: [] as LadderWithRungs[], positions: [], draftedCoins: new Set<string>() };
    expect(selectHtfDrafts(base).draft.map((s) => s.coin)).toEqual(['BTC', 'ETH']);
    expect(selectHtfDrafts({ ...base, maxDrafts: 2, maxSameDirection: 4, signals: [sig('long', 'BTC'), sig('long', 'ETH'), sig('long', 'SOL')] }).skipped).toContainEqual({ coin: 'SOL', reason: 'cycle-cap' });
    expect(selectHtfDrafts({ ...base, draftedCoins: new Set(['BTC']) }).skipped).toContainEqual({ coin: 'BTC', reason: 'already-drafted' });
    expect(selectHtfDrafts({ ...base, positions: [{ coin: 'BTC', side: 'long' }] }).skipped).toContainEqual({ coin: 'BTC', reason: 'positioned' });
    const vehicle = ladder(htfTrendTitle('BTC', 'short', DAY), 'draft');
    expect(selectHtfDrafts({ ...base, ladders: [vehicle] }).skipped).toContainEqual({ coin: 'BTC', reason: 'vehicle' });
    const otherVehicle = ladder('BTC ordinary ladder', 'armed');
    expect(selectHtfDrafts({ ...base, ladders: [otherVehicle] }).skipped).toContainEqual({ coin: 'BTC', reason: 'vehicle' });
    expect(selectHtfDrafts({ ...base, signals: [sig('long', 'SOL'), sig('long', 'HYPE'), sig('long', 'BTC')], positions: [{ coin: 'BTC', side: 'long' }, { coin: 'ETH', side: 'long' }] }).skipped).toContainEqual({ coin: 'SOL', reason: 'same-direction-cap' });
    const enterable = ladder(htfTrendTitle('ETH', 'long', DAY), 'draft');
    expect(selectHtfDrafts({ ...base, positions: [{ coin: 'BTC', side: 'long' }], ladders: [enterable] }).skipped).toContainEqual({ coin: 'SOL', reason: 'same-direction-cap' });
    expect(selectHtfDrafts({ ...base, ladders: [{ ...enterable, rungs: [rung({ triggerMeta: { entryDeadlineMs: DAY + 3_600_000 } })] }] }).skipped).not.toContainEqual({ coin: 'SOL', reason: 'same-direction-cap' });
    expect(selectHtfDrafts({ ...base, signals: [sig('short', 'BTC'), sig('short', 'ETH'), sig('long', 'SOL')] }).draft.map((s) => s.coin)).toEqual(['BTC', 'ETH']);
    const firedHtf = ladder(htfTrendTitle('BTC', 'long', DAY), 'armed', DAY + 4 * 3_600_000, 'long', [rung({ id: 'close', action: 'close', seq: 2 })]);
    firedHtf.rungs[0].status = 'fired';
    const oneHtfAndOnePosition = { ...base, signals: [sig('long', 'ETH')], ladders: [firedHtf], positions: [{ coin: 'BTC', side: 'long' as const }, { coin: 'ETH', side: 'long' as const }] };
    expect(selectHtfDrafts(oneHtfAndOnePosition).skipped).toContainEqual({ coin: 'ETH', reason: 'positioned' });
    expect(selectHtfDrafts({ ...base, signals: [sig('long', 'ETH')], ladders: [firedHtf], positions: [{ coin: 'BTC', side: 'long' }] }).draft.map((s) => s.coin)).toEqual(['ETH']);
    expect(selectHtfDrafts({ ...base, signals: [sig('long', 'SOL')], ladders: [firedHtf], positions: [{ coin: 'BTC', side: 'long' as const }, { coin: 'ETH', side: 'long' as const }] }).skipped).toContainEqual({ coin: 'SOL', reason: 'same-direction-cap' });
    expect(selectHtfDrafts({ ...base, signals: [sig('long', 'DOGE')] })).toEqual({ draft: [], skipped: [] });
  });
});
