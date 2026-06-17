'use client';

/**
 * AlertChip — a single color-coded alert chip for a fired health-alert code.
 * Danger alerts (regime-flip-8h, stop-within-1-ATR, decline-detected, drawdown)
 * read red; everything else reads amber. Used in the right-rail Trade Health
 * block as a compact chip row rather than the old bullet list.
 */

import { css } from '@styled-system/css';
import { alertLabel, ZONE_COLORS } from '../panel-styles';

/** Alert codes that should read as danger (vs amber warn). */
const DANGER_ALERTS = new Set([
  'regime-flip-8h',
  'stop-within-1-ATR',
  'decline-detected',
  'drawdown',
]);

export function alertChipColor(code: string): string {
  return DANGER_ALERTS.has(code) ? ZONE_COLORS.danger : ZONE_COLORS.warn;
}

export interface AlertChipProps {
  code: string;
}

export default function AlertChip({ code }: AlertChipProps) {
  const color = alertChipColor(code);
  return (
    <span
      data-testid="alert-chip"
      data-alert={code}
      style={{ color, borderColor: color, background: `${color}1a` }}
      className={css({
        fontFamily: 'mono',
        fontSize: '10px',
        fontWeight: 'bold',
        border: '1px solid',
        borderRadius: '4px',
        paddingX: '6px',
        paddingY: '2px',
        whiteSpace: 'nowrap',
      })}
    >
      {alertLabel(code)}
    </span>
  );
}
