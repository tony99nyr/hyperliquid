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
 *   - clickable Top Traders → drawer (TradersTable)
 *   - adaptive Market-Read / Trade-Health (HealthPanel) co-located with the trade
 *
 * Wired to REAL data throughout (Supabase realtime + HL ws + candle polls).
 */

import { useState, useCallback, useEffect } from 'react';
import { css } from '@styled-system/css';
import type { HlPosition } from '@/lib/hyperliquid/hyperliquid-info-service';
import type { OrderSide, TradingMode } from '@/types/fill';
import type { ActiveTrade } from './chart/candle-chart-helpers';
import type { RegimeDir } from './open-positions-helpers';
import { useHlOrderbook } from '@/hooks/useHlOrderbook';
import CandleChartPanel from './chart/CandleChartPanel';
import OpenPositionsPanel from './OpenPositionsPanel';
import MarketRegimePanel from './right-rail/MarketRegimePanel';
import FavoritePlaysBoard from './opportunity/FavoritePlaysBoard';
import FollowingPanel from './FollowingPanel';
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
  /** A pending "copy a leader position" request (set when switching here from the
   *  Traders tab) — consumed on arrival to open the pre-filled entry preview. */
  stageRequest?: { coin: string; side: 'long' | 'short' } | null;
  /** Called once the stageRequest has been consumed (parent clears it). */
  onStageConsumed?: () => void;
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
  stageRequest,
  onStageConsumed,
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
  // Side to seed the entry preview with. Manual "+ New Position" defaults to buy;
  // opening from an opportunity carries THAT opportunity's side (so a SHORT setup
  // opens a SHORT preview, not the default long).
  const [entrySide, setEntrySide] = useState<OrderSide>('buy');
  // Bumps on each FRESH open/stage so the modal re-keys (reseeds) only then — NOT when
  // the operator changes coin inside the open ticket (which would wipe their typed
  // size/leverage/LIVE phrase). Keying on `coin` directly was that bug.
  const [stageNonce, setStageNonce] = useState(0);
  const onNewPosition = useCallback(() => {
    setEntrySide('buy');
    setStageNonce((n) => n + 1);
    setShowEntry(true);
  }, []);

  // Stage a discretionary entry from a favorite's play: repoint the cockpit to that
  // coin (so the entry form + price feed seed on it) and open the EntryModal with the
  // leader's SIDE. Batched with the coin switch so the modal mounts on the new coin.
  // NO-AUTO-FIRE: only the operator's explicit Approve in the modal executes.
  const onStagePlay = useCallback(
    (playCoin: string, side: 'long' | 'short') => {
      if (playCoin !== coin) onCoinChange(playCoin);
      setEntrySide(side === 'long' ? 'buy' : 'sell');
      setStageNonce((n) => n + 1);
      setShowEntry(true);
    },
    [coin, onCoinChange],
  );

  // Consume a "copy a leader position" request handed over from the Traders tab: the
  // parent has already repointed the coin + switched here, so just open the pre-filled
  // entry preview with the leader's side, then signal the parent to clear the request.
  // Deferred a tick (setState lives in the timeout callback, not the effect body) so it
  // doesn't synchronously cascade renders on mount.
  useEffect(() => {
    if (!stageRequest) return;
    const { coin: stageCoin, side } = stageRequest;
    const t = setTimeout(() => {
      onStagePlay(stageCoin, side);
      onStageConsumed?.();
    }, 0);
    return () => clearTimeout(t);
  }, [stageRequest, onStagePlay, onStageConsumed]);

  // Live mark for the selected coin (the entry modal's sizing needs a price).
  const book = useHlOrderbook(coin);
  const entryPx = book.lastPx ?? book.book.mid ?? null;

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
        <CandleChartPanel coin={coin} trade={trade} />
      </main>

      {/* RIGHT — the decision column: what you ACT on (positions + opportunities)
          on top, then the reads (health / regime / leader posture / leader-vs-you).
          On mobile this stacks directly under the chart. */}
      {/* '& > *': flexShrink 0 — without it, a flex COLUMN with overflowY:auto squeezes
          its panels below their content height when the column overflows, and the
          spilled content (default overflow:visible) overlaps the next panel
          ("jumbled / on top of each other"). Pinning shrink → the aside SCROLLS instead. */}
      <aside className={css({ order: { base: 2, lg: 0 }, display: 'flex', flexDirection: 'column', gap: '12px', minWidth: 0, minHeight: { base: 'auto', lg: '0' }, overflowY: { base: 'visible', lg: 'auto' }, '& > *': { flexShrink: 0 } })}>
        <OpenPositionsPanel
          sessionId={sessionId}
          mode={mode}
          regimeByCoin={regimeByCoin}
          currentEquityUsd={currentEquityUsd}
          onNewPosition={onNewPosition}
        />
        <FollowingPanel onCopy={onStagePlay} />
        <FavoritePlaysBoard onStagePlay={onStagePlay} />
        <HealthPanel sessionId={sessionId} coin={coin} onCoinChange={onCoinChange} />
        <MarketRegimePanel coin={coin} onNetBias={onNetBias} />
        <WhalePosture coins={coins} />
        <LeaderVsYou sessionId={sessionId} coin={coin} leaderAddress={leaderAddress} leaderPositions={leaderPositions} />
      </aside>

      {/* SELF-SERVICE entry modal — floats above everything. NO-AUTO-FIRE: it only
          executes on the operator's explicit Approve. The Claude-skill → approval
          popup path (mounted in CockpitClient) still works in parallel. */}
      {showEntry && (
        <EntryModal
          // Re-key on the stage NONCE (bumped only on a fresh open/stage) so a new
          // Copy reseeds — but changing coin INSIDE the open ticket does NOT remount
          // (that would wipe the operator's typed size/leverage/LIVE phrase).
          key={`entry-${stageNonce}`}
          mode={mode}
          coin={coin}
          initialSide={entrySide}
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
