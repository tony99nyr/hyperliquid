/**
 * Auto-exit config + env access (I/O side; the pure consumers take the loaded
 * config as a parameter). Thresholds come from the versioned manifest in
 * data/auto-exit/; the kill-switch + cron secret + account address come from env.
 */

import { join } from 'node:path';
import { loadActiveConfig } from '@/lib/config/config-manifest-loader';
import { validateEnv } from '@/lib/env/env';
import type { AutoExitConfig } from './risk-inputs-business-logic';

const AUTO_EXIT_DIR = join(process.cwd(), 'data', 'auto-exit');

let cached: AutoExitConfig | null = null;

/** Conservative fallbacks if a field is missing from the active config file. */
function normalize(raw: Partial<AutoExitConfig>): AutoExitConfig {
  return {
    liqProximityPct: typeof raw.liqProximityPct === 'number' ? raw.liqProximityPct : 0.03,
    maxLossUsd: raw.maxLossUsd ?? null,
    maxLossPctOfMargin: raw.maxLossPctOfMargin ?? null,
    minHealthScore: raw.minHealthScore ?? null,
    hardExitAlerts: Array.isArray(raw.hardExitAlerts) ? raw.hardExitAlerts : [],
    lockTtlMs: typeof raw.lockTtlMs === 'number' ? raw.lockTtlMs : 120_000,
  };
}

/** Load (and cache) the active auto-exit thresholds from the manifest. */
export function loadAutoExitConfig(): AutoExitConfig {
  if (!cached) cached = normalize(loadActiveConfig<Partial<AutoExitConfig>>(AUTO_EXIT_DIR));
  return cached;
}

/** Test seam: clear the memoized config. */
export function resetAutoExitConfigCache(): void {
  cached = null;
}

/** Master kill-switch — auto-exit does nothing (endpoint refuses) unless true. */
export function isAutoExitEnabled(): boolean {
  return validateEnv().AUTO_EXIT_ENABLED;
}

/**
 * Dedicated bearer token the detector/cron presents to /api/cockpit/risk-exit.
 * Falls back to Vercel's native CRON_SECRET so setting only that (the Vercel
 * convention) still authenticates the backup cron rather than silently 401-ing.
 */
export function getAutoExitCronSecret(): string | undefined {
  const env = validateEnv();
  return env.AUTO_EXIT_CRON_SECRET ?? env.CRON_SECRET;
}

/** Master account address (public) for clearinghouse reads; undefined disables liq/margin triggers. */
export function getHlAccountAddress(): string | undefined {
  return validateEnv().HL_ACCOUNT_ADDRESS;
}
