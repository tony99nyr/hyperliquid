'use client';

/**
 * FavoritePlaysBoard — the repurposed Opportunities panel. Instead of our own rubric
 * signals it surfaces what FAVORITED traders are doing: NEW opens (headline) and
 * PROFITABLE holds (secondary, extension-gated). Discretionary by design — it's an
 * opportunity feed the operator reads + acts on at their judgement, not a signal to
 * chase (each profitable play shows how EXTENDED it is past the leader's entry).
 */

import { useState } from 'react';
import { css } from '@styled-system/css';
import { useFavoritePlays } from '@/hooks/useFavoritePlays';
import { isOverExtended, type FavoritePlay } from '@/lib/cockpit/favorite-plays-business-logic';
import { GH, ZONE_COLORS, panelSurface, fmtUsd, fmtPx } from '../panel-styles';

function shortAddr(a: string): string {
  return a.length > 10 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}
function ago(ms: number | null, nowMs: number): string {
  if (ms == null) return '';
  const s = Math.max(0, Math.round((nowMs - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

function PlayCard({ play, nowMs }: { play: FavoritePlay; nowMs: number }) {
  const sideColor = play.side === 'long' ? ZONE_COLORS.ok : ZONE_COLORS.danger;
  const extended = isOverExtended(play);
  return (
    <li data-testid="favorite-play" className={css({ listStyle: 'none', bg: 'github.bg', border: '1px solid token(colors.github.borderSubtle)', borderRadius: '6px', padding: '7px 9px', display: 'flex', flexDirection: 'column', gap: '3px' })}>
      <div className={css({ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '8px' })}>
        <span className={css({ display: 'flex', alignItems: 'baseline', gap: '6px', minWidth: 0 })}>
          <span style={{ color: sideColor }} className={css({ fontFamily: 'label', fontSize: '10px', fontWeight: 'bold', letterSpacing: '0.04em' })}>{play.side.toUpperCase()}</span>
          <span className={css({ fontFamily: 'mono', fontSize: 'xs', color: 'github.textBright', fontWeight: 'bold' })}>{play.coin}</span>
          <span title={play.leaderAddress} className={css({ fontFamily: 'mono', fontSize: '9px', color: 'github.textMuted' })}>{shortAddr(play.leaderAddress)}</span>
        </span>
        {play.kind === 'new' ? (
          <span className={css({ fontFamily: 'mono', fontSize: '9px', color: 'github.textMuted' })}>{ago(play.detectedAtMs, nowMs)}</span>
        ) : (
          <span style={{ color: play.unrealizedPnl != null && play.unrealizedPnl >= 0 ? ZONE_COLORS.ok : ZONE_COLORS.danger, fontFeatureSettings: '"tnum"' }} className={css({ fontFamily: 'mono', fontSize: 'xs', fontWeight: 'bold' })}>{play.unrealizedPnl != null ? fmtUsd(play.unrealizedPnl) : '—'}</span>
        )}
      </div>
      <div className={css({ display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'baseline' })}>
        <span style={{ fontFeatureSettings: '"tnum"' }} className={css({ fontFamily: 'mono', fontSize: '9px', color: 'github.textMuted' })}>entry {fmtPx(play.entryPx)}</span>
        {play.markPx != null && <span style={{ fontFeatureSettings: '"tnum"' }} className={css({ fontFamily: 'mono', fontSize: '9px', color: 'github.textMuted' })}>mark {fmtPx(play.markPx)}</span>}
        {play.extendedPct != null && (
          <span
            data-testid="play-extended"
            title={`${play.extendedPct.toFixed(1)}% past the leader's entry — the more extended, the later (and riskier) it is to chase`}
            style={{ color: extended ? ZONE_COLORS.warn : GH.textMuted, fontFeatureSettings: '"tnum"' }}
            className={css({ fontFamily: 'mono', fontSize: '9px', fontWeight: extended ? 'bold' : 'normal' })}
          >
            {play.extendedPct >= 0 ? '+' : ''}{play.extendedPct.toFixed(1)}% extended{extended ? ' ⚠' : ''}
          </span>
        )}
      </div>
    </li>
  );
}

export default function FavoritePlaysBoard() {
  const { newPlays, profitablePlays, nowMs, loading, noFavorites } = useFavoritePlays();
  const [showExtended, setShowExtended] = useState(false);

  const shownProfitable = showExtended ? profitablePlays : profitablePlays.filter((p) => !isOverExtended(p));
  const hiddenExtended = profitablePlays.length - shownProfitable.length;

  return (
    <section data-testid="favorite-plays-board" className={css({ ...panelSurface, padding: '12px', display: 'flex', flexDirection: 'column', gap: '10px', minHeight: 0 })}>
      <div className={css({ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '8px' })}>
        <h2 className={css({ fontFamily: 'label', fontSize: 'sm', fontWeight: 'bold', color: 'github.textBright', textTransform: 'uppercase', letterSpacing: '0.06em' })}>Favorites&apos; Plays</h2>
        <span className={css({ fontFamily: 'mono', fontSize: '9px', color: 'github.textMuted' })}>what your traders are doing</span>
      </div>

      {noFavorites ? (
        <span data-testid="favorite-plays-empty" className={css({ fontFamily: 'mono', fontSize: 'xs', color: 'github.textMuted', lineHeight: 1.4 })}>
          Favorite traders (★ in the Traders tab) to see their new opens + profitable holds here.
        </span>
      ) : loading ? (
        <span className={css({ fontFamily: 'mono', fontSize: 'xs', color: 'github.textMuted' })}>loading plays…</span>
      ) : newPlays.length === 0 && profitablePlays.length === 0 ? (
        <span data-testid="favorite-plays-none" className={css({ fontFamily: 'mono', fontSize: 'xs', color: 'github.textMuted' })}>No new opens or profitable holds from your favorites right now.</span>
      ) : (
        <>
          <span className={css({ fontFamily: 'label', fontSize: '9px', color: 'github.textMuted', textTransform: 'uppercase', letterSpacing: '0.06em' })}>New opens</span>
          {newPlays.length === 0 ? (
            <span className={css({ fontFamily: 'mono', fontSize: '10px', color: 'github.textMuted' })}>none in the last 6h</span>
          ) : (
            <ul className={css({ display: 'flex', flexDirection: 'column', gap: '6px', margin: 0, padding: 0 })}>
              {newPlays.map((p) => <PlayCard key={`new-${p.id}`} play={p} nowMs={nowMs} />)}
            </ul>
          )}

          <span className={css({ fontFamily: 'label', fontSize: '9px', color: 'github.textMuted', textTransform: 'uppercase', letterSpacing: '0.06em', marginTop: '4px' })}>Profitable holds</span>
          {shownProfitable.length === 0 ? (
            <span className={css({ fontFamily: 'mono', fontSize: '10px', color: 'github.textMuted' })}>none{hiddenExtended > 0 ? ` — all ${hiddenExtended} are extended (chase-risk)` : ''}</span>
          ) : (
            <ul className={css({ display: 'flex', flexDirection: 'column', gap: '6px', margin: 0, padding: 0 })}>
              {shownProfitable.map((p) => <PlayCard key={`prof-${p.id}`} play={p} nowMs={nowMs} />)}
            </ul>
          )}
          {hiddenExtended > 0 && (
            <button
              type="button"
              data-testid="favorite-plays-toggle-extended"
              aria-pressed={showExtended}
              onClick={() => setShowExtended((v) => !v)}
              className={css({ alignSelf: 'flex-start', fontFamily: 'mono', fontSize: '9px', color: 'github.link', bg: 'transparent', border: 'none', cursor: 'pointer', padding: 0, _hover: { textDecoration: 'underline' }, _focusVisible: { outline: '2px solid token(colors.github.link)' } })}
            >
              {showExtended ? 'hide extended' : `show ${hiddenExtended} extended (chase-risk)`}
            </button>
          )}
        </>
      )}
    </section>
  );
}
