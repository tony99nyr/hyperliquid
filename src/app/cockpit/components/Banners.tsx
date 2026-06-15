'use client';

/**
 * Cockpit banners — the always-visible posture cues:
 *   1. READ-ONLY decision-support: Claude advises; the human executes + confirms.
 *   2. Paper / live mode indicator (from TRADING_MODE, passed in from the RSC).
 *
 * These are deliberately loud + persistent so the operator can never mistake a
 * paper session for live (or forget that nothing here auto-executes).
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
        data-testid="banner-readonly"
        className={css({
          fontSize: 'xs',
          fontWeight: 'medium',
          color: 'github.text',
          bg: 'github.bgSecondary',
          border: '1px solid token(colors.github.border)',
          borderRadius: '6px',
          paddingX: '10px',
          paddingY: '4px',
        })}
      >
        Decision-support only — Claude advises; you execute & confirm every action.
      </span>

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
