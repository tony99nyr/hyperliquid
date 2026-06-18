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
import {
  fetchClearinghouseState,
  type HlPosition,
} from '@/lib/hyperliquid/hyperliquid-info-service';
import { getRailTraders, getRatedMeta } from '@/lib/hyperliquid/top-traders-service';
import { buildRatingsFreshness } from './components/left-rail/ratings-freshness-helpers';
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

  let leaderPositions: HlPosition[] = [];
  if (leaderAddress) {
    const state = await fetchClearinghouseState(leaderAddress);
    leaderPositions = state.positions;
  }

  // Slim top-traders list for the left rail — a larger slice (50) so the rail
  // scrolls + filters client-side (the 2.8MB dataset stays server-side).
  const topTraders = getRailTraders(50);
  // Build the rail freshness server-side (page is force-dynamic → knows "now"),
  // so the client renders it purely (no Date.now()/effect → no hydration drift).
  const ratings = buildRatingsFreshness(getRatedMeta().generatedAt);

  return (
    <CockpitClient
      mode={mode}
      session={session}
      leaderAddress={leaderAddress}
      leaderPositions={leaderPositions}
      topTraders={topTraders}
      ratings={ratings}
      coins={['ETH', 'BTC', 'HYPE']}
    />
  );
}
