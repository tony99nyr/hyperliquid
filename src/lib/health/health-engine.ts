/**
 * Health engine (I/O). Loads the versioned weights, fetches the four
 * timeframes via the candle-service, calls the PURE composer, and optionally
 * persists the result via the health-snapshot-service.
 *
 * The pure work lives in health-engine-business-logic.ts; this file is the thin
 * I/O shell (candle fetch + config load + optional DB write).
 */

import { join } from 'node:path';
import { loadActiveConfig } from '@/lib/config/config-manifest-loader';
import { fetchMultiTimeframeCandles } from '@/lib/hyperliquid/candle-service';
import { writeHealthSnapshot } from '@/lib/cockpit/health-snapshot-service';
import { computeHealth } from './health-engine-business-logic';
import type {
  HealthPositionContext,
  HealthResult,
  HealthTimeframe,
  HealthWeights,
  MultiTimeframeCandles,
} from './health-engine-types';

const HEALTH_CONFIG_DIR = join(process.cwd(), 'data', 'health-engine');
const TIMEFRAMES: HealthTimeframe[] = ['1d', '8h', '1h', '15m'];

/**
 * How far back to fetch per timeframe (enough candles for regime + indicators).
 * Exported so the watch daemon can fetch its 15m mark over the IDENTICAL window
 * and share the candle-service cache entry (one HL round-trip, not two).
 */
export const HEALTH_LOOKBACK_MS: Record<HealthTimeframe, number> = {
  '1d': 400 * 24 * 60 * 60 * 1000, // ~400 days
  '8h': 400 * 8 * 60 * 60 * 1000, // ~133 days
  '1h': 400 * 60 * 60 * 1000, // ~16 days
  '15m': 400 * 15 * 60 * 1000, // ~4 days
};

const LOOKBACK_MS = HEALTH_LOOKBACK_MS;

let cachedWeights: HealthWeights | null = null;

/** Load (and cache) the active health weights from the versioned manifest. */
export function loadHealthWeights(): HealthWeights {
  if (cachedWeights) return cachedWeights;
  cachedWeights = loadActiveConfig<HealthWeights>(HEALTH_CONFIG_DIR);
  return cachedWeights;
}

/** Reset the cached weights (test hook). */
export function _resetHealthWeights(): void {
  cachedWeights = null;
}

/**
 * Fetch the four timeframes for a coin and run the health composer. Fails soft
 * per timeframe (candle-service returns empty/stale on error; the composer
 * weights those out).
 */
export async function assessHealth(
  coin: string,
  position: HealthPositionContext,
  now: number = Date.now(),
): Promise<HealthResult> {
  const weights = loadHealthWeights();

  const candles: MultiTimeframeCandles = {};
  const results = await Promise.all(
    TIMEFRAMES.map((tf) =>
      fetchMultiTimeframeCandles(coin, [tf], now - LOOKBACK_MS[tf], now).then((r) => ({
        tf,
        candles: r[tf]?.candles ?? [],
      })),
    ),
  );
  for (const { tf, candles: c } of results) candles[tf] = c;

  return computeHealth(candles, position, weights);
}

/**
 * Assess health and persist the snapshot to the session's health_snapshots row.
 * Returns the computed result.
 */
export async function assessAndPersistHealth(
  sessionId: string,
  coin: string,
  position: HealthPositionContext,
  now: number = Date.now(),
): Promise<HealthResult> {
  const result = await assessHealth(coin, position, now);
  await writeHealthSnapshot({
    sessionId,
    score: result.score,
    pContinuation: result.pContinuation,
    pAdverse: result.pAdverse,
    alerts: result.alerts,
  });
  return result;
}
