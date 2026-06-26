/**
 * Vault-watch service (I/O) — the ingester for scout Lane A (vault allocation).
 *
 * Each cycle it fetches HL `vaultDetails` for the watched vaults (HLP first),
 * runs the PURE parser, and appends a `vault_snapshots` row. NEVER trades — it is
 * a read-only NAV recorder, the vault analogue of trader-watch. Fail-soft per
 * vault so one bad fetch doesn't sink the cycle. See SCOUT_ALPHA_ROADMAP.md.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { getServiceRoleClient } from '@/lib/cockpit/supabase-server';
import { fetchVaultDetails, HLP_VAULT_ADDRESS } from '@/lib/hyperliquid/hyperliquid-info-service';
import { parseVaultSnapshot, buildVaultSnapshotRow, type VaultSnapshot } from './vault-snapshot-business-logic';

export interface VaultWatchTarget {
  address: string;
  kind: 'hlp' | 'operator';
}

/** Default watch set: HLP only (the anchor; no leader-key risk). Operator vaults added later. */
export const DEFAULT_VAULT_TARGETS: VaultWatchTarget[] = [{ address: HLP_VAULT_ADDRESS, kind: 'hlp' }];

export interface VaultWatchCycleResult {
  written: number;
  failures: number;
  snapshots: VaultSnapshot[];
}

/**
 * One cycle: per target, fetch → parse → insert a snapshot. Fail-soft per target
 * (a transport/DB error increments `failures` and moves on). Returns what was
 * written so the daemon can log + heartbeat.
 */
export async function runVaultWatchCycle(args: {
  targets?: VaultWatchTarget[];
  now: number;
  network?: 'mainnet' | 'testnet';
  client?: SupabaseClient;
}): Promise<VaultWatchCycleResult> {
  const targets = args.targets ?? DEFAULT_VAULT_TARGETS;
  const client = args.client ?? getServiceRoleClient();
  let written = 0;
  let failures = 0;
  const snapshots: VaultSnapshot[] = [];

  for (const t of targets) {
    try {
      const raw = await fetchVaultDetails(t.address, args.network);
      const snap = parseVaultSnapshot(raw, { now: args.now, kind: t.kind, fallbackAddress: t.address });
      const { error } = await client.from('vault_snapshots').insert(buildVaultSnapshotRow(snap));
      if (error) throw new Error(error.message);
      snapshots.push(snap);
      written++;
    } catch {
      failures++;
    }
  }

  return { written, failures, snapshots };
}
