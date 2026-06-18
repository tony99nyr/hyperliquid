/**
 * Step 7 — Vault overlap: which persistent accounts run (lead) vaults,
 * and which studied addresses ARE vaults.
 * Note: the live `{"type":"vaultSummaries"}` info request returned [] when probed
 * (2026-06-12); using stats-data.hyperliquid.xyz/Mainnet/vaults instead.
 */
import { fetchUrl, readCache, writeCache } from './lib';

interface VaultRecord {
  apr: number;
  summary: {
    name: string;
    vaultAddress: string;
    leader: string;
    tvl: string;
    isClosed: boolean;
    relationship: { type: string };
    createTimeMillis: number;
  };
}

async function main(): Promise<void> {
  let vaults = readCache<VaultRecord[]>('vaults.json');
  if (!vaults) {
    console.log('Fetching vaults...');
    vaults = (await fetchUrl('https://stats-data.hyperliquid.xyz/Mainnet/vaults')) as VaultRecord[];
    writeCache('vaults.json', vaults);
  }
  console.log(`Vaults: ${vaults.length}`);

  const byLeader = new Map<string, VaultRecord[]>();
  const byVaultAddr = new Map<string, VaultRecord>();
  for (const v of vaults) {
    const leader = v.summary.leader.toLowerCase();
    if (!byLeader.has(leader)) byLeader.set(leader, []);
    byLeader.get(leader)!.push(v);
    byVaultAddr.set(v.summary.vaultAddress.toLowerCase(), v);
  }

  const persistent = readCache<{ diagnostics: Array<{ address: string; topDecileCount: number }> }>('persistent-set.json');
  if (!persistent) throw new Error('Run 05 first');

  const overlap = persistent.diagnostics.map((p) => {
    const leads = (byLeader.get(p.address) ?? []).map((v) => ({
      name: v.summary.name,
      vaultAddress: v.summary.vaultAddress,
      tvl: parseFloat(v.summary.tvl),
      isClosed: v.summary.isClosed,
      apr: v.apr,
    }));
    const isVault = byVaultAddr.get(p.address);
    return {
      address: p.address,
      addressShort: p.address.slice(0, 8),
      topDecileCount: p.topDecileCount,
      leadsVaults: leads,
      isVaultItself: isVault ? { name: isVault.summary.name, leader: isVault.summary.leader, tvl: parseFloat(isVault.summary.tvl), isClosed: isVault.summary.isClosed } : null,
    };
  });

  writeCache('vault-overlap.json', overlap);

  const leaders = overlap.filter((o) => o.leadsVaults.length > 0);
  const areVaults = overlap.filter((o) => o.isVaultItself);
  console.log(`Persistent accounts that lead vaults: ${leaders.length}/${overlap.length}`);
  for (const l of leaders) {
    for (const v of l.leadsVaults) {
      console.log(`  ${l.addressShort} leads "${v.name}" tvl=$${(v.tvl / 1e6).toFixed(2)}M closed=${v.isClosed} apr=${(v.apr * 100).toFixed(1)}%`);
    }
  }
  console.log(`Persistent accounts that ARE vaults: ${areVaults.length}`);
  for (const v of areVaults) {
    console.log(`  ${v.addressShort} = "${v.isVaultItself!.name}" tvl=$${(v.isVaultItself!.tvl / 1e6).toFixed(2)}M closed=${v.isVaultItself!.isClosed}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
