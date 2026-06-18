'use client';

/**
 * TopTradersRail — the cockpit's unique left rail: a ranked list of rated HL
 * traders (composite score, risk flags, top coins) plus a slot for the live
 * action feed (deferred — read-only intel for now, an empty styled state labels
 * it for the future). Rows come pre-sliced from the RSC page (the 2.8MB dataset
 * never reaches the client).
 *
 * Each row is a button that opens the TraderDetailDrawer — the "is this trader
 * safe to follow?" read (live positions + stats + risk flags + a Mirror command).
 */

import { useMemo, useState } from 'react';
import { css } from '@styled-system/css';
import type { TopTraderRow } from '@/lib/hyperliquid/top-traders-service';
import { GH, ZONE_COLORS, panelSurface, regimeColor } from '../panel-styles';
import TraderDetailDrawer from './TraderDetailDrawer';
import {
  DEFAULT_FILTER_STATE,
  applyTraderFilters,
  type TraderFilterState,
} from './top-traders-filter-helpers';
import { formatRatingsDate, type RatingsFreshness } from './ratings-freshness-helpers';

export interface TopTradersRailProps {
  traders: TopTraderRow[];
  /** The address currently followed this session, if any (highlighted). */
  followedAddress?: string | null;
  /** Ratings freshness (built server-side: generatedAt + stale). */
  ratings?: RatingsFreshness | null;
}

function compositeColor(score: number | null): string {
  if (score === null) return GH.textMuted;
  if (score >= 7) return ZONE_COLORS.ok;
  if (score >= 4) return ZONE_COLORS.warn;
  return GH.text;
}

/** A compact terminal-styled toggle chip (aria-pressed for screen readers). */
function FilterChip({
  label,
  title,
  active,
  disabled,
  onToggle,
}: {
  label: string;
  title: string;
  active: boolean;
  disabled?: boolean;
  onToggle?: () => void;
}) {
  return (
    <button
      type="button"
      data-testid="trader-filter-chip"
      aria-pressed={active}
      aria-disabled={disabled || undefined}
      disabled={disabled}
      title={title}
      onClick={disabled ? undefined : onToggle}
      style={
        active
          ? { borderColor: '#5b8cff', color: '#e8ebf2', background: 'rgba(91,140,255,0.14)' }
          : undefined
      }
      className={css({
        fontFamily: 'mono',
        fontSize: '10px',
        letterSpacing: '0.02em',
        textTransform: 'uppercase',
        color: 'github.textMuted',
        bg: 'github.bg',
        border: '1px solid token(colors.github.borderSubtle)',
        borderRadius: '5px',
        padding: '3px 7px',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.4 : 1,
        whiteSpace: 'nowrap',
        _hover: disabled ? {} : { borderColor: 'github.link', color: 'github.textBright' },
        _focusVisible: { outline: '2px solid token(colors.github.link)', outlineOffset: '1px' },
      })}
    >
      {label}
    </button>
  );
}

export default function TopTradersRail({ traders, followedAddress, ratings }: TopTradersRailProps) {
  const followed = followedAddress?.toLowerCase() ?? null;
  const [selected, setSelected] = useState<TopTraderRow | null>(null);
  const [filters, setFilters] = useState<TraderFilterState>(DEFAULT_FILTER_STATE);

  // Freshness is built server-side (page is force-dynamic) → render it purely:
  // a deterministic absolute date + a server-computed `stale` flag, no Date.now()
  // in the client (so no SSR/hydration drift).
  const ratingsDate = formatRatingsDate(ratings?.generatedAt);
  const stale = ratings?.stale ?? false;

  const toggle = (key: keyof TraderFilterState) =>
    setFilters((f) => ({ ...f, [key]: !f[key] }));

  const shown = useMemo(() => applyTraderFilters(traders, filters), [traders, filters]);

  return (
    <section
      data-testid="top-traders-rail"
      className={css({ ...panelSurface, padding: '12px', display: 'flex', flexDirection: 'column', gap: '10px', minHeight: '0' })}
    >
      <div className={css({ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '8px' })}>
        <h2 className={css({ fontFamily: 'label', fontSize: 'sm', fontWeight: 'bold', color: 'github.textBright', textTransform: 'uppercase', letterSpacing: '0.06em' })}>
          Top Traders
        </h2>
        <span
          data-testid="ratings-freshness"
          aria-label={
            stale
              ? `Ratings generated ${ratingsDate}; overdue — re-run the rating pipeline`
              : `Ratings generated ${ratingsDate}`
          }
          title={stale ? `Ratings generated ${ratingsDate} — overdue (weekly cadence). Re-run the rating pipeline.` : `Ratings generated ${ratingsDate}`}
          style={stale ? { color: ZONE_COLORS.warn } : undefined}
          className={css({ fontFamily: 'mono', fontSize: '10px', color: 'github.textMuted', whiteSpace: 'nowrap', fontFeatureSettings: '"tnum"' })}
        >
          ratings · {ratingsDate}{stale ? ' · overdue' : ''}
        </span>
      </div>

      {/* Filter chips — compose (AND). Tradeable-only is ON by default. */}
      <div
        data-testid="trader-filter-bar"
        role="group"
        aria-label="Trader filters"
        className={css({ display: 'flex', flexWrap: 'wrap', gap: '5px', alignItems: 'center' })}
      >
        <FilterChip
          label="Clean book"
          title="Show only wallets with a clean (no-risk-flag) book"
          active={filters.cleanBook}
          onToggle={() => toggle('cleanBook')}
        />
        <FilterChip
          label="Hide at-risk"
          title="Hide wallets carrying any blow-up / risk flag"
          active={filters.hideAtRisk}
          onToggle={() => toggle('hideAtRisk')}
        />
        <FilterChip
          label="Tradeable only"
          title="Show only wallets that trade one of our coins (ETH / BTC / HYPE)"
          active={filters.tradeableOnly}
          onToggle={() => toggle('tradeableOnly')}
        />
        <FilterChip
          label="Has position"
          title="Filter to wallets with a live open position — coming with the trade-watch feed"
          active={false}
          disabled
        />
      </div>

      {traders.length === 0 ? (
        <span className={css({ fontSize: 'xs', color: 'github.textMuted', fontFamily: 'mono' })}>
          No rated wallets — run the rating pipeline.
        </span>
      ) : shown.length === 0 ? (
        <span data-testid="trader-filter-empty" className={css({ fontSize: 'xs', color: 'github.textMuted', fontFamily: 'mono' })}>
          No traders match the active filters.
        </span>
      ) : (
        <ol
          data-testid="top-traders-list"
          className={css({
            display: 'flex',
            flexDirection: 'column',
            gap: '6px',
            listStyle: 'none',
            margin: 0,
            padding: 0,
            // Scrollable body: cap the height so the rail itself stays put and
            // the operator scrolls through the (now ~50) rated wallets.
            overflowY: 'auto',
            flex: '1 1 auto',
            minHeight: '0',
            maxHeight: { base: 'none', lg: '62vh' },
            paddingRight: '2px',
          })}
        >
          {shown.map((t, i) => {
            const isFollowed = followed !== null && t.address.toLowerCase() === followed;
            return (
              <li key={t.address} className={css({ listStyle: 'none', margin: 0, padding: 0 })}>
              <button
                type="button"
                data-testid="top-trader-row"
                data-followed={isFollowed}
                onClick={() => setSelected(t)}
                aria-label={`Open detail for ${t.displayName ?? t.short}`}
                style={isFollowed ? { borderColor: '#5b8cff' } : undefined}
                className={css({
                  width: '100%',
                  textAlign: 'left',
                  cursor: 'pointer',
                  bg: 'github.bg',
                  border: '1px solid token(colors.github.borderSubtle)',
                  borderRadius: '6px',
                  padding: '7px 9px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '4px',
                  _hover: { borderColor: 'github.link' },
                  _focusVisible: { outline: '2px solid token(colors.github.link)', outlineOffset: '1px' },
                })}
              >
                <div className={css({ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '8px' })}>
                  <span className={css({ display: 'flex', alignItems: 'baseline', gap: '6px', minWidth: '0' })}>
                    <span className={css({ fontFamily: 'mono', fontSize: '10px', color: 'github.textMuted', fontFeatureSettings: '"tnum"' })}>
                      #{i + 1}
                    </span>
                    <span className={css({ fontFamily: 'mono', fontSize: 'xs', color: 'github.textBright', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' })}>
                      {t.displayName ?? t.short}
                    </span>
                    {t.leaderboardTop && (
                      <span title="On the HL leaderboard" className={css({ fontSize: '9px', color: 'github.link' })}>★</span>
                    )}
                  </span>
                  <span
                    data-testid="trader-composite"
                    style={{ color: compositeColor(t.composite), fontFeatureSettings: '"tnum"' }}
                    className={css({ fontFamily: 'mono', fontSize: 'sm', fontWeight: 'bold' })}
                  >
                    {t.composite === null ? '—' : t.composite.toFixed(0)}
                  </span>
                </div>
                <div className={css({ display: 'flex', flexWrap: 'wrap', gap: '4px', alignItems: 'center' })}>
                  {t.hasRisk && (
                    <span
                      data-testid="trader-risk"
                      style={{ color: ZONE_COLORS.danger, borderColor: ZONE_COLORS.danger }}
                      className={css({ fontFamily: 'mono', fontSize: '9px', fontWeight: 'bold', border: '1px solid', borderRadius: '3px', paddingX: '4px' })}
                    >
                      RISK
                    </span>
                  )}
                  {t.topCoins.map((c) => (
                    <span key={c} className={css({ fontFamily: 'mono', fontSize: '9px', color: 'github.textMuted' })}>
                      {c}
                    </span>
                  ))}
                </div>
              </button>
              </li>
            );
          })}
        </ol>
      )}

      {/* Future live action feed (deferred). Collapsed to a single-line footnote
          so it labels the upcoming feed without claiming permanent rail space. */}
      <div
        data-testid="trader-feed-slot"
        className={css({
          borderTop: '1px solid token(colors.github.borderSubtle)',
          paddingTop: '8px',
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
        })}
      >
        <span style={{ color: regimeColor('neutral') }} className={css({ fontFamily: 'mono', fontSize: '10px' })}>
          ◌ live trader fills — coming soon
        </span>
      </div>

      {selected && (
        <TraderDetailDrawer trader={selected} onClose={() => setSelected(null)} />
      )}
    </section>
  );
}
