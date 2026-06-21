/**
 * Rubric config access. loadRubricConfig() is the only I/O (reads the versioned
 * manifest via loadActiveConfig, cached). resolveCoinConfig() is PURE (deep-merges
 * a perCoin override over the base) and is fixture-tested.
 */

import { join } from 'node:path';
import { loadActiveConfig } from '@/lib/config/config-manifest-loader';
import type { DeepPartial, RubricConfig } from './rubric-config-types';

const RUBRIC_DIR = join(process.cwd(), 'data', 'rubric');

let cached: RubricConfig | null = null;

/** Load (and cache) the active rubric config from data/rubric/. */
export function loadRubricConfig(): RubricConfig {
  if (!cached) cached = loadActiveConfig<RubricConfig>(RUBRIC_DIR);
  return cached;
}

/** Test seam: clear the memoized config. */
export function resetRubricConfigCache(): void {
  cached = null;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Recursive deep-merge of a partial override over a base (PURE; arrays replace). */
export function deepMerge<T>(base: T, override: DeepPartial<T>): T {
  if (!isPlainObject(base) || !isPlainObject(override)) return (override as T) ?? base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(override as Record<string, unknown>)) {
    if (v === undefined) continue;
    const bv = (base as Record<string, unknown>)[k];
    out[k] = isPlainObject(bv) && isPlainObject(v) ? deepMerge(bv, v as DeepPartial<typeof bv>) : v;
  }
  return out as T;
}

/** Resolve the effective config for a coin (perCoin override deep-merged over base). PURE. */
export function resolveCoinConfig(cfg: RubricConfig, coin: string): RubricConfig {
  const override = cfg.perCoin?.[coin.toUpperCase()];
  return override ? deepMerge(cfg, override) : cfg;
}
