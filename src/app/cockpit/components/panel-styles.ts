/**
 * Shared panel styling helpers (PURE). Map domain values (health score, context
 * zone, alert severity, P&L sign) to the GitHub-dark / zone palette so the
 * islands stay declarative and the threshold logic is unit-testable.
 *
 * Colors are raw hex (matching panda.config tokens) so they can be used in both
 * `css()` and inline SVG/style attributes without a token round-trip.
 */

import type { AlertSeverity, ContextZone } from '@/types/cockpit';

export const ZONE_COLORS = {
  ok: '#3fb950',
  warn: '#d29922',
  danger: '#f85149',
} as const;

export const GH = {
  bg: '#0d1117',
  bgSecondary: '#161b22',
  border: '#30363d',
  borderSubtle: '#21262d',
  text: '#c9d1d9',
  textBright: '#e6edf3',
  textMuted: '#7d8590',
} as const;

/**
 * Map a 0–100 health score to a zone. Higher = healthier:
 *   score ≥ 60 → ok, 35 ≤ score < 60 → warn, score < 35 → danger.
 */
export function healthZone(score: number): ContextZone {
  if (score >= 60) return 'ok';
  if (score >= 35) return 'warn';
  return 'critical';
}

/** Color for a health score (via healthZone; 'critical' maps to danger). */
export function healthColor(score: number): string {
  const zone = healthZone(score);
  return zone === 'ok' ? ZONE_COLORS.ok : zone === 'warn' ? ZONE_COLORS.warn : ZONE_COLORS.danger;
}

/** Color for a context-budget zone. */
export function contextZoneColor(zone: ContextZone): string {
  return zone === 'ok' ? ZONE_COLORS.ok : zone === 'warn' ? ZONE_COLORS.warn : ZONE_COLORS.danger;
}

/** Color for an analysis-log / alert severity. */
export function severityColor(severity: AlertSeverity): string {
  return severity === 'danger'
    ? ZONE_COLORS.danger
    : severity === 'warn'
      ? ZONE_COLORS.warn
      : GH.textMuted;
}

/** Color for a signed P&L value (green up / red down / muted flat). */
export function pnlColor(value: number): string {
  if (value > 0) return ZONE_COLORS.ok;
  if (value < 0) return ZONE_COLORS.danger;
  return GH.textMuted;
}

/** Format a USD value with sign + 2dp (e.g. "+$12.34", "−$5.00"). */
export function fmtUsd(value: number): string {
  const sign = value < 0 ? '−' : value > 0 ? '+' : '';
  return `${sign}$${Math.abs(value).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** Format a price (no sign), variable precision for small vs large values. */
export function fmtPx(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  const digits = value >= 1000 ? 2 : value >= 1 ? 3 : 5;
  return `$${value.toLocaleString('en-US', { maximumFractionDigits: digits })}`;
}

/** Format a probability (0–1) as a percent. */
export function fmtPct(value: number, digits = 0): string {
  return `${(value * 100).toFixed(digits)}%`;
}

/** Human label for a discrete health-alert code. */
export function alertLabel(code: string): string {
  return code
    .replace(/-/g, ' ')
    .replace(/\b1h\b/i, '1H')
    .replace(/\b8h\b/i, '8H')
    .replace(/\b15m\b/i, '15m')
    .replace(/\bATR\b/i, 'ATR')
    .replace(/^./, (c) => c.toUpperCase());
}
