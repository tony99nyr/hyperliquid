'use client';

/**
 * PnlHero — the big color-coded unrealized-P&L readout for the bottom bar: dollar
 * value + percent + ROE, green/red by sign, with a brief background flash each
 * time the value updates (so the operator's eye catches every tick). The flash
 * keyframes are removed under prefers-reduced-motion (panda globalCss).
 */

import { useEffect, useRef, useState } from 'react';
import { css } from '@styled-system/css';
import { GH, ZONE_COLORS, fmtUsd, fmtPctSigned } from '../panel-styles';

export interface PnlHeroProps {
  /** Unrealized P&L in USD (null while no mark). */
  pnlUsd: number | null;
  /** Unrealized P&L as a percent of notional (null when unknown). */
  pnlPct: number | null;
  /** Return on equity (leverage-adjusted), null when leverage unknown. */
  roePct: number | null;
}

export default function PnlHero({ pnlUsd, pnlPct, roePct }: PnlHeroProps) {
  const color = pnlUsd === null ? GH.textMuted : pnlUsd > 0 ? ZONE_COLORS.ok : pnlUsd < 0 ? ZONE_COLORS.danger : GH.textMuted;

  // Flash key: bump on every value change to retrigger the keyframe animation.
  const [flashKey, setFlashKey] = useState(0);
  const prev = useRef<number | null>(pnlUsd);
  const [dir, setDir] = useState<'up' | 'down' | null>(null);
  useEffect(() => {
    if (pnlUsd === null || prev.current === null) {
      prev.current = pnlUsd;
      return;
    }
    if (pnlUsd !== prev.current) {
      setDir(pnlUsd > prev.current ? 'up' : 'down');
      setFlashKey((k) => k + 1);
      prev.current = pnlUsd;
    }
  }, [pnlUsd]);

  return (
    <div
      key={flashKey}
      data-testid="pnl-hero"
      style={dir ? { animation: `${dir === 'up' ? 'flashUp' : 'flashDown'} 0.6s ease-out` } : undefined}
      className={css({ display: 'flex', flexDirection: 'column', gap: '2px', borderRadius: '6px', paddingX: '8px', paddingY: '4px', minWidth: '140px' })}
    >
      <span className={css({ fontFamily: 'label', fontSize: '9px', color: 'github.textMuted', textTransform: 'uppercase', letterSpacing: '0.06em' })}>
        Unrealized P&amp;L
      </span>
      <span
        data-testid="pnl-hero-usd"
        style={{ color, fontFeatureSettings: '"tnum"' }}
        className={css({ fontFamily: 'mono', fontSize: '28px', fontWeight: 'bold', lineHeight: '1' })}
      >
        {pnlUsd === null ? '—' : fmtUsd(pnlUsd)}
      </span>
      <span style={{ color, fontFeatureSettings: '"tnum"' }} className={css({ fontFamily: 'mono', fontSize: 'xs' })}>
        <span data-testid="pnl-hero-pct">{pnlPct === null ? '—' : fmtPctSigned(pnlPct)}</span>
        {roePct !== null && (
          <>
            {'  ·  ROE '}
            <span data-testid="pnl-hero-roe">{fmtPctSigned(roePct)}</span>
          </>
        )}
      </span>
    </div>
  );
}
