/**
 * Inline SVG warning triangle for the cockpit's danger callouts.
 *
 * Font-independent by design: it renders identically on machines WITHOUT a
 * color-emoji font (where a ⚠️ emoji degrades to a tofu box). Decorative —
 * adjacent danger-colored text carries the meaning — so it is aria-hidden.
 */

import { ZONE_COLORS } from './panel-styles';

export function WarningTriangle() {
  return (
    <svg
      data-testid="liq-warning-icon"
      aria-hidden
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      style={{ flex: 'none', marginTop: '1px' }}
    >
      <path
        d="M8 1.5 L15 14 H1 Z"
        fill="rgba(248,81,73,0.18)"
        stroke={ZONE_COLORS.danger}
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <rect x="7.25" y="6" width="1.5" height="4" rx="0.75" fill={ZONE_COLORS.danger} />
      <rect x="7.25" y="11" width="1.5" height="1.5" rx="0.75" fill={ZONE_COLORS.danger} />
    </svg>
  );
}
