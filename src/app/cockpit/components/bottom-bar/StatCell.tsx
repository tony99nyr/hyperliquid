'use client';

/**
 * StatCell — a dense labeled numeric cell for the bottom Active-Position bar.
 * Archivo uppercase micro-label over a JetBrains-Mono tabular value. Optional
 * color override (for side, leverage, etc.). Kept tiny so the bar reads as a
 * row of HL-style position numerics.
 */

import { css } from '@styled-system/css';
import { GH } from '../panel-styles';

export interface StatCellProps {
  label: string;
  value: string;
  color?: string;
  testid?: string;
}

export default function StatCell({ label, value, color, testid }: StatCellProps) {
  return (
    <div className={css({ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: '0' })}>
      <span className={css({ fontFamily: 'label', fontSize: '9px', color: 'github.textMuted', textTransform: 'uppercase', letterSpacing: '0.06em', whiteSpace: 'nowrap' })}>
        {label}
      </span>
      <span
        data-testid={testid}
        style={{ color: color ?? GH.textBright, fontFeatureSettings: '"tnum"' }}
        className={css({ fontFamily: 'mono', fontSize: 'sm', fontWeight: 'semibold', whiteSpace: 'nowrap' })}
      >
        {value}
      </span>
    </div>
  );
}
