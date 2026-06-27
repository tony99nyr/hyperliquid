/**
 * pnpm vault-watch — the scout Lane A NAV ingester (read-only, never trades).
 *
 * Polls HL `vaultDetails` for the watched vaults (HLP by default) and appends a
 * `vault_snapshots` row each cycle.
 *
 * SCHEDULING: the NAS runs `pnpm vault-watch --once` inside `scripts/nas-watch.sh`
 * (the existing 5-min tick) — NO new cron. The loop mode below is only for an
 * ad-hoc standalone run; NAV moves slowly → hourly default.
 *
 *   pnpm vault-watch --once         # single cycle, exit  (what nas-watch.sh calls)
 *   pnpm vault-watch                # loop hourly, HLP only (standalone)
 *   pnpm vault-watch --interval 900 # every 15 min
 */

import { loadEnvLocal } from './_skill-runtime';
import { runVaultWatchCycle, DEFAULT_VAULT_TARGETS } from '@/lib/scout/vault-watch-service';

// Load .env.local (CWD-independent) so the Supabase service-role client configures
// under the NAS cron — the same bootstrap the run()-wrapped skills get. Without it
// getServiceRoleClient throws "Supabase service-role client not configured".
loadEnvLocal();

const DEFAULT_INTERVAL_SEC = 3600; // hourly
const MIN_INTERVAL_SEC = 60;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function cycle(): Promise<void> {
  const res = await runVaultWatchCycle({ now: Date.now() });
  const nav = res.snapshots.map((s) => `${s.name}: NAV $${s.navUsd?.toLocaleString('en-US', { maximumFractionDigits: 0 }) ?? '?'} apr ${s.aprAnnual != null ? (s.aprAnnual * 100).toFixed(1) + '%' : '?'} dd ${s.maxDrawdownPct != null ? (s.maxDrawdownPct * 100).toFixed(1) + '%' : '?'}`).join(' | ');
  console.log(`[vault-watch] wrote ${res.written}, failures ${res.failures}. ${nav}`);
}

async function main(): Promise<void> {
  const once = process.argv.includes('--once');
  const interval = Math.max(MIN_INTERVAL_SEC, Number(arg('interval')) || DEFAULT_INTERVAL_SEC);
  console.log(`[vault-watch] targets: ${DEFAULT_VAULT_TARGETS.map((t) => `${t.kind}:${t.address.slice(0, 8)}…`).join(', ')}`);

  if (once) {
    await cycle();
    return;
  }

  let running = true;
  const stop = () => {
    running = false;
    console.log('[vault-watch] shutting down after the current cycle…');
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  console.log(`[vault-watch] looping every ${interval}s (Ctrl-C to stop).`);
  while (running) {
    try {
      await cycle();
    } catch (e) {
      console.error(`[vault-watch] cycle error: ${e instanceof Error ? e.message : String(e)}`);
    }
    for (let waited = 0; running && waited < interval; waited++) await sleep(1000);
  }
}

main().catch((e) => {
  console.error('vault-watch fatal:', e instanceof Error ? e.message : e);
  process.exit(1);
});
