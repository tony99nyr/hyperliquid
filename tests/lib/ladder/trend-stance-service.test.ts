/**
 * Pins the stance reader: the HTTP route read, its 9h age gate, the module cache and
 * fail-closed null on any failure.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const env: Record<string, string | undefined> = {};
vi.mock('@/lib/env/env', () => ({ validateEnv: () => env }));

import { clearTrendStanceCache, fetchTrendStance } from '@/lib/ladder/trend-stance-service';

const NOW = Date.UTC(2026, 10, 24, 12, 0, 0);
const body = (generatedAt: number, regime = 'bullish') => ({
  ok: true,
  generatedAt,
  stances: [{ asset: 'ETH', enabled: true, position: 'holding', regime, regimeConfidence: 0.8 }],
});
const fetchMock = vi.fn();

beforeEach(() => {
  clearTrendStanceCache();
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchMock);
  Object.assign(env, { IAMROSSI_STANCE_URL: 'https://iamrossi.example/', IAMROSSI_STANCE_TOKEN: 'x'.repeat(32) });
  fetchMock.mockImplementation(async () => new Response(JSON.stringify(body(NOW - 60_000))));
});

describe('fetchTrendStance', () => {
  it('reads the stance route with the bearer token and sanitises the body', async () => {
    const snap = await fetchTrendStance(NOW);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://iamrossi.example/api/trading/stance');
    expect(init.headers).toEqual({ Authorization: `Bearer ${'x'.repeat(32)}` });
    expect(snap?.stances[0]).toEqual({ asset: 'eth', enabled: true, position: 'holding', regime: 'bullish', regimeConfidence: 0.8 });
  });

  it('serves the module cache for 2 min, then fetches again (flip-guard disarm latency)', async () => {
    await fetchTrendStance(NOW);
    await fetchTrendStance(NOW + 2 * 60_000 - 1);
    expect(fetchMock).toHaveBeenCalledOnce();
    await fetchTrendStance(NOW + 2 * 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns null for a body older than the 9h gate', async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify(body(NOW - 10 * 3_600_000))));
    expect(await fetchTrendStance(NOW)).toBeNull();
  });

  it('returns null on an HTTP error or a network failure (callers treat null as unknown)', async () => {
    fetchMock.mockImplementationOnce(async () => new Response('nope', { status: 500 }));
    expect(await fetchTrendStance(NOW)).toBeNull();
    fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'));
    expect(await fetchTrendStance(NOW)).toBeNull();
  });

  it('returns null without a token, and makes no call', async () => {
    env.IAMROSSI_STANCE_TOKEN = undefined;
    expect(await fetchTrendStance(NOW)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
