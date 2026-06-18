'use client';

/**
 * CockpitView (design handoff) — the three-column terminal:
 *   LEFT  262px : Top Traders rail (clickable → trader drawer)
 *   CENTER 1fr  : chart card → Open Positions FOCAL panel (+ Leader-vs-You when
 *                 following) → Analysis/Hypotheses/Context tabs
 *   RIGHT 332px : Market Regime + Order Book
 *
 * All wave-2 features survive and are fitted into the design's structure:
 *   - leverage slider + Match-leader live through the ApprovalPopup (rendered by
 *     the shell, fed leader positions)
 *   - Match-leader / Leader-vs-You panel sits beside the Open Positions panel
 *   - clickable Top Traders → drawer (TopTradersRail unchanged)
 *   - adaptive Market-Read / Trade-Health (HealthPanel) co-located with the trade
 *
 * Wired to REAL data throughout (Supabase realtime + HL ws + candle polls).
 */

import { useState, useCallback } from 'react';
import { css } from '@styled-system/css';
import type { HlPosition } from '@/lib/hyperliquid/hyperliquid-info-service';
import type { TopTraderRow } from '@/lib/hyperliquid/top-traders-service';
import type { ActiveTrade } from './chart/candle-chart-helpers';
import type { RegimeDir } from './open-positions-helpers';
import CandleChartPanel from './chart/CandleChartPanel';
import TopTradersRail from './left-rail/TopTradersRail';
import OpenPositionsPanel from './OpenPositionsPanel';
import MarketRegimePanel from './right-rail/MarketRegimePanel';
import Orderbook from './Orderbook';
import SecondaryStrip from './SecondaryStrip';
import HealthPanel from './HealthPanel';
import LeaderVsYou from './LeaderVsYou';
import GettingStarted from './GettingStarted';

export interface CockpitViewProps {
  sessionId: string | null;
  hasSession: boolean;
  coin: string;
  coins: string[];
  onCoinChange: (c: string) => void;
  trade: ActiveTrade | null;
  leaderAddress: string | null;
  leaderPositions: HlPosition[];
  topTraders: TopTraderRow[];
  currentEquityUsd: number;
  /**
   * Render the left Top-Traders rail. False on mobile, where Traders is its own
   * bottom-tab surface (the design buries nothing behind the chart).
   */
  showTradersRail?: boolean;
}

export default function CockpitView({
  sessionId,
  hasSession,
  coin,
  coins,
  onCoinChange,
  trade,
  leaderAddress,
  leaderPositions,
  topTraders,
  currentEquityUsd,
  showTradersRail = true,
}: CockpitViewProps) {
  // Net regime bias per coin (from the right-rail Market Regime panel) drives the
  // Open Positions alignment badge — fetched ONCE per coin, lifted up here.
  const [regimeByCoin, setRegimeByCoin] = useState<Record<string, RegimeDir>>({});
  const onNetBias = useCallback(
    (dir: RegimeDir) => setRegimeByCoin((m) => (m[coin] === dir ? m : { ...m, [coin]: dir })),
    [coin],
  );

  // NO-AUTO-FIRE: the UI can't fabricate an entry intent — an entry is proposed
  // by the open-position / run-session skill and surfaces as the ApprovalPopup.
  // "＋ New Position" therefore reveals the skill flow (GettingStarted) rather
  // than opening a client-built order ticket.
  const [showNew, setShowNew] = useState(false);
  const onNewPosition = useCallback(() => setShowNew(true), []);

  return (
    <div
      data-testid="cockpit-view"
      className={css({
        flex: 1,
        display: 'grid',
        gridTemplateColumns: showTradersRail
          ? { base: '1fr', lg: '262px minmax(0, 1fr) 332px' }
          : { base: '1fr', lg: 'minmax(0, 1fr) 332px' },
        gap: '12px',
        padding: '12px',
        overflow: { base: 'visible', lg: 'hidden' },
        minHeight: '0',
      })}
    >
      {/* LEFT — Top Traders rail (desktop only; mobile uses the Traders tab). */}
      {showTradersRail && (
        <aside className={css({ order: { base: 3, lg: 0 }, minHeight: '0', overflowY: { base: 'visible', lg: 'auto' } })}>
          <TopTradersRail traders={topTraders} followedAddress={leaderAddress} />
        </aside>
      )}

      {/* CENTER — chart → open positions → leader-vs-you / health → analysis. */}
      <main className={css({ order: { base: 1, lg: 0 }, display: 'flex', flexDirection: 'column', gap: '12px', minHeight: '0', overflowY: { base: 'visible', lg: 'auto' }, paddingRight: { lg: '2px' } })}>
        {(!hasSession || showNew) && <GettingStarted />}
        <CockpitCoinTabs coin={coin} coins={coins} onChange={onCoinChange} />
        <CandleChartPanel coin={coin} trade={trade} />
        <OpenPositionsPanel
          sessionId={sessionId}
          regimeByCoin={regimeByCoin}
          currentEquityUsd={currentEquityUsd}
          onNewPosition={onNewPosition}
        />
        {/* Adaptive Market-Read / Trade-Health + Leader-vs-You (wave-2). */}
        <div className={css({ display: 'grid', gridTemplateColumns: { base: '1fr', md: 'minmax(0,1fr) minmax(0,1fr)' }, gap: '12px', alignItems: 'start' })}>
          <HealthPanel sessionId={sessionId} coin={coin} />
          <LeaderVsYou sessionId={sessionId} coin={coin} leaderAddress={leaderAddress} leaderPositions={leaderPositions} />
        </div>
        <SecondaryStrip sessionId={sessionId} />
      </main>

      {/* RIGHT — Market Regime + Order Book. On mobile the compact Market Regime
          sits directly under the focal Open-Positions stack; the dense order book
          is desktop-only (the phone surface stays scannable). */}
      <aside className={css({ order: { base: 2, lg: 0 }, display: 'flex', flexDirection: 'column', gap: '12px', minHeight: '0', overflowY: { base: 'visible', lg: 'auto' } })}>
        <MarketRegimePanel coin={coin} onNetBias={onNetBias} />
        <div className={css({ display: { base: 'none', lg: 'block' } })}>
          <Orderbook coin={coin} depth={8} />
        </div>
      </aside>
    </div>
  );
}

/** Coin selector styled as the design's segmented control (ETH / BTC / …). */
function CockpitCoinTabs({ coin, coins, onChange }: { coin: string; coins: string[]; onChange: (c: string) => void }) {
  if (coins.length <= 1) return null;
  return (
    <div role="group" aria-label="Select coin" className={css({ display: 'flex', gap: '2px', bg: 'cockpit.navIdle', border: '1px solid token(colors.github.border)', borderRadius: '8px', padding: '3px', width: 'fit-content' })}>
      {coins.map((c) => {
        const active = c === coin;
        return (
          <button
            key={c}
            type="button"
            data-testid={`coin-tab-${c}`}
            data-active={active}
            onClick={() => onChange(c)}
            style={{ background: active ? '#1c2536' : 'transparent', color: active ? '#e8ebf2' : '#8b95a6' }}
            className={css({ fontFamily: 'mono', fontSize: '12px', fontWeight: 'semibold', paddingX: '14px', paddingY: '5px', borderRadius: '6px', border: 'none', cursor: 'pointer' })}
          >
            {c}
          </button>
        );
      })}
    </div>
  );
}
