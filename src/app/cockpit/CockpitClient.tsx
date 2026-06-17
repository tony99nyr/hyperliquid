'use client';

/**
 * CockpitClient — the live cockpit, modeled on HL's chart-centric trade screen
 * and enhanced with our edge. Receives server-fetched initial state (mode,
 * session, leader positions, top traders) from the RSC page and opens the two
 * realtime transports:
 *   - HL websocket (market data + candles poll) via the chart + orderbook islands.
 *   - Supabase realtime (cockpit state) via the per-table hooks inside each island.
 *
 * Layout (desktop): a prominent TOP TRADE ZONE co-locates the two in-trade
 * essentials side-by-side — the dense Active-Position row + Trade Health — so the
 * operator reads "my trade + its health" in one glance (Item 1), with the
 * Leader-vs-You comparison directly beside them when following. Below that, the
 * chart-centric desk: LEFT rail = Top Traders · CENTER = the live candlestick
 * chart (the star) + secondary tabs · RIGHT rail = orderbook + (sticky)
 * Safe-Exit. On mobile everything stacks with the trade zone + chart prominent
 * near the top. The page holds no socket; the islands subscribe. NO-AUTO-FIRE:
 * ApprovalPopup + SafeExitButton unchanged.
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
import Banners from './components/Banners';
import RealtimeStatus from './components/RealtimeStatus';
import ApprovalPopup from './components/ApprovalPopup';
import SafeExitButton from './components/SafeExitButton';
import Orderbook from './components/Orderbook';
import HealthPanel from './components/HealthPanel';
import LeaderVsYou from './components/LeaderVsYou';
import GettingStarted from './components/GettingStarted';
import SecondaryStrip from './components/SecondaryStrip';
import CandleChartPanel from './components/chart/CandleChartPanel';
import TopTradersRail from './components/left-rail/TopTradersRail';
import ActivePositionBar from './components/bottom-bar/ActivePositionBar';

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
  const [coin, setCoin] = useState(coins[0] ?? 'ETH');
  // Auto-bind the latest active session (seeded from the server render, then
  // polled) so a session opened MID-FLOW surfaces its popup + Safe-Exit.
  const session = useActiveSession(serverSession);
  const sessionId = session?.id ?? null;
  const trade = useActiveTrade(sessionId, coin);
  // Keep the leader's positions LIVE (server seed → short poll) for the
  // Leader-vs-You panel + the Match-leader leverage preset in the popup (Item 4).
  const liveLeader = useLeaderPositions(leaderAddress, leaderPositions);

  return (
    <main
      className={css({
        minHeight: '100vh',
        bg: 'github.bg',
        padding: { base: '10px', md: '14px' },
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
        maxWidth: '1680px',
        margin: '0 auto',
      })}
    >
      <header
        className={css({
          display: 'flex',
          flexDirection: 'column',
          gap: '8px',
          position: 'sticky',
          top: 0,
          zIndex: 10,
          bg: 'github.bg',
          paddingY: '6px',
        })}
      >
        <div className={css({ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px' })}>
          <h1 className={css({ fontFamily: 'label', fontSize: 'lg', fontWeight: 'bold', color: 'github.textBright', letterSpacing: '0.04em', textTransform: 'uppercase' })}>
            HL Cockpit
            {session?.title && (
              <span className={css({ fontFamily: 'mono', fontSize: 'xs', color: 'github.textMuted', fontWeight: 'normal', marginLeft: '10px', textTransform: 'none', letterSpacing: '0' })}>
                {session.title}
              </span>
            )}
          </h1>
          <div className={css({ display: 'flex', gap: '8px', alignItems: 'center' })}>
            <CoinSelector value={coin} options={coins} onChange={setCoin} />
            <RealtimeStatus sessionId={sessionId} />
          </div>
        </div>
        <Banners mode={mode} />
      </header>

      {/* Cold start: teach the Claude-driven paper flow; chart + context stay live. */}
      {!session && <GettingStarted />}

      {/* TOP TRADE ZONE (Item 1) — the two in-trade essentials co-located,
          prominent: the dense Position row + Trade Health side-by-side on desktop,
          stacked-adjacent on mobile. Leader-vs-You sits directly beside them when
          following (it only renders with a leader + an open position on the coin).
          One glance for "my trade + its health". */}
      <div
        className={css({
          display: 'grid',
          gridTemplateColumns: { base: '1fr', md: 'minmax(0, 1fr) 320px' },
          gap: '12px',
          alignItems: 'start',
        })}
      >
        <div className={css({ display: 'flex', flexDirection: 'column', gap: '12px', minWidth: '0' })}>
          <ActivePositionBar sessionId={sessionId} leaderAddress={leaderAddress} leaderPositions={liveLeader.positions} />
          <LeaderVsYou sessionId={sessionId} coin={coin} leaderAddress={leaderAddress} leaderPositions={liveLeader.positions} />
        </div>
        <div className={css({ minWidth: '0' })}>
          <HealthPanel sessionId={sessionId} coin={coin} />
        </div>
      </div>

      {/* CHART-CENTRIC DESK: traders | chart (the star) | orderbook + Safe-Exit. */}
      <div
        className={css({
          display: 'grid',
          gridTemplateColumns: { base: '1fr', lg: '240px minmax(0, 1fr) 320px' },
          gap: '12px',
          alignItems: 'start',
        })}
      >
        {/* LEFT — Top Traders (our unique rail). On mobile it drops below the chart. */}
        <div className={css({ order: { base: 3, lg: 0 }, minWidth: '0' })}>
          <TopTradersRail traders={topTraders} followedAddress={leaderAddress} />
        </div>

        {/* CENTER — the star: live candlestick chart. */}
        <div className={css({ order: { base: 1, lg: 0 }, display: 'flex', flexDirection: 'column', gap: '12px', minWidth: '0' })}>
          <CandleChartPanel coin={coin} trade={trade} />
          <SecondaryStrip sessionId={sessionId} />
        </div>

        {/* RIGHT — compact orderbook + sticky Safe-Exit. */}
        <div className={css({ order: { base: 2, lg: 0 }, display: 'flex', flexDirection: 'column', gap: '12px', minWidth: '0' })}>
          <Orderbook coin={coin} depth={8} />
          <SafeExitButton sessionId={sessionId} />
        </div>
      </div>

      {/* The animated approval popup overlays everything when a pending action
          appears. NO-AUTO-FIRE: nothing executes until the human approves here.
          Leader data feeds the Match-leader leverage preset (Item 3). */}
      <ApprovalPopup sessionId={sessionId} leaderAddress={leaderAddress} leaderPositions={liveLeader.positions} />
    </main>
  );
}

function CoinSelector({
  value,
  options,
  onChange,
}: {
  value: string;
  options: string[];
  onChange: (v: string) => void;
}) {
  return (
    <select
      data-testid="coin-selector"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={css({
        bg: 'github.bgSecondary',
        border: '1px solid token(colors.github.border)',
        borderRadius: '6px',
        color: 'github.textBright',
        fontSize: 'sm',
        fontFamily: 'mono',
        fontWeight: 'bold',
        padding: '5px 9px',
        cursor: 'pointer',
      })}
    >
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  );
}
