'use client';

/**
 * CockpitClient — the live cockpit, modeled on HL's chart-centric trade screen
 * and enhanced with our edge. Receives server-fetched initial state (mode,
 * session, leader positions, top traders) from the RSC page and opens the two
 * realtime transports:
 *   - HL websocket (market data + candles poll) via the chart + orderbook islands.
 *   - Supabase realtime (cockpit state) via the per-table hooks inside each island.
 *
 * Layout (desktop): LEFT rail = Top Traders · CENTER = the live candlestick chart
 * (the star) · RIGHT rail = Trade Health + orderbook + (sticky) Safe-Exit ·
 * BOTTOM bar = the dense Active-Position row. The supporting panels (Analysis /
 * Hypotheses / Context) tuck into a tabbed SecondaryStrip. On mobile everything
 * stacks with the chart staying prominent near the top. The page holds no socket;
 * the islands subscribe. NO-AUTO-FIRE: ApprovalPopup + SafeExitButton unchanged.
 */

import { useState } from 'react';
import { css } from '@styled-system/css';
import type { TradingMode } from '@/types/fill';
import type { Session } from '@/types/cockpit';
import type { HlPosition } from '@/lib/hyperliquid/hyperliquid-info-service';
import type { TopTraderRow } from '@/lib/hyperliquid/top-traders-service';
import { useActiveSession } from '@/hooks/useActiveSession';
import { useActiveTrade } from '@/hooks/useActiveTrade';
import Banners from './components/Banners';
import RealtimeStatus from './components/RealtimeStatus';
import ApprovalPopup from './components/ApprovalPopup';
import SafeExitButton from './components/SafeExitButton';
import Orderbook from './components/Orderbook';
import HealthPanel from './components/HealthPanel';
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

      {/* HL-style three-column desk: traders | chart | health+book. */}
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

        {/* RIGHT — Trade Health + compact orderbook + sticky Safe-Exit. */}
        <div className={css({ order: { base: 2, lg: 0 }, display: 'flex', flexDirection: 'column', gap: '12px', minWidth: '0' })}>
          <HealthPanel sessionId={sessionId} coin={coin} />
          <Orderbook coin={coin} depth={8} />
          <SafeExitButton sessionId={sessionId} />
        </div>
      </div>

      {/* BOTTOM — dense Active-Position row. */}
      <ActivePositionBar sessionId={sessionId} leaderAddress={leaderAddress} leaderPositions={leaderPositions} />

      {/* The animated approval popup overlays everything when a pending action
          appears. NO-AUTO-FIRE: nothing executes until the human approves here. */}
      <ApprovalPopup sessionId={sessionId} />
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
