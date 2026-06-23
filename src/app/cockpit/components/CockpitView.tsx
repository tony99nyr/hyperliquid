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

import { useState, useCallback, useMemo } from 'react';
import { css } from '@styled-system/css';
import type { HlPosition } from '@/lib/hyperliquid/hyperliquid-info-service';
import type { TradingMode } from '@/types/fill';
import type { ActiveTrade, OpportunityLevels } from './chart/candle-chart-helpers';
import type { RegimeDir } from './open-positions-helpers';
import { useHlOrderbook } from '@/hooks/useHlOrderbook';
import { useRubricScores } from '@/hooks/useRubricScores';
import { toCardModels } from './opportunity/opportunity-helpers';
import CandleChartPanel from './chart/CandleChartPanel';
import OpenPositionsPanel from './OpenPositionsPanel';
import MarketRegimePanel from './right-rail/MarketRegimePanel';
import OpportunityBoard from './opportunity/OpportunityBoard';
import WhalePosture from './opportunity/WhalePosture';
import HealthPanel from './HealthPanel';
import LeaderVsYou from './LeaderVsYou';
import EntryModal from './EntryModal';

export interface CockpitViewProps {
  sessionId: string | null;
  /** Trading mode (paper/live) — drives the entry modal's LIVE confirm gate. */
  mode: TradingMode;
  coin: string;
  coins: string[];
  onCoinChange: (c: string) => void;
  trade: ActiveTrade | null;
  leaderAddress: string | null;
  leaderPositions: HlPosition[];
  currentEquityUsd: number;
}

export default function CockpitView({
  sessionId,
  mode,
  coin,
  coins,
  onCoinChange,
  trade,
  leaderAddress,
  leaderPositions,
  currentEquityUsd,
}: CockpitViewProps) {
  // Net regime bias per coin (from the right-rail Market Regime panel) drives the
  // Open Positions alignment badge — fetched ONCE per coin, lifted up here.
  const [regimeByCoin, setRegimeByCoin] = useState<Record<string, RegimeDir>>({});
  const onNetBias = useCallback(
    (dir: RegimeDir) => setRegimeByCoin((m) => (m[coin] === dir ? m : { ...m, [coin]: dir })),
    [coin],
  );

  // SELF-SERVICE entry (parallel to the Claude-skill → ApprovalPopup path, which
  // still works). "＋ New Position" opens the EntryModal — the operator hand-builds
  // an opening order and explicitly Approves it. NO-AUTO-FIRE is preserved: the
  // modal only POSTs /api/cockpit/open-position on that explicit Approve click;
  // nothing fires on its own.
  const [showEntry, setShowEntry] = useState(false);
  const onNewPosition = useCallback(() => setShowEntry(true), []);

  // Opportunity chart overlay is TOGGLEABLE: click a coin's opportunity to view its
  // entry/stop/target on the chart; click the SAME coin again to clear it (reset to a
  // clean chart). Clicking a different coin selects it AND turns the overlay on.
  const [oppOverlayOn, setOppOverlayOn] = useState(false);
  const onOpportunityClick = useCallback(
    (c: string) => {
      if (!coins.includes(c)) return;
      if (c.toUpperCase() === coin.toUpperCase()) {
        setOppOverlayOn((v) => !v);
      } else {
        onCoinChange(c);
        setOppOverlayOn(true);
      }
    },
    [coins, coin, onCoinChange],
  );

  // Live mark for the selected coin (the entry modal's sizing needs a price).
  const book = useHlOrderbook(coin);
  const entryPx = book.lastPx ?? book.book.mid ?? null;

  // Rubric reads — subscribed ONCE here, fed to the board (override → its own
  // subscription stays inert) and the chart (overlay the selected coin's levels).
  const rubric = useRubricScores();
  const cardModels = useMemo(() => toCardModels(rubric.rows, coins), [rubric.rows, coins]);
  const selectedOpp: OpportunityLevels | null = useMemo(() => {
    const m = cardModels.find((c) => c.coin === coin.toUpperCase());
    if (!m) return null;
    return {
      side: m.chosenSide,
      entryLow: m.display.entryLow,
      entryHigh: m.display.entryHigh,
      invalidation: m.display.invalidation,
      target: m.display.target,
    };
  }, [cardModels, coin]);

  return (
    <div
      data-testid="cockpit-view"
      className={css({
        flex: 1,
        display: 'grid',
        // Chart-centric: a big chart on the LEFT, the decision column (positions +
        // opportunities + reads) on the RIGHT next to it. No left rail (Traders is
        // its own tab), no order book / activity feed (ambient, not actionable).
        // base MUST be minmax(0, 1fr), not '1fr': a plain 1fr track lets grid items
        // keep their min-content width (min-width:auto), so any wide child (a mono
        // number row, a fixed grid) blows the column past the viewport → horizontal
        // scroll on mobile. minmax(0,…) lets the track shrink; the items get min-width:0.
        gridTemplateColumns: { base: 'minmax(0, 1fr)', lg: 'minmax(0, 1fr) 420px' },
        gap: '12px',
        padding: '12px',
        overflow: { base: 'visible', lg: 'hidden' },
        minHeight: { base: 'auto', lg: '0' },
      })}
    >
      {/* LEFT — the chart (the thing you watch price on). */}
      <main className={css({ order: { base: 1, lg: 0 }, display: 'flex', flexDirection: 'column', gap: '12px', minWidth: 0, minHeight: { base: 'auto', lg: '0' }, overflowY: { base: 'visible', lg: 'auto' }, paddingRight: { lg: '2px' } })}>
        <CockpitCoinTabs coin={coin} coins={coins} onChange={onCoinChange} />
        <CandleChartPanel coin={coin} trade={trade} opportunity={oppOverlayOn ? selectedOpp : null} />
      </main>

      {/* RIGHT — the decision column: what you ACT on (positions + opportunities)
          on top, then the reads (health / regime / leader posture / leader-vs-you).
          On mobile this stacks directly under the chart. */}
      <aside className={css({ order: { base: 2, lg: 0 }, display: 'flex', flexDirection: 'column', gap: '12px', minWidth: 0, minHeight: { base: 'auto', lg: '0' }, overflowY: { base: 'visible', lg: 'auto' } })}>
        <OpenPositionsPanel
          sessionId={sessionId}
          regimeByCoin={regimeByCoin}
          currentEquityUsd={currentEquityUsd}
          onNewPosition={onNewPosition}
        />
        <OpportunityBoard
          order={coins}
          selectedCoin={coin}
          onSelectCoin={onOpportunityClick}
          onAskClaude={() => onNewPosition()}
          rowsOverride={rubric.rows}
        />
        <HealthPanel sessionId={sessionId} coin={coin} />
        <MarketRegimePanel coin={coin} onNetBias={onNetBias} />
        <WhalePosture coins={coins} />
        <LeaderVsYou sessionId={sessionId} coin={coin} leaderAddress={leaderAddress} leaderPositions={leaderPositions} />
      </aside>

      {/* SELF-SERVICE entry modal — floats above everything. NO-AUTO-FIRE: it only
          executes on the operator's explicit Approve. The Claude-skill → approval
          popup path (mounted in CockpitClient) still works in parallel. */}
      {showEntry && (
        <EntryModal
          mode={mode}
          coin={coin}
          coins={coins}
          entryPx={entryPx}
          regimeByCoin={regimeByCoin}
          leaderPositions={leaderPositions}
          onCoinChange={onCoinChange}
          onClose={() => setShowEntry(false)}
        />
      )}
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
