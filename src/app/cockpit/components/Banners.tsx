'use client';

/**
 * Cockpit banners — the always-visible posture cue:
 *   - Paper / live mode indicator (from TRADING_MODE, passed in from the RSC).
 *
 * Deliberately loud + persistent so the operator can never mistake a paper
 * session for live. (The old "decision-support only" disclaimer was removed —
 * the cockpit now supports self-service execution; NO-AUTO-FIRE is still
 * enforced everywhere, but the operator does execute in-app.)
 */

import { css } from '@styled-system/css';
import type { TradingMode } from '@/types/fill';
import { ZONE_COLORS } from './panel-styles';

export interface BannersProps {
  mode: TradingMode;
}

export default function Banners({ mode }: BannersProps) {
  const live = mode === 'live';
  return (
    <div
      data-testid="banners"
      className={css({ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' })}
    >
      <span
        data-testid="banner-mode"
        data-mode={mode}
        style={{ color: live ? ZONE_COLORS.danger : ZONE_COLORS.ok, borderColor: live ? ZONE_COLORS.danger : ZONE_COLORS.ok }}
        className={css({
          fontSize: 'xs',
          fontWeight: 'bold',
          fontFamily: 'mono',
          textTransform: 'uppercase',
          border: '1px solid',
          borderRadius: '6px',
          paddingX: '10px',
          paddingY: '4px',
        })}
      >
        {live ? '● LIVE TRADING' : '○ PAPER MODE'}
      </span>
    </div>
  );
}
