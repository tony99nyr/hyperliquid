/**
 * Pins the stance reader's two paths: the Redis fast path (no call to the iamrossi
 * Vercel route) and the HTTP fallback on a Redis miss, error or bad body.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const env: Record<string, string | undefined> = {};
vi.mock('@/lib/env/env', () => ({ validateEnv: () => env }));

const redisGet = vi.fn();
const redisConnect = vi.fn();
vi.mock('redis', () => ({
  createClient: () => ({
    on: () => undefined,
    connect: () => redisConnect(),
    get: (k: string) => redisGet(k),
    destroy: () => undefined,
  }),
}));

import { clearTrendStanceCache, fetchTrendStance, STANCE_REDIS_KEY } from '@/lib/ladder/trend-stance-service';

const NOW = Date.UTC(2026, 10, 24, 12, 0, 0);
const body = (generatedAt: number, regime = 'bullish') => ({
  ok: true,
  generatedAt,
  stances: [{ asset: 'eth', enabled: true, position: 'holding', regime, regimeConfidence: 0.8 }],
});
const fetchMock = vi.fn();

beforeEach(() => {
  clearTrendStanceCache();
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchMock);
  Object.assign(env, {
    IAMROSSI_STANCE_URL: 'https://iamrossi.example',
    IAMROSSI_STANCE_TOKEN: 'x'.repeat(32),
    IAMROSSI_STANCE_REDIS_URL: 'rediss://hl-stance:pw@redis.example:11301',
  });
  redisConnect.mockResolvedValue(undefined);
  fetchMock.mockResolvedValue(new Response(JSON.stringify(body(NOW - 60_000, 'neutral'))));
});

describe('fetchTrendStance', () => {
  it('reads the cache key from Redis and makes no HTTP call', async () => {
    redisGet.mockResolvedValue(JSON.stringify(body(NOW - 60_000)));
    const snap = await fetchTrendStance(NOW);
    expect(redisGet).toHaveBeenCalledWith(STANCE_REDIS_KEY);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(snap?.stances[0].regime).toBe('bullish');
  });

  it('falls back to HTTP on a Redis miss', async () => {
    redisGet.mockResolvedValue(null);
    const snap = await fetchTrendStance(NOW);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(snap?.stances[0].regime).toBe('neutral');
  });

  it('falls back to HTTP when Redis fails to connect', async () => {
    redisConnect.mockRejectedValue(new Error('ECONNREFUSED'));
    expect((await fetchTrendStance(NOW))?.stances[0].regime).toBe('neutral');
  });

  it('falls back to HTTP when the Redis body is older than the 9h gate', async () => {
    redisGet.mockResolvedValue(JSON.stringify(body(NOW - 10 * 3_600_000)));
    expect((await fetchTrendStance(NOW))?.stances[0].regime).toBe('neutral');
  });

  it('ignores a plain-text redis:// URL and uses HTTP', async () => {
    env.IAMROSSI_STANCE_REDIS_URL = 'redis://hl-stance:pw@redis.example:11301';
    redisGet.mockResolvedValue(JSON.stringify(body(NOW - 60_000)));
    expect((await fetchTrendStance(NOW))?.stances[0].regime).toBe('neutral');
    expect(redisGet).not.toHaveBeenCalled();
  });

  it('uses HTTP only when no Redis URL is set', async () => {
    env.IAMROSSI_STANCE_REDIS_URL = undefined;
    await fetchTrendStance(NOW);
    expect(redisGet).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('returns null when both paths fail (callers treat null as unknown)', async () => {
    redisGet.mockResolvedValue(null);
    fetchMock.mockResolvedValue(new Response('nope', { status: 500 }));
    expect(await fetchTrendStance(NOW)).toBeNull();
  });
});
