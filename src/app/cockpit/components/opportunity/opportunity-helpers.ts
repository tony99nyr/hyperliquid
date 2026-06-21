/**
 * PURE helpers for the Opportunity view. All threshold/format/derivation logic
 * lives here (zero DOM) so it is fixture-testable. The cards/board/whale-posture
 * are thin renderers over these. Numbers-first, honest uncertainty: scores are
 * integers + a band (never raw decimals), confidence is dots, NO-EDGE is CALM
 * (muted, not danger), stale data is flagged.
 */

import { ZONE_COLORS, GH } from '../panel-styles';
import type { RubricScoreUiRow, LeaderPositionRow, LeaderActionRow } from '@/hooks/realtime-row-mappers';

export type Badge = 'GO' | 'WATCH' | 'NO-EDGE';

/** Default staleness window: the rubric scans ~5min on the NAS, so >20min is stale. */
export const RUBRIC_STALE_MS = 20 * 60 * 1000;

/** Per-coin card model: the chosen (or stronger) side to display + both sides. */
export interface OpportunityCardModel {
  coin: string;
  badge: Badge;
  chosenSide: 'long' | 'short' | 'none';
  noTradeReason: string | null;
  confidence: number;
  computedAt: number;
  display: RubricScoreUiRow;
  long?: RubricScoreUiRow;
  short?: RubricScoreUiRow;
}

/** Group rubric rows (one per coin×side) into one card model per coin. */
export function toCardModels(rows: RubricScoreUiRow[], order: string[] = []): OpportunityCardModel[] {
  // rubric_scores accumulates history (many rows per coin×side), so keep the
  // NEWEST row per side regardless of input order — never show a stale read.
  const byCoin = new Map<string, { long?: RubricScoreUiRow; short?: RubricScoreUiRow }>();
  for (const r of rows) {
    const e = byCoin.get(r.coin) ?? {};
    const cur = e[r.side];
    if (!cur || r.computedAt > cur.computedAt) e[r.side] = r;
    byCoin.set(r.coin, e);
  }
  const models: OpportunityCardModel[] = [];
  for (const [coin, { long, short }] of byCoin) {
    const any = long ?? short;
    if (!any) continue;
    const display =
      any.chosenSide === 'long' && long ? long : any.chosenSide === 'short' && short ? short : (long && short ? (long.opportunity >= short.opportunity ? long : short) : any);
    models.push({
      coin,
      badge: any.badge,
      chosenSide: any.chosenSide,
      noTradeReason: any.noTradeReason,
      confidence: any.confidence,
      computedAt: Math.max(long?.computedAt ?? 0, short?.computedAt ?? 0),
      display,
      long,
      short,
    });
  }
  const rank = (c: string) => {
    const i = order.indexOf(c);
    return i === -1 ? order.length + 1 : i;
  };
  return models.sort((a, b) => rank(a.coin) - rank(b.coin) || a.coin.localeCompare(b.coin));
}

/** Badge styling. NO-EDGE is intentionally CALM (muted), not an error color. */
export function badgeMeta(badge: Badge): { label: string; color: string; muted: boolean } {
  if (badge === 'GO') return { label: 'GO', color: ZONE_COLORS.ok, muted: false };
  if (badge === 'WATCH') return { label: 'WATCH', color: ZONE_COLORS.warn, muted: false };
  return { label: 'NO EDGE', color: GH.textMuted, muted: true };
}

export function directionMeta(side: 'long' | 'short' | 'none'): { label: string; color: string } {
  if (side === 'long') return { label: 'LONG', color: ZONE_COLORS.ok };
  if (side === 'short') return { label: 'SHORT', color: ZONE_COLORS.danger };
  return { label: '—', color: GH.textMuted };
}

/** Pillar value (0–100, 50=neutral) → color. >60 good, <40 weak, else muted. */
export function pillarColor(value: number): string {
  if (value >= 60) return ZONE_COLORS.ok;
  if (value <= 40) return ZONE_COLORS.danger;
  return GH.textMuted;
}

export interface PillarSegment {
  key: 'regime' | 'leaders' | 'carry' | 'micro';
  label: string;
  value: number;
  color: string;
}

export function pillarSegments(row: RubricScoreUiRow): PillarSegment[] {
  const mk = (key: PillarSegment['key'], label: string, value: number): PillarSegment => ({
    key,
    label,
    value: Math.round(value),
    color: pillarColor(value),
  });
  return [
    mk('regime', 'RGM', row.pillarRegime),
    mk('leaders', 'LDR', row.pillarLeaders),
    mk('carry', 'CAR', row.pillarCarry),
    mk('micro', 'MIC', row.pillarMicro),
  ];
}

/** Confidence (0–1) → integer dots 0–5 (honest, not a decimal). */
export function confidenceDots(confidence: number): number {
  return Math.max(0, Math.min(5, Math.round(confidence * 5)));
}

export function isStale(computedAt: number, now: number, ttlMs = RUBRIC_STALE_MS): boolean {
  return now - computedAt > ttlMs;
}

/** Score as an integer + a ± band string (no false precision). */
export function formatScore(opportunity: number, bandLow: number, bandHigh: number): { score: string; band: string } {
  const half = Math.round((bandHigh - bandLow) / 2);
  return { score: String(Math.round(opportunity)), band: half > 0 ? `±${half}` : '' };
}

/** Structured snapshot the "ask Claude" chip carries into a deep-dive / entry. */
export function buildAskClaudeSnapshot(m: OpportunityCardModel): Record<string, unknown> {
  const d = m.display;
  return {
    coin: m.coin,
    badge: m.badge,
    side: m.chosenSide,
    score: d.opportunity,
    pillars: { regime: d.pillarRegime, leaders: d.pillarLeaders, carry: d.pillarCarry, micro: d.pillarMicro },
    levels: { entryLow: d.entryLow, entryHigh: d.entryHigh, invalidation: d.invalidation, target: d.target },
    noTradeReason: m.noTradeReason,
    confidence: m.confidence,
  };
}

// --- Whale / leader posture ---

export interface WhalePostureRow {
  coin: string;
  longCount: number;
  shortCount: number;
  /** Net direction by notional. */
  netSide: 'long' | 'short' | 'flat';
  netNotionalUsd: number;
  /** Recent reduce/close/flip events (de-risking signal). */
  coveringCount: number;
}

const COVERING_KINDS = new Set(['reduce', 'close', 'flip']);

/** Summarize leader posture per coin from positions + recent actions. PURE. */
export function summarizeWhalePosture(
  positions: LeaderPositionRow[],
  actions: LeaderActionRow[],
  coins: string[],
): WhalePostureRow[] {
  const want = new Set(coins.map((c) => c.toUpperCase()));
  const acc = new Map<string, WhalePostureRow>();
  for (const c of coins) {
    acc.set(c.toUpperCase(), { coin: c.toUpperCase(), longCount: 0, shortCount: 0, netSide: 'flat', netNotionalUsd: 0, coveringCount: 0 });
  }
  for (const p of positions) {
    const coin = p.coin.toUpperCase();
    if (!want.has(coin)) continue;
    const row = acc.get(coin)!;
    if (p.side === 'long') {
      row.longCount++;
      row.netNotionalUsd += p.positionValue;
    } else {
      row.shortCount++;
      row.netNotionalUsd -= p.positionValue;
    }
  }
  for (const a of actions) {
    const coin = a.coin.toUpperCase();
    if (want.has(coin) && COVERING_KINDS.has(a.kind)) acc.get(coin)!.coveringCount++;
  }
  for (const row of acc.values()) {
    row.netSide = row.netNotionalUsd > 0 ? 'long' : row.netNotionalUsd < 0 ? 'short' : 'flat';
  }
  return coins.map((c) => acc.get(c.toUpperCase())!);
}
