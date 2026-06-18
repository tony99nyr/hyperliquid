/**
 * pnpm upsert-rated — push a rated-wallets.json into Supabase `rated_wallets`.
 *
 * Run AFTER the weekly re-rank produces rated-wallets.json. Reads the file and
 * upserts it under a fresh generation, then atomically flips the active
 * generation (see rated-wallets-db-service). The cockpit UI + Claude skills then
 * read the live rankings from Supabase — no `git pull`, no redeploy. The
 * trade-watch daemon keeps reading the LOCAL JSON (its hot loop stays network-free).
 *
 * Usage:
 *   pnpm upsert-rated                       # reads ./data/backups/wallet-rating/rated-wallets.json
 *   pnpm upsert-rated --file /abs/path.json # explicit path (e.g. the iamrossi pipeline output)
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { run, header, line, parseArgs } from './_skill-runtime';
import { upsertRatedWalletsToDb } from '@/lib/hyperliquid/rated-wallets-db-service';
import type { RatedWalletsDataset } from '@/lib/hyperliquid/rated-wallets-service';

run(async () => {
  const args = parseArgs(process.argv.slice(2));
  const file =
    (typeof args['file'] === 'string' && args['file']) ||
    resolve(process.cwd(), 'data/backups/wallet-rating/rated-wallets.json');

  header('upsert rated-wallets → Supabase');
  line(`reading ${file}`);

  let ds: RatedWalletsDataset;
  try {
    ds = JSON.parse(readFileSync(file, 'utf8')) as RatedWalletsDataset;
  } catch (err) {
    throw new Error(`cannot read/parse ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!Array.isArray(ds.wallets) || ds.wallets.length === 0) {
    // Fail loud — never flip the active generation to an empty set.
    throw new Error(`refusing to upsert: ${file} has no wallets`);
  }

  line(`upserting ${ds.wallets.length} wallets (generatedAt ${ds.generatedAt}) …`);
  const res = await upsertRatedWalletsToDb(ds);
  line(`✓ upserted ${res.count} wallets as generation ${res.generation}; active generation flipped.`);
});
