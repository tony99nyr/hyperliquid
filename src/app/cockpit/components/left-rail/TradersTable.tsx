'use client';

/**
 * TradersTable — the trader-evaluation surface (replaces the old card rail). A
 * sortable, filterable, numbers-first TABLE of rated HL traders so the operator
 * can browse a wide pool and narrow by the trade/profit/risk story: click a column
 * header to sort (toggle dir), use the filter bar to cut, ★ to favorite (which gates
 * the live watch), and click a row to open the detail drawer.
 *
 * Per the review (B3): under-sampled names are SHOWN but badged (thin), never
 * hard-cut. Sort/filter does the narrowing. Pure sort/filter lives in
 * traders-table-business-logic; favorites in useFavorites; the drawer + action feed
 * are reused.
 */

import { useMemo, useState, type ReactNode } from 'react';
import { css } from '@styled-system/css';
import type { TopTraderRow } from '@/lib/hyperliquid/top-traders-service';
import { useLeaderPositionsTable } from '@/hooks/useLeaderPositionsTable';
import { useFavorites } from '@/hooks/useFavorites';
import { useTraderEvaluations } from '@/hooks/useTraderEvaluations';
import {
  sortTraders,
  filterTraders,
  isThinHistory,
  isVaultLed,
  type SortKey,
  type SortDir,
  type TraderFilter,
  type GetEval,
} from '@/lib/cockpit/traders-table-business-logic';
import { buildHasTradeablePositionSet } from './top-traders-filter-helpers';
import { GH, ZONE_COLORS, panelSurface } from '../panel-styles';
import TraderDetailDrawer from './TraderDetailDrawer';
import LeaderActionFeed from './LeaderActionFeed';
import { formatRatingsDate, type RatingsFreshness } from './ratings-freshness-helpers';

export interface TradersTableProps {
  traders: TopTraderRow[];
  followedAddress?: string | null;
  ratings?: RatingsFreshness | null;
  /** Copy a leader position → pre-filled entry preview in the cockpit (switches tab). */
  onCopyPosition?: (coin: string, side: 'long' | 'short') => void;
}

const PAGE = 30;

type Fmt = (r: TopTraderRow) => string;
const pct = (v: number | null | undefined): string => (v == null ? '—' : `${(v * 100).toFixed(0)}%`);
const num = (v: number | null | undefined): string => (v == null ? '—' : v.toFixed(2));
const hrs = (v: number | null | undefined): string => (v == null ? '—' : v < 1 ? `${(v * 60).toFixed(0)}m` : `${v.toFixed(0)}h`);
const int = (v: number | null | undefined): string => (v == null ? '—' : v.toLocaleString('en-US'));

const VERDICT_STYLE: Record<string, { bg: string; label: string }> = {
  follow: { bg: ZONE_COLORS.ok, label: 'FOLLOW' },
  caution: { bg: ZONE_COLORS.warn, label: 'CAUTION' },
  avoid: { bg: ZONE_COLORS.danger, label: 'AVOID' },
};

/** Copyability cell: the on-demand vet verdict + closed-trip count (0 trips = no evidence). */
function CopyabilityCell({ row, getEval }: { row: TopTraderRow; getEval: GetEval }) {
  const ev = getEval(row.address);
  if (!ev) return <span className={css({ fontFamily: 'mono', fontSize: '9px', color: 'github.textMuted' })}>—</span>;
  const st = VERDICT_STYLE[ev.verdict] ?? VERDICT_STYLE.caution;
  const noEvidence = (ev.roundTrips ?? 0) === 0;
  return (
    <span className={css({ display: 'inline-flex', alignItems: 'center', gap: '4px', justifyContent: 'flex-end' })}>
      <span style={{ color: st.bg, borderColor: st.bg }} className={css({ fontFamily: 'label', fontSize: '8px', fontWeight: 'bold', border: '1px solid', borderRadius: '3px', paddingX: '3px', letterSpacing: '0.04em' })}>{st.label}</span>
      {noEvidence
        ? <span title="0 closed round-trips — verdict passed vacuously (no evidence)" className={css({ fontFamily: 'mono', fontSize: '8px', color: 'github.textMuted' })}>0tr⚠</span>
        : <span title={`${ev.roundTrips} closed round-trips${ev.addsPerTrip != null ? ` · ${ev.addsPerTrip.toFixed(1)} adds/trip` : ''}`} className={css({ fontFamily: 'mono', fontSize: '8px', color: 'github.textMuted' })}>{ev.roundTrips}tr</span>}
    </span>
  );
}

/** Column set — the trade/profit/risk story. `lowerBetter` flips the default sort dir. */
const COLUMNS: { key: SortKey; label: string; title: string; fmt: Fmt; lowerBetter?: boolean; cell?: (r: TopTraderRow, getEval: GetEval) => ReactNode }[] = [
  { key: 'composite', label: 'Score', title: 'Composite rating (0–10)', fmt: (r) => (r.composite == null ? '—' : r.composite.toFixed(0)) },
  { key: 'copyability', label: 'Copy', title: 'On-demand copyability verdict (follow/caution/avoid) + closed round-trips. Vet from a trader’s drawer.', fmt: () => '', cell: (r, getEval) => <CopyabilityCell row={r} getEval={getEval} /> },
  { key: 'totalReturn', label: 'Net Ret', title: 'Net-of-cost return', fmt: (r) => pct(r.metrics.totalReturn) },
  { key: 'winRate', label: 'Win%', title: 'Win rate', fmt: (r) => pct(r.metrics.winRate) },
  { key: 'medianHoldHours', label: 'Hold', title: 'Median round-trip hold (rough — see drawer)', fmt: (r) => hrs(r.metrics.medianHoldHours) },
  { key: 'maxDrawdownFrac', label: 'Max DD', title: 'Max drawdown (lower better)', fmt: (r) => pct(r.metrics.maxDrawdownFrac), lowerBetter: true },
  { key: 'medianAddDepth', label: 'Adds/Trip', title: 'Median adds per round-trip — high = averages down (uncopyable with a stop)', fmt: (r) => num(r.metrics.medianAddDepth), lowerBetter: true },
  { key: 'reserveMultiple', label: 'Reserve×', title: 'Dry powder vs typical position (risk discipline)', fmt: (r) => num(r.metrics.reserveMultiple) },
  { key: 'majorsShare', label: 'Majors', title: 'Share of activity in majors (conviction/concentration)', fmt: (r) => pct(r.metrics.majorsShare) },
  { key: 'nFills', label: 'Fills', title: 'Fills sampled (sample size)', fmt: (r) => int(r.metrics.nFills) },
];

function Chip({ label, title, active, disabled, onToggle }: { label: string; title: string; active: boolean; disabled?: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      data-testid="traders-table-filter-chip"
      aria-pressed={active}
      aria-disabled={disabled || undefined}
      disabled={disabled}
      title={title}
      onClick={disabled ? undefined : onToggle}
      style={active && !disabled ? { borderColor: '#5b8cff', color: '#e8ebf2', background: 'rgba(91,140,255,0.14)' } : undefined}
      className={css({
        fontFamily: 'mono', fontSize: '10px', letterSpacing: '0.02em', textTransform: 'uppercase',
        color: 'github.textMuted', bg: 'github.bg', border: '1px solid token(colors.github.borderSubtle)',
        borderRadius: '5px', padding: '3px 7px', cursor: disabled ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap',
        opacity: disabled ? 0.4 : 1,
        _hover: disabled ? {} : { borderColor: 'github.link', color: 'github.textBright' },
        _focusVisible: { outline: '2px solid token(colors.github.link)', outlineOffset: '1px' },
      })}
    >
      {label}
    </button>
  );
}

export default function TradersTable({ traders, followedAddress, ratings, onCopyPosition }: TradersTableProps) {
  const followed = followedAddress?.toLowerCase() ?? null;
  const fav = useFavorites();
  const { getEval } = useTraderEvaluations();
  const [selected, setSelected] = useState<TopTraderRow | null>(null);
  // The last trader whose drawer was opened — kept after close so the operator can
  // see which row they were just looking at (the "I can't remember which I opened"
  // fix). Lowercased to match the row key.
  const [lastViewed, setLastViewed] = useState<string | null>(null);
  const openTrader = (t: TopTraderRow) => { setSelected(t); setLastViewed(t.address.toLowerCase()); };
  const [sortKey, setSortKey] = useState<SortKey>('composite');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [filter, setFilter] = useState<TraderFilter>({ tradeableOnly: true });
  const [hasPosition, setHasPosition] = useState(false);
  const [search, setSearch] = useState('');
  const [visible, setVisible] = useState(PAGE);

  const ratingsDate = formatRatingsDate(ratings?.generatedAt);
  const stale = ratings?.stale ?? false;

  const leaderPositions = useLeaderPositionsTable();
  const holding = useMemo(() => buildHasTradeablePositionSet(leaderPositions.rows), [leaderPositions.rows]);

  const toggleFilter = (key: keyof TraderFilter) => {
    setFilter((f) => ({ ...f, [key]: !f[key] }));
    setVisible(PAGE);
  };

  const onSort = (key: SortKey) => {
    if (key === sortKey) setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    else {
      setSortKey(key);
      setSortDir(COLUMNS.find((c) => c.key === key)?.lowerBetter ? 'asc' : 'desc');
    }
  };

  const shown = useMemo(() => {
    let rows = filterTraders(traders, { ...filter, search }, fav.isFavorite, getEval);
    if (hasPosition && leaderPositions.loaded) rows = rows.filter((r) => holding.has(r.address.toLowerCase()));
    return sortTraders(rows, sortKey, sortDir, getEval);
    // Depend on fav.isFavorite (a useCallback keyed on the favorites Set, so its
    // identity changes when favorites change) rather than the whole useFavorites
    // object (a new literal each render that would defeat the memo). getEval is
    // likewise a useCallback keyed on the evals map.
  }, [traders, filter, search, fav.isFavorite, getEval, hasPosition, leaderPositions.loaded, holding, sortKey, sortDir]);

  const page = shown.slice(0, visible);

  return (
    <section
      data-testid="traders-table"
      className={css({ ...panelSurface, padding: '12px', display: 'flex', flexDirection: 'column', gap: '10px', minHeight: '0' })}
    >
      <div className={css({ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '8px' })}>
        <h2 className={css({ fontFamily: 'label', fontSize: 'sm', fontWeight: 'bold', color: 'github.textBright', textTransform: 'uppercase', letterSpacing: '0.06em' })}>
          Traders
        </h2>
        <span
          data-testid="ratings-freshness"
          title={stale ? `Ratings generated ${ratingsDate} — overdue` : `Ratings generated ${ratingsDate}`}
          style={stale ? { color: ZONE_COLORS.warn } : undefined}
          className={css({ fontFamily: 'mono', fontSize: '10px', color: 'github.textMuted', whiteSpace: 'nowrap', fontFeatureSettings: '"tnum"' })}
        >
          ratings · {ratingsDate}{stale ? ' · overdue' : ''}
        </span>
      </div>

      {/* Filter bar */}
      <div data-testid="traders-table-filters" role="group" aria-label="Trader filters" className={css({ display: 'flex', flexWrap: 'wrap', gap: '5px', alignItems: 'center' })}>
        <Chip label="★ Favorites" title="Only favorited traders (the live watch set)" active={!!filter.favoritesOnly} onToggle={() => toggleFilter('favoritesOnly')} />
        <Chip label="Tradeable" title="Only traders touching a tradeable market" active={!!filter.tradeableOnly} onToggle={() => toggleFilter('tradeableOnly')} />
        <Chip label="Hide risk" title="Hide wallets carrying a risk flag" active={!!filter.excludeRisk} onToggle={() => toggleFilter('excludeRisk')} />
        <Chip label="Vault" title="Only vault-backed names (the persistent copy signal)" active={!!filter.vaultOnly} onToggle={() => toggleFilter('vaultOnly')} />
        <Chip label="Hide thin" title="Hide under-sampled (< 50 fills) names" active={!!filter.excludeThin} onToggle={() => toggleFilter('excludeThin')} />
        <Chip label="Followable" title="Only vetted traders with verdict = FOLLOW (the copyable shortlist)" active={!!filter.followableOnly} onToggle={() => toggleFilter('followableOnly')} />
        <Chip label="Hide avoid" title="Hide vetted-AVOID names (averagers / blow-up shapes)" active={!!filter.hideAvoid} onToggle={() => toggleFilter('hideAvoid')} />
        <Chip label="Hide no-ev" title="Hide vetted names with 0 closed round-trips (verdict passed vacuously)" active={!!filter.hideNoEvidence} onToggle={() => toggleFilter('hideNoEvidence')} />
        <Chip
          label={leaderPositions.loaded ? 'Has position' : 'Has position…'}
          title={leaderPositions.loaded ? 'Only leaders currently holding a tradeable position' : 'Checking live positions…'}
          active={hasPosition}
          disabled={!leaderPositions.loaded}
          onToggle={() => { setHasPosition((v) => !v); setVisible(PAGE); }}
        />
        <input
          data-testid="traders-table-search"
          value={search}
          onChange={(e) => { setSearch(e.target.value); setVisible(PAGE); }}
          placeholder="search addr / name"
          aria-label="Search traders"
          className={css({ fontFamily: 'mono', fontSize: '10px', color: 'github.text', bg: 'github.bg', border: '1px solid token(colors.github.borderSubtle)', borderRadius: '5px', padding: '3px 7px', minWidth: '140px', _focusVisible: { outline: '2px solid token(colors.github.link)' } })}
        />
      </div>

      {page.length === 0 ? (
        <span data-testid="traders-table-empty" className={css({ fontSize: 'xs', color: 'github.textMuted', fontFamily: 'mono' })}>
          {traders.length === 0
            ? 'No rated wallets — run the rating pipeline.'
            : filter.favoritesOnly && fav.loading
              ? 'Loading favorites…'
              : 'No traders match the active filters.'}
        </span>
      ) : (
        <div className={css({ overflowX: 'auto', overflowY: 'auto', flex: '1 1 auto', minHeight: '0', maxHeight: { base: 'none', lg: '52vh' } })}>
          <table data-testid="traders-table-grid" className={css({ width: '100%', borderCollapse: 'collapse', fontFamily: 'mono', fontSize: '11px', minWidth: '720px' })}>
            <thead>
              <tr>
                <th scope="col" className={css({ textAlign: 'left', position: 'sticky', top: 0, left: 0, zIndex: 1, bg: 'github.bgSecondary', padding: '4px 6px', color: 'github.textMuted', fontSize: '9px', textTransform: 'uppercase', letterSpacing: '0.05em', borderBottom: '1px solid token(colors.github.border)' })}>
                  Trader
                </th>
                <th scope="col" aria-label="Favorite" className={css({ position: 'sticky', top: 0, bg: 'github.bgSecondary', borderBottom: '1px solid token(colors.github.border)', width: '24px' })} />
                {COLUMNS.map((c) => {
                  const activeSort = c.key === sortKey;
                  return (
                    <th
                      key={c.key}
                      scope="col"
                      aria-sort={activeSort ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
                      className={css({ position: 'sticky', top: 0, bg: 'github.bgSecondary', borderBottom: '1px solid token(colors.github.border)', padding: 0 })}
                    >
                      <button
                        type="button"
                        data-testid={`traders-sort-${c.key}`}
                        title={c.title}
                        aria-label={`${c.label}${activeSort ? `, sorted ${sortDir === 'asc' ? 'ascending' : 'descending'}` : ''}, activate to sort`}
                        onClick={() => onSort(c.key)}
                        style={activeSort ? { color: '#e8ebf2' } : undefined}
                        className={css({
                          width: '100%', textAlign: 'right', cursor: 'pointer', bg: 'transparent', border: 'none',
                          color: 'github.textMuted', fontFamily: 'mono', fontSize: '9px', fontWeight: 'bold',
                          textTransform: 'uppercase', letterSpacing: '0.04em', padding: '4px 6px', whiteSpace: 'nowrap',
                          _hover: { color: 'github.textBright' },
                          _focusVisible: { outline: '2px solid token(colors.github.link)', outlineOffset: '-2px' },
                        })}
                      >
                        {c.label}
                        {activeSort && <span aria-hidden>{sortDir === 'asc' ? ' ▲' : ' ▼'}</span>}
                      </button>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {page.map((t) => {
                const isFollowed = followed !== null && t.address.toLowerCase() === followed;
                const isFav = fav.isFavorite(t.address);
                const isLastViewed = lastViewed !== null && t.address.toLowerCase() === lastViewed;
                return (
                  <tr
                    key={t.address}
                    data-testid="traders-table-row"
                    data-followed={isFollowed}
                    data-last-viewed={isLastViewed || undefined}
                    onClick={() => openTrader(t)}
                    style={isLastViewed && !selected ? { boxShadow: 'inset 2px 0 0 0 #ffcb47' } : undefined}
                    className={css({ cursor: 'pointer', borderBottom: '1px solid token(colors.github.borderSubtle)', _hover: { bg: 'github.bg' } })}
                  >
                    <td className={css({ padding: '5px 6px', maxWidth: '220px', position: 'sticky', left: 0, bg: 'github.bgSecondary' })}>
                      <div className={css({ display: 'flex', alignItems: 'center', gap: '5px', minWidth: 0, flexWrap: 'wrap' })}>
                        {/* Name is a real button so keyboard/SR users can open the drawer
                            (the row's mouse onClick is a convenience layer on top). */}
                        <button
                          type="button"
                          data-testid="trader-open"
                          onClick={(e) => { e.stopPropagation(); openTrader(t); }}
                          aria-label={`Open detail for ${t.displayName ?? t.short}`}
                          style={isFollowed ? { color: '#5b8cff' } : undefined}
                          className={css({ bg: 'transparent', border: 'none', cursor: 'pointer', padding: 0, fontFamily: 'mono', fontSize: '11px', color: 'github.textBright', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '130px', textAlign: 'left', _hover: { textDecoration: 'underline' }, _focusVisible: { outline: '2px solid token(colors.github.link)', outlineOffset: '1px' } })}
                        >
                          {t.displayName ?? t.short}
                        </button>
                        {t.leaderboardTop && <span title="On the HL leaderboard" className={css({ color: 'github.link', fontSize: '9px' })}>★</span>}
                        {t.hasRisk && <span data-testid="badge-risk" title="Carries a risk flag" style={{ color: ZONE_COLORS.danger, borderColor: ZONE_COLORS.danger }} className={css({ fontSize: '8px', fontWeight: 'bold', border: '1px solid', borderRadius: '3px', paddingX: '3px' })}>RISK</span>}
                        {isVaultLed(t) && <span data-testid="badge-vault" title="Vault-backed — the one persistent copy signal" style={{ color: ZONE_COLORS.ok, borderColor: ZONE_COLORS.ok }} className={css({ fontSize: '8px', fontWeight: 'bold', border: '1px solid', borderRadius: '3px', paddingX: '3px' })}>VAULT</span>}
                        {isThinHistory(t) && <span data-testid="badge-thin" title="Under-sampled (< 50 fills) — low confidence" style={{ color: ZONE_COLORS.warn }} className={css({ fontSize: '8px' })}>thin</span>}
                        {t.topCoins.slice(0, 3).map((c) => (
                          <span key={c} title="Top traded coins" className={css({ fontFamily: 'mono', fontSize: '8px', color: 'github.textMuted' })}>{c}</span>
                        ))}
                      </div>
                    </td>
                    <td className={css({ padding: '0', textAlign: 'center' })}>
                      <button
                        type="button"
                        data-testid="favorite-star"
                        aria-label={isFav ? `Unfavorite ${t.short}` : `Favorite ${t.short}`}
                        aria-pressed={isFav}
                        onClick={(e) => { e.stopPropagation(); void fav.toggle(t.address).catch(() => {}); }}
                        style={{ color: isFav ? '#ffcb47' : GH.textMuted }}
                        className={css({ cursor: 'pointer', bg: 'transparent', border: 'none', fontSize: '13px', lineHeight: 1, padding: '4px', _hover: { color: '#ffcb47' }, _focusVisible: { outline: '2px solid token(colors.github.link)' } })}
                      >
                        {isFav ? '★' : '☆'}
                      </button>
                    </td>
                    {COLUMNS.map((c) => (
                      <td key={c.key} style={{ fontFeatureSettings: '"tnum"' }} className={css({ textAlign: 'right', padding: '5px 6px', color: 'github.text', whiteSpace: 'nowrap' })}>
                        {c.cell ? c.cell(t, getEval) : c.fmt(t)}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {shown.length > visible && (
        <button
          type="button"
          data-testid="traders-table-load-more"
          onClick={() => setVisible((v) => v + PAGE)}
          className={css({ fontFamily: 'mono', fontSize: '10px', color: 'github.link', bg: 'github.bg', border: '1px solid token(colors.github.borderSubtle)', borderRadius: '5px', padding: '5px', cursor: 'pointer', _hover: { borderColor: 'github.link' } })}
        >
          Load more ({shown.length - visible} more)
        </button>
      )}

      <LeaderActionFeed />

      {selected && (
        <TraderDetailDrawer
          trader={selected}
          onClose={() => setSelected(null)}
          isFavorite={fav.isFavorite(selected.address)}
          onToggleFavorite={() => void fav.toggle(selected.address).catch(() => {})}
          onCopyPosition={onCopyPosition}
        />
      )}
    </section>
  );
}
