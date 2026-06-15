'use client';

/**
 * CockpitClient — the live cockpit layout. Receives server-fetched initial state
 * (mode, session, leader positions) from the RSC page and opens the two realtime
 * transports:
 *   - HL websocket (market data) via the island hooks (Orderbook / LiveChart).
 *   - Supabase realtime (cockpit state) via the per-table hooks inside each
 *     island (HealthPanel / AnalysisStream / HypothesisBoard / ContextGauge /
 *     PositionPanel).
 *
 * The page itself fetches nothing high-frequency; the islands subscribe.
 */

import { useState } from 'react';
import { css } from '@styled-system/css';
import type { TradingMode } from '@/types/fill';
import type { Session } from '@/types/cockpit';
import type { HlPosition } from '@/lib/hyperliquid/hyperliquid-info-service';
import type { CandleInterval } from '@/lib/hyperliquid/candle-service';
import Banners from './components/Banners';
import Orderbook from './components/Orderbook';
import LiveChart from './components/LiveChart';
import PositionPanel from './components/PositionPanel';
import HealthPanel from './components/HealthPanel';
import AnalysisStream from './components/AnalysisStream';
import HypothesisBoard from './components/HypothesisBoard';
import ContextGauge from './components/ContextGauge';

export interface CockpitClientProps {
  mode: TradingMode;
  session: Session | null;
  leaderAddress: string | null;
  leaderPositions: HlPosition[];
  /** Coins the operator can switch between. Default ETH/BTC. */
  coins?: string[];
}

const INTERVALS: CandleInterval[] = ['1d', '8h', '1h', '15m'];

export default function CockpitClient({
  mode,
  session,
  leaderAddress,
  leaderPositions,
  coins = ['ETH', 'BTC'],
}: CockpitClientProps) {
  const [coin, setCoin] = useState(coins[0] ?? 'ETH');
  const [interval, setInterval] = useState<CandleInterval>('8h');
  const sessionId = session?.id ?? null;

  return (
    <main
      className={css({
        minHeight: '100vh',
        padding: { base: '12px', md: '20px' },
        display: 'flex',
        flexDirection: 'column',
        gap: '14px',
        maxWidth: '1400px',
        margin: '0 auto',
      })}
    >
      <header className={css({ display: 'flex', flexDirection: 'column', gap: '10px' })}>
        <div className={css({ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px' })}>
          <h1 className={css({ fontSize: 'xl', fontWeight: 'bold', color: 'github.textBright' })}>
            HL Cockpit
            {session?.title && (
              <span className={css({ fontSize: 'sm', color: 'github.textMuted', fontWeight: 'normal', marginLeft: '10px' })}>
                {session.title}
              </span>
            )}
          </h1>
          <div className={css({ display: 'flex', gap: '8px', alignItems: 'center' })}>
            <Selector value={coin} options={coins} onChange={setCoin} testid="coin-selector" />
            <Selector value={interval} options={INTERVALS} onChange={(v) => setInterval(v as CandleInterval)} testid="interval-selector" />
          </div>
        </div>
        <Banners mode={mode} />
        {!session && (
          <span data-testid="no-session" className={css({ fontSize: 'xs', color: 'zone.warn' })}>
            No active session — start one via the open-position skill to begin live tracking.
          </span>
        )}
      </header>

      <div
        className={css({
          display: 'grid',
          gridTemplateColumns: { base: '1fr', lg: '2fr 1fr' },
          gap: '14px',
          alignItems: 'start',
        })}
      >
        {/* Left column: chart + book + positions. */}
        <div className={css({ display: 'flex', flexDirection: 'column', gap: '14px' })}>
          <LiveChart coin={coin} interval={interval} />
          <div className={css({ display: 'grid', gridTemplateColumns: { base: '1fr', md: '1fr 1fr' }, gap: '14px', alignItems: 'start' })}>
            <Orderbook coin={coin} />
            <PositionPanel sessionId={sessionId} leaderAddress={leaderAddress} leaderPositions={leaderPositions} />
          </div>
        </div>

        {/* Right column: health + context + hypotheses + analysis. */}
        <div className={css({ display: 'flex', flexDirection: 'column', gap: '14px' })}>
          <HealthPanel sessionId={sessionId} />
          <ContextGauge sessionId={sessionId} />
          <HypothesisBoard sessionId={sessionId} />
          <AnalysisStream sessionId={sessionId} />
        </div>
      </div>
    </main>
  );
}

function Selector({
  value,
  options,
  onChange,
  testid,
}: {
  value: string;
  options: string[];
  onChange: (v: string) => void;
  testid: string;
}) {
  return (
    <select
      data-testid={testid}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={css({
        bg: 'github.bgSecondary',
        border: '1px solid token(colors.github.border)',
        borderRadius: '6px',
        color: 'github.textBright',
        fontSize: 'sm',
        fontFamily: 'mono',
        padding: '4px 8px',
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
