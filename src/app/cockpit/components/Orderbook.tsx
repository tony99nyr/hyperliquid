'use client';

/**
 * Orderbook — live L2 book (bids/asks) with spread + mid, from useHlOrderbook
 * (the HL websocket → direct-to-browser transport, never stored). Depth bars are
 * sized by cumulative size (withCumulativeDepth, PURE). Shows a stale badge when
 * the REST fallback is driving.
 */

import { css } from '@styled-system/css';
import type { LiveMarketState, MarketBookLevel } from '@/types/market';
import { useHlOrderbook } from '@/hooks/useHlOrderbook';
import {
  summarizeBook,
  withCumulativeDepth,
  type BookSummary,
} from '@/hooks/orderbook-helpers';
import { GH, ZONE_COLORS, fmtPx } from './panel-styles';

export interface OrderbookProps {
  coin: string;
  /**
   * Test/RSC seed: render a fixed book instead of opening a socket. When
   * provided the hook is not used (keeps the component pure for tests).
   */
  stateOverride?: Pick<LiveMarketState, 'bids' | 'asks' | 'status' | 'stale'> & {
    lastPx?: number | null;
  };
  /** How many levels per side to render. Default 10. */
  depth?: number;
}

function levelRows(
  levels: MarketBookLevel[],
  depth: number,
  maxCum: number,
  side: 'bid' | 'ask',
) {
  const color = side === 'bid' ? ZONE_COLORS.ok : ZONE_COLORS.danger;
  const bg = side === 'bid' ? 'rgba(63,185,80,0.12)' : 'rgba(248,81,73,0.12)';
  return withCumulativeDepth(levels.slice(0, depth)).map((lvl) => {
    const pct = maxCum > 0 ? (lvl.cumSz / maxCum) * 100 : 0;
    return (
      <div
        key={`${side}-${lvl.px}`}
        data-testid={`ob-${side}-row`}
        className={css({
          position: 'relative',
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          fontSize: 'xs',
          fontFamily: 'mono',
          paddingX: '8px',
          paddingY: '2px',
        })}
      >
        <span
          aria-hidden
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            [side === 'bid' ? 'right' : 'left']: 0,
            width: `${pct}%`,
            background: bg,
          }}
        />
        <span style={{ color, zIndex: 1 }}>{fmtPx(lvl.px)}</span>
        <span style={{ color: GH.text, zIndex: 1, textAlign: 'right' }}>
          {lvl.sz.toLocaleString('en-US', { maximumFractionDigits: 4 })}
        </span>
      </div>
    );
  });
}

export default function Orderbook({ coin, stateOverride, depth = 10 }: OrderbookProps) {
  const live = useHlOrderbook(stateOverride ? '' : coin);

  const bids = stateOverride ? stateOverride.bids : live.bids;
  const asks = stateOverride ? stateOverride.asks : live.asks;
  const status: LiveMarketState['status'] = stateOverride ? stateOverride.status : live.status;
  const stale = stateOverride ? stateOverride.stale : live.stale;
  const book: BookSummary = stateOverride ? summarizeBook(bids, asks) : live.book;

  const maxCum = Math.max(
    bids.slice(0, depth).reduce((s, l) => s + l.sz, 0),
    asks.slice(0, depth).reduce((s, l) => s + l.sz, 0),
    1,
  );

  return (
    <section
      data-testid="orderbook"
      data-status={status}
      className={css({
        bg: 'github.bgSecondary',
        border: '1px solid token(colors.github.border)',
        borderRadius: '8px',
        padding: '12px',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
      })}
    >
      <header className={css({ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' })}>
        <h2 className={css({ fontSize: 'sm', fontWeight: 'semibold', color: 'github.textBright' })}>
          {coin.toUpperCase()} Order Book
        </h2>
        {stale ? (
          <span
            data-testid="ob-stale-badge"
            style={{ color: ZONE_COLORS.warn }}
            className={css({ fontSize: 'xs', fontWeight: 'bold' })}
          >
            STALE (REST)
          </span>
        ) : (
          <span
            data-testid="ob-status"
            style={{ color: status === 'live' ? ZONE_COLORS.ok : GH.textMuted }}
            className={css({ fontSize: 'xs' })}
          >
            {status}
          </span>
        )}
      </header>

      {/* Asks: render worst→best so best ask sits just above the spread row. */}
      <div className={css({ display: 'flex', flexDirection: 'column-reverse' })}>
        {levelRows(asks, depth, maxCum, 'ask')}
      </div>

      <div
        data-testid="ob-spread"
        className={css({
          display: 'flex',
          justifyContent: 'space-between',
          paddingX: '8px',
          paddingY: '4px',
          borderTop: '1px solid token(colors.github.borderSubtle)',
          borderBottom: '1px solid token(colors.github.borderSubtle)',
          fontSize: 'xs',
          fontFamily: 'mono',
        })}
      >
        <span className={css({ color: 'github.textMuted' })}>
          mid <span style={{ color: GH.textBright }} data-testid="ob-mid">{fmtPx(book.mid)}</span>
        </span>
        <span className={css({ color: 'github.textMuted' })}>
          spread{' '}
          <span style={{ color: GH.textBright }} data-testid="ob-spread-val">
            {book.spread === null ? '—' : fmtPx(book.spread)}
          </span>
          {book.spreadPct !== null && (
            <span className={css({ color: 'github.textMuted' })}> ({(book.spreadPct * 10000).toFixed(1)} bps)</span>
          )}
        </span>
      </div>

      {/* Bids: best first. */}
      <div className={css({ display: 'flex', flexDirection: 'column' })}>
        {levelRows(bids, depth, maxCum, 'bid')}
      </div>
    </section>
  );
}
