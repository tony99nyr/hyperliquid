import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchAllFills, HL_FILLS_PAGE_CAP } from '@/lib/hyperliquid/hyperliquid-info-service';

const ADDR = '0x' + 'a'.repeat(40);

/** Build a raw HL fill row (numbers-as-strings, ascending time). */
function rawFill(time: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    coin: 'ETH',
    side: 'B',
    px: '2000',
    sz: '1',
    time,
    closedPnl: '0',
    dir: 'Open Long',
    hash: `0xhash${time}`,
    ...over,
  };
}

/** A full (page-capped) page of `count` rows starting at `startTime`, 1ms apart. */
function page(startTime: number, count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) => rawFill(startTime + i));
}

function mockFetchPages(pages: Record<string, unknown>[][]) {
  let call = 0;
  const fetchMock = vi.fn().mockImplementation(async () => {
    const body = pages[call] ?? [];
    call++;
    return { ok: true, status: 200, json: async () => body } as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('fetchAllFills — deep time-window pagination (mocked, no network)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('accumulates across multiple capped pages then stops on a short final page', async () => {
    // Two full pages then a short page (< cap) => exhausted, not truncated.
    const p1 = page(1000, HL_FILLS_PAGE_CAP);
    const p2 = page(1000 + HL_FILLS_PAGE_CAP + 1, HL_FILLS_PAGE_CAP);
    const p3 = page(1000 + 2 * (HL_FILLS_PAGE_CAP + 1), 37);
    const fetchMock = mockFetchPages([p1, p2, p3]);

    const res = await fetchAllFills(ADDR, { sinceMs: 0, maxFills: 12000 });

    expect(res.fills).toHaveLength(2 * HL_FILLS_PAGE_CAP + 37);
    expect(res.truncated).toBe(false);
    expect(res.error).toBeUndefined();
    // 3 pages: two full triggered another fetch, the short one stopped the loop.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // Sorted most-recent first.
    expect(res.fills[0].time).toBeGreaterThan(res.fills[res.fills.length - 1].time);
  });

  it('advances the cursor (startTime) forward by last fill time + 1 each page', async () => {
    const p1 = page(1000, HL_FILLS_PAGE_CAP);
    const lastP1 = 1000 + HL_FILLS_PAGE_CAP - 1;
    const p2 = page(lastP1 + 1, 5); // short => stop
    const fetchMock = mockFetchPages([p1, p2]);

    await fetchAllFills(ADDR, { sinceMs: 500, maxFills: 12000 });

    const body0 = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    const body1 = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    expect(body0.type).toBe('userFillsByTime');
    expect(body0.startTime).toBe(500);
    expect(body1.startTime).toBe(lastP1 + 1);
  });

  it('de-duplicates rows that overlap across windows (stable id key)', async () => {
    // p2 repeats the last row of p1 (same hash/time) — must not double-count.
    const p1 = page(1000, HL_FILLS_PAGE_CAP);
    const dupRow = p1[p1.length - 1];
    const p2 = [dupRow, rawFill(99999, { hash: '0xunique' })];
    mockFetchPages([p1, p2]);

    const res = await fetchAllFills(ADDR, { sinceMs: 0, maxFills: 12000 });

    // cap unique + 1 new unique = cap + 1 (the duplicate dropped).
    expect(res.fills).toHaveLength(HL_FILLS_PAGE_CAP + 1);
    expect(res.truncated).toBe(false);
  });

  it('stops and flags truncated when maxFills is reached', async () => {
    const p1 = page(1000, HL_FILLS_PAGE_CAP);
    const p2 = page(1000 + HL_FILLS_PAGE_CAP + 1, HL_FILLS_PAGE_CAP);
    const p3 = page(1000 + 2 * (HL_FILLS_PAGE_CAP + 1), HL_FILLS_PAGE_CAP);
    const fetchMock = mockFetchPages([p1, p2, p3]);

    // maxFills below two full pages => stop after page 2 (>= maxFills), truncated.
    const res = await fetchAllFills(ADDR, { sinceMs: 0, maxFills: HL_FILLS_PAGE_CAP + 100 });

    expect(res.truncated).toBe(true);
    expect(res.fills.length).toBeLessThanOrEqual(HL_FILLS_PAGE_CAP + 100);
    // Did not fetch the third page.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('stops on a no-progress page (all rows at/<= cursor) without looping', async () => {
    // A full page whose max time does not advance past the cursor.
    const stuck = Array.from({ length: HL_FILLS_PAGE_CAP }, () => rawFill(1000, { hash: undefined, tid: undefined, oid: '1' }));
    const fetchMock = mockFetchPages([stuck, page(2000, HL_FILLS_PAGE_CAP)]);

    const res = await fetchAllFills(ADDR, { sinceMs: 1000, maxFills: 12000 });

    // Only one unique row (all identical), and the loop broke on no progress.
    expect(res.fills).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns empty on the first empty page', async () => {
    const fetchMock = mockFetchPages([[]]);
    const res = await fetchAllFills(ADDR, { sinceMs: 0 });
    expect(res.fills).toHaveLength(0);
    expect(res.truncated).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects an invalid address without fetching', async () => {
    const fetchMock = mockFetchPages([page(0, 10)]);
    const res = await fetchAllFills('not-an-address');
    expect(res.error).toMatch(/Invalid/i);
    expect(res.fills).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails soft on a fetch error mid-walk: keeps accumulated fills, flags truncated', async () => {
    let call = 0;
    const fetchMock = vi.fn().mockImplementation(async () => {
      if (call++ === 0) return { ok: true, status: 200, json: async () => page(1000, HL_FILLS_PAGE_CAP) } as Response;
      return { ok: false, status: 500, json: async () => ({}) } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await fetchAllFills(ADDR, { sinceMs: 0, maxFills: 12000 });

    expect(res.fills).toHaveLength(HL_FILLS_PAGE_CAP);
    expect(res.truncated).toBe(true);
    expect(res.error).toBeDefined();
  });
});
