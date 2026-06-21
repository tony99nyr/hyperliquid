'use client';

/**
 * CockpitClient — the HL Cockpit shell (design handoff).
 *
 * A full-viewport terminal: a 52px TOP BAR (brand + Cockpit/Performance nav +
 * Equity/Today/mode/feed) → the active VIEW (Cockpit three-column grid OR the
 * Performance KPI/equity/ledger) → a 34px BOTTOM STATUS BAR. Three overlays
 * (trader drawer, approval modal, exit modal) float above everything.
 *
 * Receives server-fetched initial state (mode, session, leader positions, top
 * traders) from the RSC page and opens the realtime transports inside each
 * island. The page holds no socket; the islands subscribe.
 *
 * HARDENED WIRING PRESERVED (do not regress): the ApprovalPopup is the only entry
 * gate (no-auto-fire — leverage slider + Match-leader + server-validation +
 * liquidation-inside-stop gate + LIVE typed-phrase), SafeExitButton / the
 * Open-Positions Safe-Exit ALL strip ride the reduce-only /api/cockpit/safe-exit
 * dead-man's-switch route, and the paper↔live seam is untouched. Wave-2 features
 * (leverage, Match-leader, Leader-vs-You, clickable trader detail, adaptive
 * Market-Read/Trade-Health) all survive inside the design's structure.
 */

import { useState } from 'react';
import { css } from '@styled-system/css';
import type { TradingMode } from '@/types/fill';
import type { Session } from '@/types/cockpit';
import type { HlPosition } from '@/lib/hyperliquid/hyperliquid-info-service';
import type { TopTraderRow } from '@/lib/hyperliquid/top-traders-service';
import { useActiveSession } from '@/hooks/useActiveSession';
import { useActiveTrade } from '@/hooks/useActiveTrade';
import { useLeaderPositions } from '@/hooks/useLeaderPositions';
import { useLeaderPositionsScoped } from '@/hooks/useLeaderPositionsTable';
import { leaderPositionRowsToHlPositions } from '@/hooks/leader-position-adapt';
import { usePerformance } from '@/hooks/usePerformance';
import { useRealtimeChannel } from '@/hooks/useRealtimeChannel';
import { useIsMobile } from '@/hooks/useIsMobile';
import { mapAnalysisLogRow, byCreatedAtDesc } from '@/hooks/realtime-row-mappers';
import TopBar, { type CockpitView as ViewKey } from './components/shell/TopBar';
import BottomStatusBar from './components/shell/BottomStatusBar';
import BottomTabBar, { type MobileTab } from './components/shell/BottomTabBar';
import CockpitView from './components/CockpitView';
import PerformanceView from './components/performance/PerformanceView';
import TopTradersRail from './components/left-rail/TopTradersRail';
import type { RatingsFreshness } from './components/left-rail/ratings-freshness-helpers';
import ApprovalPopup from './components/ApprovalPopup';

export interface CockpitClientProps {
  mode: TradingMode;
  session: Session | null;
  leaderAddress: string | null;
  leaderPositions: HlPosition[];
  /** Top rated traders, pre-sliced server-side for the left rail. */
  topTraders?: TopTraderRow[];
  /** Rail ratings freshness (built server-side: generatedAt + stale). */
  ratings?: RatingsFreshness | null;
  /** Coins the operator can switch between. Default ETH/BTC/HYPE. */
  coins?: string[];
}

export default function CockpitClient({
  mode,
  session: serverSession,
  leaderAddress,
  leaderPositions,
  topTraders = [],
  ratings = null,
  coins = ['ETH', 'BTC', 'HYPE', 'SOL'],
}: CockpitClientProps) {
  const isMobile = useIsMobile();
  // Desktop: 2-view segmented nav (Cockpit / Performance) — Traders is the
  // cockpit grid's left rail. Mobile: 3-tab bottom bar (Cockpit / Traders /
  // Performance) — Traders is its own surface. The two switches stay in sync so
  // rotating the device preserves intent (e.g. Performance stays Performance).
  const [view, setView] = useState<ViewKey>('cockpit');
  const [mobileTab, setMobileTab] = useState<MobileTab>('cockpit');
  const [coin, setCoin] = useState(coins[0] ?? 'ETH');

  // Desktop nav → keep the mobile tab aligned (Traders has no desktop nav slot).
  const onViewChange = (v: ViewKey) => {
    setView(v);
    setMobileTab(v);
  };
  // Mobile tab ↔ desktop view are now the same 3 keys (Cockpit/Traders/Performance).
  const onMobileTabChange = (t: MobileTab) => {
    setMobileTab(t);
    setView(t);
  };

  // The single surface to render: on mobile the bottom tab wins; on desktop the
  // segmented nav wins. Computed so each island stack mounts EXACTLY once (no
  // double realtime subscriptions from a hidden-but-mounted duplicate).
  const surface: MobileTab = isMobile ? mobileTab : view;

  // Auto-bind the latest active session (server seed → poll) so a session opened
  // MID-FLOW surfaces its popup + Safe-Exit without a refresh.
  const session = useActiveSession(serverSession);
  const sessionId = session?.id ?? null;
  const trade = useActiveTrade(sessionId, coin);

  // Resolve the followed leader's positions ONCE here for every consumer
  // (Leader-vs-You + the ApprovalPopup's Match-leader leverage). Prefer the
  // trade-watch LIVE book (Supabase) when the watcher covers this leader, and
  // gate the HL short-poll OFF in that case (null address → the poller is inert)
  // — so a watched leader costs ZERO HL calls. Falls back to the HL poll (seeded
  // by the RSC fetch) when the leader isn't watched.
  const sbLeader = useLeaderPositionsScoped(leaderAddress);
  const leaderWatched = sbLeader.loaded && sbLeader.rows.length > 0;
  // Poll HL ONLY once Supabase has resolved AND the leader isn't watched — so a
  // watched leader fires ZERO HL polls (not even an initial race poll before
  // Supabase loads). During the brief load gap the RSC seed covers the panel.
  const hlPollAddress = sbLeader.loaded && !leaderWatched ? leaderAddress : null;
  const hlLeader = useLeaderPositions(hlPollAddress, leaderPositions);
  const resolvedLeaderPositions = leaderWatched
    ? leaderPositionRowsToHlPositions(sbLeader.rows)
    : hlLeader.positions;

  // Account equity / today's realized PnL for the top bar + exit-modal math
  // (derived server-side from the fills ledger; inert without a session).
  const perf = usePerformance(sessionId);
  const equityUsd = perf.summary?.equityUsd ?? null;
  const todayUsd = perf.summary?.kpis.todayPnlUsd ?? null;

  // Feed-live indicator: a representative Supabase realtime channel's subscribe
  // state (mirrors RealtimeStatus). Inert without a session.
  const rt = useRealtimeChannel({ table: 'analysis_log', sessionId, map: mapAnalysisLogRow, compare: byCreatedAtDesc, limit: 1 });
  const feedLive = sessionId === null ? false : rt.subscribed && rt.error === null;

  return (
    <div
      className={css({
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        overflow: { base: 'auto', lg: 'hidden' },
        bg: 'cockpit.void',
        color: 'github.textBright',
      })}
    >
      <TopBar
        view={view}
        onViewChange={onViewChange}
        mode={mode}
        equityUsd={equityUsd}
        todayUsd={todayUsd}
        feedLive={feedLive}
      />

      {surface === 'performance' ? (
        <PerformanceView sessionId={sessionId} />
      ) : surface === 'traders' ? (
        // Traders surface (desktop nav + mobile tab) — the Top Traders rail, now a
        // dedicated tab instead of the cockpit's left rail. Centered column so it
        // reads intentionally full-screen rather than stretched.
        <section
          data-testid="traders-view"
          className={css({ flex: 1, overflowY: 'auto', padding: '12px' })}
        >
          <div className={css({ maxWidth: '760px', marginX: 'auto' })}>
            <TopTradersRail traders={topTraders} followedAddress={leaderAddress} ratings={ratings} />
          </div>
        </section>
      ) : (
        <CockpitView
          sessionId={sessionId}
          hasSession={session !== null}
          mode={mode}
          coin={coin}
          coins={coins}
          onCoinChange={setCoin}
          trade={trade}
          leaderAddress={leaderAddress}
          leaderPositions={resolvedLeaderPositions}
          currentEquityUsd={equityUsd ?? 0}
        />
      )}

      <BottomTabBar tab={mobileTab} onTabChange={onMobileTabChange} />

      <BottomStatusBar connected={feedLive} leaderAddress={leaderAddress} mode={mode} latencyMs={null} />

      {/* The approval popup overlays everything when a pending action appears.
          NO-AUTO-FIRE: nothing executes until the human approves here. Leader
          data feeds the Match-leader leverage preset (wave-2). */}
      <ApprovalPopup sessionId={sessionId} leaderAddress={leaderAddress} leaderPositions={resolvedLeaderPositions} />
    </div>
  );
}
