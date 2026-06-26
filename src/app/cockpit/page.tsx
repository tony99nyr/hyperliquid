/**
 * /cockpit — the live trading cockpit (RSC).
 *
 * Server responsibilities (per the RSC convention): admin-PIN auth gate, then
 * fetch the INITIAL low-frequency state (active session + leader positions) and
 * hand it to the CockpitClient, which opens the realtime transports. All
 * high-frequency / live data is subscribed client-side inside the islands — the
 * page never holds a socket.
 *
 * Fail-soft: if Supabase / HL are not yet configured the page still renders (no
 * session / no leader), so the route is viewable before the DB is provisioned.
 * Live functional data is gated on (a) the Supabase migration + (b) env keys.
 */

import { getTradingMode } from '@/lib/env/mode';
import { isAdminAuthenticated } from '@/lib/infrastructure/auth/server-auth';
import { getActiveSession } from '@/lib/cockpit/session-service';
import { reapStaleExecutingPreviews } from '@/lib/cockpit/pending-actions-service';
import {
  fetchClearinghouseState,
  type HlPosition,
} from '@/lib/hyperliquid/hyperliquid-info-service';
import { getRailTraders, getRatedMeta, rankRailTraders } from '@/lib/hyperliquid/top-traders-service';
import { loadRatedWalletsFromDb } from '@/lib/hyperliquid/rated-wallets-db-service';
import { buildRatingsFreshness } from './components/left-rail/ratings-freshness-helpers';
import { TRADEABLE_COINS } from './components/left-rail/top-traders-filter-helpers';
import PinGate from './components/PinGate';
import CockpitClient from './CockpitClient';

// Always render fresh — session + positions are live state, never cached.
export const dynamic = 'force-dynamic';

export default async function CockpitPage() {
  if (!(await isAdminAuthenticated())) {
    return <PinGate />;
  }

  const mode = getTradingMode();
  const session = await getActiveSession();
  const leaderAddress = session?.leaderAddress ?? null;

  // Opportunistically recover any preview stuck 'executing' from a prior
  // serverless death (rare) so it reappears in the popup. Fail-soft: a reap
  // error must never break the page (matches the route's fail-soft ethos).
  try {
    await reapStaleExecutingPreviews();
  } catch {
    // non-critical maintenance sweep
  }

  let leaderPositions: HlPosition[] = [];
  if (leaderAddress) {
    const state = await fetchClearinghouseState(leaderAddress);
    leaderPositions = state.positions;
  }

  // Slim top-traders list for the left rail — a larger slice (50) so the rail
  // scrolls + filters client-side (the 2.8MB dataset stays server-side).
  // Rankings come from Supabase (the weekly re-rank upserts them there → live,
  // no redeploy/pull), falling back to the committed JSON when the table is
  // empty/unconfigured. The trade-watch daemon keeps reading the local JSON.
  const dbDataset = await loadRatedWalletsFromDb();
  // Wider pool (150) so the sortable/filterable TradersTable can surface
  // high-quality-but-lower-composite names; the table's sort/filter + load-more
  // narrow it client-side (the 2.8MB dataset never reaches the client).
  const topTraders = dbDataset ? rankRailTraders(dbDataset.wallets, 150) : getRailTraders(150);
  const ratingsGeneratedAt = dbDataset ? dbDataset.generatedAt : getRatedMeta().generatedAt;
  // Build the rail freshness server-side (page is force-dynamic → knows "now"),
  // so the client renders it purely (no Date.now()/effect → no hydration drift).
  const ratings = buildRatingsFreshness(ratingsGeneratedAt);

  return (
    <CockpitClient
      mode={mode}
      session={session}
      leaderAddress={leaderAddress}
      leaderPositions={leaderPositions}
      topTraders={topTraders}
      ratings={ratings}
      coins={[...TRADEABLE_COINS]}
    />
  );
}
