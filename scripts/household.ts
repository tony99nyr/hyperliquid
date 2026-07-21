/**
 * pnpm household — print iamrossi's on-chain household crypto exposure (read-only).
 * Awareness + sizing input; NEVER trades. See src/lib/household/**.
 */
import { readFileSync } from 'node:fs';
import { header, line, run } from './_skill-runtime';
import { readHouseholdExposure } from '@/lib/household/household-exposure-service';
import { fetchAllMids } from '@/lib/hyperliquid/hyperliquid-info-service';
function loadEnv(){let r='';try{r=readFileSync('.env.local','utf8')}catch{return}for(const l of r.split('\n')){const m=l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);if(!m)continue;let v=m[2];if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);if(!process.env[m[1]])process.env[m[1]]=v}}
run(async () => {
  loadEnv();
  header('HOUSEHOLD EXPOSURE (iamrossi on-chain Base Safes — READ-ONLY)');
  const mids = await fetchAllMids().catch(() => ({} as Record<string, string>));
  const ex = await readHouseholdExposure({ ethUsd: Number(mids.ETH), btcUsd: Number(mids.BTC) });
  if (!ex) { line('unconfigured or unreadable (set IAMROSSI_SAFE_ETH / IAMROSSI_SAFE_BTC).'); return; }
  line(`ETH long delta:  $${ex.ethExposureUsd.toFixed(0)}  (weETH collateral)`);
  line(`BTC long delta:  $${ex.btcExposureUsd.toFixed(0)}`);
  line(`stables:         $${ex.stablesUsd.toFixed(0)}`);
  line(`NET crypto beta: $${ex.netCryptoBetaUsd.toFixed(0)}  (dominant: ${ex.dominant})`);
  line('');
  line('Awareness + sizing only. Cockpit risk-on trades STACK on this; a cockpit');
  line('short of a household-long coin partially hedges. NEVER auto-hedged.');
});
