import { describe, it, expect, vi } from 'vitest';
import { buildFallbackPatch, HlRestFallback } from '@/lib/ws/hl-rest-fallback';
import type { LiveMarketState } from '@/types/market';

const NOW = 1_700_000_000_000;

const rawBook = {
  coin: 'ETH',
  time: NOW,
  levels: [
    [
      { px: '1999', sz: '2' },
      { px: '1998', sz: '5' },
    ],
    [
      { px: '2001', sz: '1' },
      { px: '2002', sz: '4' },
    ],
  ],
};

describe('hl-rest-fallback', () => {
  describe('buildFallbackPatch (pure)', () => {
    it('builds a stale patch with book + derived mid', () => {
      const patch = buildFallbackPatch('ETH', rawBook, NOW);
      expect(patch).not.toBeNull();
      expect(patch!.bids![0]).toEqual({ px: 1999, sz: 2 });
      expect(patch!.asks![0]).toEqual({ px: 2001, sz: 1 });
      expect(patch!.midPx).toBe(2000);
      expect(patch!.lastPx).toBe(2000);
      expect(patch!.stale).toBe(true);
      expect(patch!.status).toBe('stale');
    });

    it('returns null for malformed payloads', () => {
      expect(buildFallbackPatch('ETH', null, NOW)).toBeNull();
      expect(buildFallbackPatch('ETH', { coin: 'ETH' }, NOW)).toBeNull();
    });

    it('returns null on a coin mismatch', () => {
      expect(buildFallbackPatch('ETH', { ...rawBook, coin: 'BTC' }, NOW)).toBeNull();
    });
  });

  describe('pollOnce (mocked fetch)', () => {
    it('POSTs l2Book and pushes a patch', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => rawBook } as Response);
      const patches: Array<Partial<LiveMarketState>> = [];
      const fb = new HlRestFallback({ coin: 'ETH', fetchImpl: fetchMock }, (p) => patches.push(p));

      await fb.pollOnce();

      expect(patches).toHaveLength(1);
      expect(patches[0].midPx).toBe(2000);
      const [, init] = fetchMock.mock.calls[0];
      expect(JSON.parse((init as RequestInit).body as string)).toEqual({ type: 'l2Book', coin: 'ETH' });
    });

    it('swallows errors (degraded path, no patch)', async () => {
      const fetchMock = vi.fn().mockRejectedValue(new Error('down'));
      const patches: Array<Partial<LiveMarketState>> = [];
      const fb = new HlRestFallback({ coin: 'ETH', fetchImpl: fetchMock }, (p) => patches.push(p));
      await expect(fb.pollOnce()).resolves.toBeUndefined();
      expect(patches).toHaveLength(0);
    });

    it('does not patch on a non-ok response', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) } as Response);
      const patches: Array<Partial<LiveMarketState>> = [];
      const fb = new HlRestFallback({ coin: 'ETH', fetchImpl: fetchMock }, (p) => patches.push(p));
      await fb.pollOnce();
      expect(patches).toHaveLength(0);
    });
  });
});
