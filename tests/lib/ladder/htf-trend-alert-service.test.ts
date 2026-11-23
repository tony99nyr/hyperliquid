import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LadderRung, LadderWithRungs } from '@/lib/ladder/ladder-types';
import type { HtfTrendRead } from '@/lib/scout/htf-trend-signal-business-logic';

const mocks = vi.hoisted(() => ({
  listLaddersWithRungs: vi.fn(), archiveLadder: vi.fn(), createLadder: vi.fn(), disarmLadder: vi.fn(),
  fetchClearinghouseState: vi.fn(), getHlAccountAddress: vi.fn(), calendarExhausted: vi.fn(),
  nearestBlackoutEvent: vi.fn(), sendDiscord: vi.fn(), isDiscordConfigured: vi.fn(), validateEnv: vi.fn(),
  readHtfDaily: vi.fn(), from: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/cockpit/supabase-server', () => ({ getServiceRoleClient: () => ({ from: mocks.from }) }));
vi.mock('@/lib/hyperliquid/hyperliquid-info-service', () => ({ fetchClearinghouseState: (...args: unknown[]) => mocks.fetchClearinghouseState(...args) }));
vi.mock('@/lib/auto-exit/auto-exit-config', () => ({ getHlAccountAddress: (...args: unknown[]) => mocks.getHlAccountAddress(...args) }));
vi.mock('@/lib/skills/event-calendar-business-logic', () => ({ calendarExhausted: (...args: unknown[]) => mocks.calendarExhausted(...args), nearestBlackoutEvent: (...args: unknown[]) => mocks.nearestBlackoutEvent(...args) }));
vi.mock('@/lib/infrastructure/notify/discord-notify', () => ({ sendDiscord: (...args: unknown[]) => mocks.sendDiscord(...args), isDiscordConfigured: (...args: unknown[]) => mocks.isDiscordConfigured(...args) }));
vi.mock('@/lib/env/env', () => ({ validateEnv: (...args: unknown[]) => mocks.validateEnv(...args) }));
vi.mock('@/lib/ladder/ladder-service', () => ({ archiveLadder: (...args: unknown[]) => mocks.archiveLadder(...args), createLadder: (...args: unknown[]) => mocks.createLadder(...args), disarmLadder: (...args: unknown[]) => mocks.disarmLadder(...args), listLaddersWithRungs: (...args: unknown[]) => mocks.listLaddersWithRungs(...args) }));
vi.mock('@/lib/ladder/ladder-htf-exit-service', () => ({ readHtfDaily: (...args: unknown[]) => mocks.readHtfDaily(...args) }));

import { runHtfTrendAlertCycle } from '@/lib/ladder/htf-trend-alert-service';
import { htfTrendTitle, HTF_CALENDAR_WARNING } from '@/lib/ladder/htf-trend-alert-business-logic';
import { DAY_MS } from '@/lib/ladder/ladder-htf-exit-business-logic';

const DAY = Date.UTC(2026, 10, 14);
const NOW = DAY + 10 * 60_000;
const read = (side: 'long' | 'short' | null): HtfTrendRead => ({ latestClose: 110, don20High: 100, don20Low: 90, don10High: 105, don10Low: 95, atr: 2, breakout: side ? { side, entryPx: 110, stopPx: 100, stopFrac: 0.06, exitPx: 95 } : null });
const rung = (id: string, ladderId: string, extra: Partial<LadderRung> = {}): LadderRung => ({ id, ladderId, seq: 1, coin: 'BTC', side: 'long', action: 'open', triggerKind: 'price_above', triggerPx: 100, triggerMeta: { entryDeadlineMs: DAY + 4 * 3_600_000 }, sizeCoins: null, reduceFrac: null, riskUsd: 10, stopFrac: 0.06, leverage: 2, stopPx: null, targetPx: null, status: 'pending', cloid: null, ...extra });
const ladder = (title: string, status: LadderWithRungs['status'], id = 'ladder-id-1234', deadline = DAY - DAY_MS + 4 * 3_600_000): LadderWithRungs => ({ id, title, thesis: null, author: 'operator', mode: 'live', status, preconditionHash: null, ocoGroupId: null, leaderAddress: null, maxTotalNotionalUsd: 400, maxTotalLossUsd: 100, anchorPx: null, expiresAt: new Date(DAY + 90 * DAY_MS).toISOString(), activeFrom: null, armedAt: null, disarmedAt: null, disarmReason: null, archivedAt: null, expiryAlertAt: null, createdAt: new Date(DAY).toISOString(), updatedAt: new Date(DAY).toISOString(), rungs: [rung(`${id}-opener`, id, { triggerMeta: { entryDeadlineMs: deadline } })] });

let ladderRows: Array<{ title: string }>;
let fireRows: Array<{ rung_id: string }>;
let ladderError: { message: string } | null;
let fireError: { message: string } | null;
let byStatus: Record<string, LadderWithRungs[]>;
let positionRows: Array<{ coin: string; side: 'long' | 'short' }>;
let positionsListed: boolean | undefined;
let positionSequence: Array<{ positionsListed?: boolean; stale: boolean; error: string | null; positions: Array<{ coin: string; side: 'long' | 'short' }> }>;
let unreadable: { address?: string; stale?: boolean; error?: string };
let dailyByCoin: Record<string, HtfTrendRead | null>;
let closeMs: number;

beforeEach(() => {
  vi.clearAllMocks();
  ladderRows = []; fireRows = []; ladderError = null; fireError = null; byStatus = { draft: [], armed: [] };
  positionRows = []; positionSequence = []; positionsListed = true; unreadable = { address: '0xabc', stale: false };
  dailyByCoin = { BTC: read('short'), ETH: read(null), SOL: read(null), HYPE: read(null) }; closeMs = DAY;
  mocks.listLaddersWithRungs.mockImplementation(async (status: string) => byStatus[status] ?? []);
  mocks.getHlAccountAddress.mockImplementation(() => unreadable.address);
  mocks.fetchClearinghouseState.mockImplementation(async () => positionSequence.shift() ?? ({ positionsListed, stale: unreadable.stale ?? false, error: unreadable.error ?? null, positions: positionRows }));
  mocks.calendarExhausted.mockReturnValue(false); mocks.nearestBlackoutEvent.mockReturnValue(null);
  mocks.sendDiscord.mockResolvedValue(true); mocks.isDiscordConfigured.mockReturnValue(true);
  mocks.validateEnv.mockReturnValue({ COCKPIT_BASE_URL: 'https://example.test' });
  mocks.createLadder.mockResolvedValue('created-ladder-123'); mocks.archiveLadder.mockResolvedValue(true); mocks.disarmLadder.mockResolvedValue(true);
  mocks.readHtfDaily.mockImplementation(async (coin: string) => {
    const value = dailyByCoin[coin];
    return value ? { signalCloseMs: closeMs, read: value } : null;
  });
  mocks.from.mockImplementation((table: string) => {
    const query = { select: vi.fn(), like: vi.fn(), in: vi.fn() };
    query.select.mockReturnValue(query); query.like.mockReturnValue(query); query.in.mockReturnValue(query);
    return Object.assign(query, { then: (resolve: (v: unknown) => unknown) => resolve(table === 'ladders' ? { data: ladderRows, error: ladderError } : { data: fireRows, error: fireError }) });
  });
});

describe('runHtfTrendAlertCycle', () => {
  it('lists ladders outside the drafting window without reading other dependencies', async () => {
    const result = await runHtfTrendAlertCycle(DAY + 5 * 3_600_000);
    expect(result.skipped).toBe('outside-window');
    expect(mocks.listLaddersWithRungs).toHaveBeenCalledTimes(2); expect(mocks.getHlAccountAddress).not.toHaveBeenCalled();
    expect(mocks.readHtfDaily).not.toHaveBeenCalled(); expect(mocks.from).not.toHaveBeenCalled();
  });

  it.each([
    ['no address', { address: undefined }], ['stale account', { address: '0xabc', stale: true }], ['account error', { address: '0xabc', error: 'timeout' }],
  ])('does not touch ladders when positions are unreadable: %s', async (_name, state) => {
    unreadable = state;
    const result = await runHtfTrendAlertCycle(NOW);
    expect(result.skipped).toBe('positions-unreadable');
    expect(mocks.createLadder).not.toHaveBeenCalled(); expect(mocks.archiveLadder).not.toHaveBeenCalled(); expect(mocks.disarmLadder).not.toHaveBeenCalled();
  });

  it('treats an account response without the positions array as unreadable', async () => {
    const armed = ladder(htfTrendTitle('BTC', 'long', DAY), 'armed'); byStatus.armed = [armed]; fireRows = [{ rung_id: armed.rungs[0].id }];
    positionsListed = undefined;
    const result = await runHtfTrendAlertCycle(NOW);
    expect(result.skipped).toBe('positions-unreadable');
    expect(mocks.createLadder).not.toHaveBeenCalled(); expect(mocks.disarmLadder).not.toHaveBeenCalled();
  });

  it('does not disarm an entered ladder when the confirmation read has no positions array', async () => {
    const armed = ladder(htfTrendTitle('BTC', 'long', DAY), 'armed'); byStatus.armed = [armed]; fireRows = [{ rung_id: armed.rungs[0].id }];
    positionSequence = [{ positionsListed: true, stale: false, error: null, positions: [] }, { stale: false, error: null, positions: [] }];
    const result = await runHtfTrendAlertCycle(NOW);
    expect(mocks.disarmLadder).not.toHaveBeenCalled(); expect(result.errors.join(' ')).toContain('did not confirm a flat');
  });

  it('with drafting off, drafts nothing inside the window and reads the armed ladders only', async () => {
    const result = await runHtfTrendAlertCycle(NOW, { draft: false });
    expect(result.skipped).toBe('drafting-off');
    expect(mocks.listLaddersWithRungs).toHaveBeenCalledTimes(1); expect(mocks.listLaddersWithRungs).toHaveBeenCalledWith('armed');
    expect(mocks.fetchClearinghouseState).not.toHaveBeenCalled(); expect(mocks.readHtfDaily).not.toHaveBeenCalled(); expect(mocks.createLadder).not.toHaveBeenCalled();
  });

  it('with drafting off, still disarms a spent armed ladder and drafts nothing', async () => {
    const armed = ladder(htfTrendTitle('BTC', 'long', DAY), 'armed'); byStatus.armed = [armed];
    const result = await runHtfTrendAlertCycle(NOW, { draft: false });
    expect(mocks.disarmLadder).toHaveBeenCalledWith(armed.id, 'htf-trend-spent'); expect(result.disarmedSpent).toContain(armed.id);
    expect(result.skipped).toBe('drafting-off'); expect(mocks.readHtfDaily).not.toHaveBeenCalled(); expect(mocks.createLadder).not.toHaveBeenCalled();
  });

  it('creates and announces a live two-rung draft for a breakout', async () => {
    const result = await runHtfTrendAlertCycle(NOW);
    expect(mocks.createLadder).toHaveBeenCalledOnce();
    expect(mocks.createLadder.mock.calls[0][0]).toMatchObject({ mode: 'live', author: 'operator', rungs: expect.arrayContaining([expect.any(Object), expect.any(Object)]) });
    expect((mocks.createLadder.mock.calls[0][0] as { rungs: unknown[] }).rungs).toHaveLength(2);
    expect(result.drafted).toHaveLength(1); expect(mocks.sendDiscord).toHaveBeenCalledOnce();
    expect(mocks.sendDiscord.mock.calls[0][1]).toBe('HL HTF Trend Desk');
  });

  it('counts the draft when Discord returns false and reports the failed ping', async () => {
    mocks.sendDiscord.mockResolvedValue(false);
    const result = await runHtfTrendAlertCycle(NOW);
    expect(result.drafted).toHaveLength(1); expect(result.errors.join(' ')).toMatch(/Discord ping FAILED/);
  });

  it('skips drafting during an event blackout', async () => {
    mocks.nearestBlackoutEvent.mockReturnValue({ name: 'CPI', msOut: 3_600_000 });
    const result = await runHtfTrendAlertCycle(NOW);
    expect(result.skipped).toBe('event-blackout'); expect(mocks.createLadder).not.toHaveBeenCalled(); expect(result.errors.join(' ')).toContain('CPI');
  });

  it('reports an exhausted calendar and still creates the draft', async () => {
    mocks.calendarExhausted.mockReturnValue(true);
    const result = await runHtfTrendAlertCycle(NOW);
    expect(result.errors.join(' ')).toContain('event calendar exhausted'); expect(mocks.createLadder).toHaveBeenCalledOnce();
    expect(mocks.sendDiscord.mock.calls[0][0]).toContain(HTF_CALENDAR_WARNING);
  });

  it('does not draft a coin already drafted today', async () => {
    ladderRows = [{ title: htfTrendTitle('BTC', 'short', DAY) }];
    const result = await runHtfTrendAlertCycle(NOW);
    expect(mocks.createLadder).not.toHaveBeenCalled(); expect(result.notDrafted).toContainEqual({ coin: 'BTC', reason: 'already-drafted' });
  });

  it('fails closed when the dedupe query errors', async () => {
    ladderError = { message: 'query unavailable' };
    const result = await runHtfTrendAlertCycle(NOW);
    expect(mocks.createLadder).not.toHaveBeenCalled(); expect(result.errors.join(' ')).toContain('query unavailable');
  });

  it('reports missing daily data and counts only successful reads', async () => {
    dailyByCoin = { BTC: read('short'), ETH: null, SOL: read(null), HYPE: read(null) };
    const result = await runHtfTrendAlertCycle(NOW);
    expect(result.errors.join(' ')).toContain('ETH: daily read unavailable'); expect(result.scanned).toBe(3);
  });

  it('ignores a daily read from another signal close', async () => {
    closeMs = DAY - DAY_MS;
    const result = await runHtfTrendAlertCycle(NOW);
    expect(result.signals).toEqual([]); expect(result.drafted).toEqual([]);
  });

  it('archives a stale draft from this drafter', async () => {
    const stale = ladder(htfTrendTitle('BTC', 'long', DAY), 'draft'); byStatus.draft = [stale];
    const result = await runHtfTrendAlertCycle(NOW);
    expect(mocks.archiveLadder).toHaveBeenCalledWith(stale.id); expect(result.archivedStale).toContain(stale.id);
    // The archive frees the coin: the cycle drafts today's signal on it.
    expect(mocks.createLadder).toHaveBeenCalledTimes(1);
    expect(result.notDrafted.some((s) => s.reason === 'vehicle')).toBe(false);
  });

  it('keeps counting a stale draft as a vehicle when the archive is refused', async () => {
    const stale = ladder(htfTrendTitle('BTC', 'long', DAY), 'draft'); byStatus.draft = [stale];
    mocks.archiveLadder.mockResolvedValueOnce(false);
    const result = await runHtfTrendAlertCycle(NOW);
    expect(result.archivedStale).not.toContain(stale.id);
    expect(mocks.createLadder).not.toHaveBeenCalled();
    expect(result.notDrafted.some((s) => s.reason === 'vehicle')).toBe(true);
  });

  it('archives a stale draft outside the drafting window without an account read', async () => {
    const stale = ladder(htfTrendTitle('BTC', 'long', DAY), 'draft', 'stale-id', DAY - 60_000);
    byStatus.draft = [stale];
    const result = await runHtfTrendAlertCycle(DAY + 5 * 3_600_000);
    expect(mocks.archiveLadder).toHaveBeenCalledWith(stale.id);
    expect(result.skipped).toBe('outside-window');
    expect(mocks.fetchClearinghouseState).not.toHaveBeenCalled();
    expect(mocks.readHtfDaily).not.toHaveBeenCalled();
  });

  it('does not disarm an armed ladder inside the spent grace period', async () => {
    const armed = ladder(htfTrendTitle('BTC', 'long', DAY), 'armed', 'grace-id', DAY + 10 * 60_000);
    byStatus.armed = [armed];
    const result = await runHtfTrendAlertCycle(DAY + 20 * 60_000);
    expect(result.disarmedSpent).not.toContain(armed.id);
    expect(mocks.disarmLadder).not.toHaveBeenCalled();
  });

  it('does not disarm an entered ladder when the confirmation read still has its position', async () => {
    const armed = ladder(htfTrendTitle('BTC', 'long', DAY), 'armed');
    byStatus.armed = [armed]; fireRows = [{ rung_id: armed.rungs[0].id }];
    positionSequence = [
      { positionsListed: true, stale: false, error: null, positions: [] },
      { positionsListed: true, stale: false, error: null, positions: [{ coin: 'BTC', side: 'long' }] },
    ];
    const result = await runHtfTrendAlertCycle(DAY + 5 * 3_600_000);
    expect(mocks.fetchClearinghouseState).toHaveBeenCalledTimes(2);
    expect(mocks.disarmLadder).not.toHaveBeenCalled();
    expect(result.errors.join(' ')).toContain('did not confirm a flat');
  });

  it('does not disarm an entered ladder when the confirmation read is stale', async () => {
    const armed = ladder(htfTrendTitle('BTC', 'long', DAY), 'armed');
    byStatus.armed = [armed]; fireRows = [{ rung_id: armed.rungs[0].id }];
    positionSequence = [
      { positionsListed: true, stale: false, error: null, positions: [] },
      { positionsListed: true, stale: true, error: null, positions: [] },
    ];
    const result = await runHtfTrendAlertCycle(DAY + 5 * 3_600_000);
    expect(mocks.disarmLadder).not.toHaveBeenCalled();
    expect(result.errors.join(' ')).toContain('did not confirm a flat');
  });

  it('checks an overdue armed ladder outside the drafting window without drafting', async () => {
    const armed = ladder(htfTrendTitle('BTC', 'long', DAY), 'armed');
    byStatus.armed = [armed];
    const result = await runHtfTrendAlertCycle(DAY + 5 * 3_600_000);
    expect(result.skipped).toBe('outside-window');
    expect(result.disarmedSpent).toContain(armed.id);
    expect(mocks.fetchClearinghouseState).toHaveBeenCalledOnce();
    expect(mocks.readHtfDaily).not.toHaveBeenCalled();
    expect(mocks.createLadder).not.toHaveBeenCalled();
    expect(mocks.sendDiscord.mock.calls[0][0]).toContain('never entered');
  });

  it('reports a failed Discord ping after a spent disarm', async () => {
    const armed = ladder(htfTrendTitle('BTC', 'long', DAY), 'armed');
    byStatus.armed = [armed]; mocks.sendDiscord.mockResolvedValue(false);
    const result = await runHtfTrendAlertCycle(DAY + 5 * 3_600_000);
    expect(result.disarmedSpent).toContain(armed.id);
    expect(result.errors.join(' ')).toContain('disarmed but the Discord ping FAILED');
    expect(mocks.sendDiscord.mock.calls[0][1]).toBe('HL HTF Trend Desk');
  });

  it('disarms a never-entered armed ladder even when the same side is held', async () => {
    const armed = ladder(htfTrendTitle('BTC', 'long', DAY), 'armed'); byStatus.armed = [armed]; positionRows = [{ coin: 'BTC', side: 'long' }];
    const result = await runHtfTrendAlertCycle(NOW);
    expect(mocks.disarmLadder).toHaveBeenCalledWith(armed.id, 'htf-trend-spent'); expect(result.disarmedSpent).toContain(armed.id);
  });

  it('keeps an entered armed ladder while its same-side position remains open', async () => {
    const armed = ladder(htfTrendTitle('BTC', 'long', DAY), 'armed'); byStatus.armed = [armed];
    fireRows = [{ rung_id: armed.rungs[0].id }]; positionRows = [{ coin: 'BTC', side: 'long' }];
    await runHtfTrendAlertCycle(NOW);
    expect(mocks.disarmLadder).not.toHaveBeenCalled();
  });

  it('disarms an entered armed ladder when the account is flat on its coin', async () => {
    const armed = ladder(htfTrendTitle('BTC', 'long', DAY), 'armed'); byStatus.armed = [armed]; fireRows = [{ rung_id: armed.rungs[0].id }];
    const result = await runHtfTrendAlertCycle(NOW);
    expect(mocks.disarmLadder).toHaveBeenCalledWith(armed.id, 'htf-trend-spent'); expect(result.disarmedSpent).toContain(armed.id);
  });

  it('does not disarm when the fire read errors and continues to drafting', async () => {
    const armed = ladder(htfTrendTitle('BTC', 'long', DAY), 'armed'); byStatus.armed = [armed]; fireError = { message: 'fire query failed' };
    const result = await runHtfTrendAlertCycle(NOW);
    expect(mocks.disarmLadder).not.toHaveBeenCalled(); expect(result.errors.join(' ')).toContain('no armed ladder disarmed'); expect(mocks.readHtfDaily).toHaveBeenCalledTimes(4);
  });

  it('reports a disarm failure and continues to drafting', async () => {
    const armed = ladder(htfTrendTitle('BTC', 'long', DAY), 'armed'); byStatus.armed = [armed];
    mocks.disarmLadder.mockRejectedValue(new Error('write failed'));
    const result = await runHtfTrendAlertCycle(NOW);
    expect(result.errors.join(' ')).toContain('write failed'); expect(mocks.readHtfDaily).toHaveBeenCalledTimes(4);
  });

  it('leaves another drafter’s armed ladder untouched', async () => {
    const other = ladder('BTC other-lane long', 'armed'); byStatus.armed = [other];
    await runHtfTrendAlertCycle(NOW);
    expect(mocks.archiveLadder).not.toHaveBeenCalled(); expect(mocks.disarmLadder).not.toHaveBeenCalled();
  });
});
