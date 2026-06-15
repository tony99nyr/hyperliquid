import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseL2Book, fetchL2Book } from '@/lib/hyperliquid/hyperliquid-info-service';

const rawBook = {
  coin: 'ETH',
  time: 1_700_000_000_000,
  levels: [
    [
      { px: '1999', sz: '2' },
      { px: '1998', sz: '5' },
      { px: '0', sz: '1' }, // dropped (px <= 0)
    ],
    [
      { px: '2001', sz: '1' },
      { px: '2002', sz: '0' }, // dropped (sz <= 0)
    ],
  ],
};

describe('parseL2Book (pure)', () => {
  it('normalizes bids/asks and drops zero px/sz levels', () => {
    const book = parseL2Book('ETH', rawBook);
    expect(book.coin).toBe('ETH');
    expect(book.bids).toEqual([
      { px: 1999, sz: 2 },
      { px: 1998, sz: 5 },
    ]);
    expect(book.asks).toEqual([{ px: 2001, sz: 1 }]);
  });

  it('tolerates a missing levels array', () => {
    const book = parseL2Book('ETH', { coin: 'ETH' });
    expect(book.bids).toEqual([]);
    expect(book.asks).toEqual([]);
  });
});

describe('fetchL2Book (I/O, mocked, no cache)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('POSTs l2Book with the upper-cased coin and parses the result', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => rawBook } as Response);
    vi.stubGlobal('fetch', fetchMock);

    const book = await fetchL2Book('eth');
    expect(book.bids[0]).toEqual({ px: 1999, sz: 2 });

    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ type: 'l2Book', coin: 'ETH' });
  });

  it('throws on a non-ok response (paper fill must fail, not fill stale)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) } as Response));
    await expect(fetchL2Book('ETH')).rejects.toThrow('500');
  });

  it('does NOT cache — two calls fetch twice', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => rawBook } as Response);
    vi.stubGlobal('fetch', fetchMock);
    await fetchL2Book('ETH');
    await fetchL2Book('ETH');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
