import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LadderWithRungs } from '@/lib/ladder/ladder-types';

const listLaddersWithRungs = vi.fn();
const fetchClearinghouseState = vi.fn();
const findAllStops = vi.fn();
const sendDiscord = vi.fn();
const writeAnalysisLog = vi.fn();
const getActiveSession = vi.fn();
const getHlAccountAddress = vi.fn();
const from = vi.fn();

vi.mock('@/lib/ladder/ladder-service', () => ({ listLaddersWithRungs: (...args: unknown[]) => listLaddersWithRungs(...args) }));
vi.mock('@/lib/cockpit/supabase-server', () => ({ getServiceRoleClient: () => ({ from }) }));
vi.mock('@/lib/hyperliquid/hyperliquid-info-service', () => ({ fetchClearinghouseState: (...args: unknown[]) => fetchClearinghouseState(...args) }));
vi.mock('@/lib/trading/stop-order-service', () => ({ findAllStops: (...args: unknown[]) => findAllStops(...args) }));
vi.mock('@/lib/infrastructure/notify/discord-notify', () => ({ sendDiscord: (...args: unknown[]) => sendDiscord(...args) }));
vi.mock('@/lib/cockpit/analysis-log-service', () => ({ writeAnalysisLog: (...args: unknown[]) => writeAnalysisLog(...args) }));
vi.mock('@/lib/cockpit/session-service', () => ({ getActiveSession: (...args: unknown[]) => getActiveSession(...args) }));
vi.mock('@/lib/auto-exit/auto-exit-config', () => ({ getHlAccountAddress: (...args: unknown[]) => getHlAccountAddress(...args) }));

import { runExpiryAlerts } from '@/lib/ladder/ladder-expiry-alert-service';

const ladder: LadderWithRungs = {
  id: 'ladder-1234', title: 'CPI short', thesis: null, author: 'operator', mode: 'live', status: 'expired',
  preconditionHash: null, ocoGroupId: null, leaderAddress: null, maxTotalNotionalUsd: null,
  maxTotalLossUsd: null, anchorPx: null, expiresAt: null, activeFrom: null, armedAt: null,
  disarmedAt: null, disarmReason: 'expired', archivedAt: null, expiryAlertAt: null,
  createdAt: '', updatedAt: '', rungs: [{ id: 'r1', ladderId: 'ladder-1234', seq: 1,
    coin: 'BTC', side: 'short', action: 'open', triggerKind: 'price_below', triggerPx: 100,
    triggerMeta: null, sizeCoins: 0.2, reduceFrac: null, riskUsd: null, stopFrac: null,
    leverage: 2, stopPx: 105, targetPx: null, status: 'fired', cloid: null }],
};

let unstamped: boolean;
let queries: Array<{ update: ReturnType<typeof vi.fn>; in: ReturnType<typeof vi.fn> }>;
let fireRows: Array<{ rung_id: string }>;
let fireFilters: unknown[][];
let fireError: { message: string } | null;
beforeEach(() => {
  vi.clearAllMocks();
  unstamped = true;
  queries = [];
  fireRows = [];
  fireFilters = [];
  fireError = null;
  listLaddersWithRungs.mockImplementation(async (status: string) => status === 'expired' ? [ladder] : []);
  getHlAccountAddress.mockReturnValue('0xabc');
  getActiveSession.mockResolvedValue({ id: 'session-1' });
  fetchClearinghouseState.mockResolvedValue({ stale: false, error: null, positions: [{ coin: 'BTC', side: 'short', size: 0.2 }] });
  findAllStops.mockResolvedValue({ BTC: { oid: 99, triggerPx: 102, sz: 0.2 } });
  sendDiscord.mockResolvedValue(undefined);
  writeAnalysisLog.mockResolvedValue(undefined);
  from.mockImplementation((table: string) => {
    if (table === 'ladder_fires') {
      const fires = { select: () => fires, in: (...a: unknown[]) => { fireFilters.push(a); return fires; }, then: (resolve: (v: unknown) => void) => resolve(fireError ? { data: null, error: fireError } : { data: fireRows, error: null }) };
      return fires;
    }
    const query = {
      select: vi.fn(), eq: vi.fn(), is: vi.fn(), in: vi.fn(), update: vi.fn(),
    };
    queries.push(query);
    query.in.mockImplementation(() => query);
    query.select.mockImplementation(() => query);
    query.eq.mockImplementation(() => query);
    query.is.mockImplementation(() => query);
    query.update.mockImplementation(() => {
      query.select.mockImplementation(async () => { unstamped = false; return { data: [{ id: ladder.id }], error: null }; });
      return query;
    });
    // A thenable query matches Supabase's awaited SELECT chain.
    return Object.assign(query, {
      then: (resolve: (value: { data: { id: string }[]; error: null }) => void) =>
        resolve({ data: unstamped ? [{ id: ladder.id }] : [], error: null }),
    });
  });
});

describe('runExpiryAlerts residual', () => {
  it('alerts both channels once with the moved exchange stop', async () => {
    const first = await runExpiryAlerts();
    const second = await runExpiryAlerts();
    expect(first.alerted).toEqual([ladder.id]);
    expect(second.alerted).toEqual([]);
    expect(sendDiscord).toHaveBeenCalledOnce();
    expect(sendDiscord.mock.calls[0][0]).toMatch(/BTC short 0\.2 coins, resting stop 102/);
    expect(writeAnalysisLog).toHaveBeenCalledOnce();
  });

  it('pages when the live position is unreadable', async () => {
    fetchClearinghouseState.mockResolvedValue({ stale: true, error: 'timeout', positions: [] });
    await runExpiryAlerts();
    expect(sendDiscord.mock.calls[0][0]).toMatch(/Could not verify residual position/);
    expect(findAllStops).not.toHaveBeenCalled();
  });

  it('alerts for a ladder that was archived before it was armed', async () => {
    const archived = { ...ladder, archivedAt: '2026-10-28T17:34:39Z' };
    listLaddersWithRungs.mockImplementation(async (status: string, opts?: { ids?: string[] }) =>
      status === 'expired' && opts?.ids?.includes(ladder.id) ? [archived] : []);
    const summary = await runExpiryAlerts();
    expect(listLaddersWithRungs).toHaveBeenCalledWith('expired', { ids: [ladder.id] });
    expect(summary.alerted).toEqual([ladder.id]);
    expect(sendDiscord.mock.calls[0][0]).toMatch(/BTC short 0\.2 coins/);
  });

  const settledAt = () => new Date(Date.now() - 3_600_000).toISOString();
  const neverFired = (disarmedAt: string) => ({ ...ladder, disarmedAt,
    rungs: ladder.rungs.map((rung) => ({ ...rung, status: 'pending' as const })) });
  const stampQuery = () => queries.find((q) => q.in.mock.calls.length > 0);

  it('stamps a settled ladder whose entry never fired, so it leaves the candidate list', async () => {
    listLaddersWithRungs.mockImplementation(async (status: string) => status === 'expired' ? [neverFired(settledAt())] : []);
    const summary = await runExpiryAlerts();
    expect(summary.alerted).toEqual([]);
    expect(sendDiscord).not.toHaveBeenCalled();
    expect(fetchClearinghouseState).not.toHaveBeenCalled();
    expect(stampQuery()?.update).toHaveBeenCalledWith(expect.objectContaining({ residual_alert_at: expect.any(String) }));
    expect(stampQuery()?.in).toHaveBeenCalledWith('id', [ladder.id]);
  });

  it('keeps watching a ladder that expired moments ago (a fire may still land)', async () => {
    listLaddersWithRungs.mockImplementation(async (status: string) => status === 'expired' ? [neverFired(new Date().toISOString())] : []);
    await runExpiryAlerts();
    expect(stampQuery()).toBeUndefined();
  });

  it('pages for an entry with a fire on record, even when the rung status write failed', async () => {
    fireRows = [{ rung_id: 'r1' }];
    listLaddersWithRungs.mockImplementation(async (status: string) => status === 'expired' ? [neverFired(settledAt())] : []);
    const summary = await runExpiryAlerts();
    expect(fireFilters).toContainEqual(['rung_id', ['r1']]);
    expect(summary.alerted).toEqual([ladder.id]);
    expect(sendDiscord.mock.calls[0][0]).toMatch(/BTC short 0\.2 coins/);
  });

  it('stamps nothing quietly when the fire ledger is unreadable', async () => {
    fireError = { message: 'timeout' };
    listLaddersWithRungs.mockImplementation(async (status: string) => status === 'expired' ? [neverFired(settledAt())] : []);
    await runExpiryAlerts();
    expect(stampQuery()).toBeUndefined();
  });

  it('stamps a settled ladder that is flat on a good read (a later position is not its own)', async () => {
    fetchClearinghouseState.mockResolvedValue({ stale: false, error: null, positions: [] });
    listLaddersWithRungs.mockImplementation(async (status: string) => status === 'expired' ? [{ ...ladder, disarmedAt: settledAt() }] : []);
    const summary = await runExpiryAlerts();
    expect(summary.alerted).toEqual([]);
    expect(stampQuery()?.in).toHaveBeenCalledWith('id', [ladder.id]);
  });

  it('does not claim an alert when the position is flat', async () => {
    fetchClearinghouseState.mockResolvedValue({ stale: false, error: null, positions: [] });
    const summary = await runExpiryAlerts();
    expect(summary.alerted).toEqual([]);
    expect(sendDiscord).not.toHaveBeenCalled();
    expect(writeAnalysisLog).not.toHaveBeenCalled();
    expect(unstamped).toBe(true);
  });
});
