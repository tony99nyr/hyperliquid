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
import { usePerformance } from '@/hooks/usePerformance';
import { useRealtimeChannel } from '@/hooks/useRealtimeChannel';
import { mapAnalysisLogRow, byCreatedAtDesc } from '@/hooks/realtime-row-mappers';
import TopBar, { type CockpitView as ViewKey } from './components/shell/TopBar';
import BottomStatusBar from './components/shell/BottomStatusBar';
import CockpitView from './components/CockpitView';
import PerformanceView from './components/performance/PerformanceView';
import ApprovalPopup from './components/ApprovalPopup';
import Banners from './components/Banners';

export interface CockpitClientProps {
  mode: TradingMode;
  session: Session | null;
  leaderAddress: string | null;
  leaderPositions: HlPosition[];
  /** Top rated traders, pre-sliced server-side for the left rail. */
  topTraders?: TopTraderRow[];
  /** Coins the operator can switch between. Default ETH/BTC. */
  coins?: string[];
}

export default function CockpitClient({
  mode,
  session: serverSession,
  leaderAddress,
  leaderPositions,
  topTraders = [],
  coins = ['ETH', 'BTC'],
}: CockpitClientProps) {
  const [view, setView] = useState<ViewKey>('cockpit');
  const [coin, setCoin] = useState(coins[0] ?? 'ETH');

  // Auto-bind the latest active session (server seed → poll) so a session opened
  // MID-FLOW surfaces its popup + Safe-Exit without a refresh.
  const session = useActiveSession(serverSession);
  const sessionId = session?.id ?? null;
  const trade = useActiveTrade(sessionId, coin);

  // Keep the leader's positions LIVE for Leader-vs-You + Match-leader leverage.
  const liveLeader = useLeaderPositions(leaderAddress, leaderPositions);

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
        onViewChange={setView}
        mode={mode}
        equityUsd={equityUsd}
        todayUsd={todayUsd}
        feedLive={feedLive}
      />

      {/* Read-only / mode banner sits just under the bar (loud + persistent). */}
      <div className={css({ paddingX: '12px', paddingTop: '8px' })}>
        <Banners mode={mode} />
      </div>

      {view === 'cockpit' ? (
        <CockpitView
          sessionId={sessionId}
          hasSession={session !== null}
          coin={coin}
          coins={coins}
          onCoinChange={setCoin}
          trade={trade}
          leaderAddress={leaderAddress}
          leaderPositions={liveLeader.positions}
          topTraders={topTraders}
          currentEquityUsd={equityUsd ?? 0}
        />
      ) : (
        <PerformanceView sessionId={sessionId} />
      )}

      <BottomStatusBar connected={feedLive} leaderAddress={leaderAddress} mode={mode} latencyMs={null} />

      {/* The approval popup overlays everything when a pending action appears.
          NO-AUTO-FIRE: nothing executes until the human approves here. Leader
          data feeds the Match-leader leverage preset (wave-2). */}
      <ApprovalPopup sessionId={sessionId} leaderAddress={leaderAddress} leaderPositions={liveLeader.positions} />
    </div>
  );
}
