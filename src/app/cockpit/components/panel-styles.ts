/**
 * Shared panel styling helpers (PURE). Map domain values (health score, context
 * zone, alert severity, P&L sign) to the GitHub-dark / zone palette so the
 * islands stay declarative and the threshold logic is unit-testable.
 *
 * Colors are raw hex (matching panda.config tokens) so they can be used in both
 * `css()` and inline SVG/style attributes without a token round-trip.
 */

import type { AlertSeverity, ContextZone } from '@/types/cockpit';

// HL COCKPIT design-handoff palette. Raw hex (matching panda.config tokens) so
// these can be used in both `css()` and inline SVG/style attributes without a
// token round-trip. up/long/profit #19c98a · down/short/loss #f24d5e · warn #d9a441.
export const ZONE_COLORS = {
  ok: '#19c98a',
  warn: '#d9a441',
  danger: '#f24d5e',
} as const;

export const GH = {
  bg: '#080a0f', // page void
  bgSecondary: '#10141c', // panel surface
  border: 'rgba(255,255,255,0.07)', // card borders
  borderSubtle: 'rgba(255,255,255,0.06)', // inner dividers
  text: '#cdd4e0', // secondary text
  textBright: '#e8ebf2', // primary text
  // muted micro-label color (≥4.5:1 on the dark surfaces for 9–11px labels).
  textMuted: '#8b95a6',
} as const;

/**
 * Cockpit terminal palette — the layered near-black surfaces of the design
 * handoff plus the single interactive accent (#5b8cff). Sharp color is reserved
 * for meaning (P&L / health / alerts); chrome stays monochrome.
 */
export const TERM = {
  /** Deepest layer (the page void behind panels). */
  void: '#080a0f',
  /** Top/bottom bars. */
  bar: '#0b0e15',
  /** Panel surface. */
  surface: '#10141c',
  /** Focal (brighter) panel surface — Open Positions, stat cards. */
  focal: '#11161f',
  /** Inset / field background — inputs, summary boxes. */
  inset: '#0a0d13',
  /** Raised surface (rows, cells). */
  raised: '#0c1017',
  /** Idle nav / timeframe container. */
  navIdle: '#0e131c',
  /** Active nav / timeframe pill. */
  navActive: '#1c2536',
  /** Secondary button surface. */
  button: '#161c27',
  /** Hairline between surfaces. */
  hairline: 'rgba(255,255,255,0.06)',
  /** Faint meta / axis / captions. */
  faint: '#586273',
  /** Interactive / link accent (= MA20). */
  accent: '#5b8cff',
  /** MA50 / warning. */
  ma50: '#d9a441',
  /** Bright exit CTA red. */
  safeExit: '#e23a4d',
  /** Text on bright buttons. */
  darkText: '#0a0d13',
} as const;

/** Shared panel chrome — a panel surface with a hairline border (12px radius). */
export const panelSurface = {
  bg: 'github.bgSecondary',
  border: '1px solid token(colors.github.border)',
  borderRadius: '12px',
} as const;

/** Color for a market regime (bullish green / bearish red / neutral muted). */
export function regimeColor(regime: 'bullish' | 'bearish' | 'neutral'): string {
  if (regime === 'bullish') return ZONE_COLORS.ok;
  if (regime === 'bearish') return ZONE_COLORS.danger;
  return GH.textMuted;
}

/** Three-letter regime glyph for dense strips (BUL / BER / NEU). */
export function regimeAbbrev(regime: 'bullish' | 'bearish' | 'neutral'): string {
  return regime === 'bullish' ? 'BULL' : regime === 'bearish' ? 'BEAR' : 'NEU';
}

/** Compact USD (e.g. "$1.2k", "$3.4M") for dense notional cells (no sign). */
export function fmtCompactUsd(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(value / 1_000).toFixed(1)}k`;
  return `$${value.toFixed(2)}`;
}

/** Format a signed percent (e.g. "+4.21%", "−1.50%"). */
export function fmtPctSigned(value: number, digits = 2): string {
  const sign = value < 0 ? '−' : value > 0 ? '+' : '';
  return `${sign}${Math.abs(value).toFixed(digits)}%`;
}

/**
 * Map a 0–100 health score to a zone. Higher = healthier:
 *   score ≥ 60 → ok, 35 ≤ score < 60 → warn, score < 35 → danger.
 */
export function healthZone(score: number): ContextZone {
  if (score >= 60) return 'ok';
  if (score >= 35) return 'warn';
  return 'critical';
}

/**
 * Letter grade for a 0–100 health score (A best → F worst). A graded score reads
 * faster than a bare number for the at-a-glance Trade Health hero.
 */
export function healthGrade(score: number): string {
  const s = Math.max(0, Math.min(100, score));
  if (s >= 85) return 'A';
  if (s >= 70) return 'B';
  if (s >= 55) return 'C';
  if (s >= 40) return 'D';
  return 'F';
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
