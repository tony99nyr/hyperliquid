/** Read-only: builds filled live event-straddle legs from ladders, ladder_rungs and ladder_outcomes. */
import { supabaseSelect } from './_study-io';
import { isEventStraddle } from '@/lib/performance/lane-performance-business-logic';
import type { StraddleLeg } from '@/lib/backtest/dvol-straddle-filter-business-logic';

const PRINT_LEAD_MS = 15 * 60_000;

const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const finite = (value: unknown): number | null => {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value !== '' ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
};

export interface StraddleLegReport { legs: StraddleLeg[]; notes: string[] }

/**
 * Print time = active_from + 15 minutes. The event template opens the window
 * 15 minutes before the print (migration 0034 and the template theses). A leg
 * without active_from has no recorded print time and is skipped.
 */
export async function loadStraddleLegs(): Promise<StraddleLegReport> {
  const [ladders, outcomes] = await Promise.all([
    supabaseSelect('ladders', 'id,title,mode,oco_group_id,active_from', { mode: 'eq.live' }),
    supabaseSelect('ladder_outcomes', 'ladder_id,coin,mode,outcome,planned_risk_usd,realized_pnl_usd,realized_r', { mode: 'eq.live' }),
  ]);
  const groups = new Map<string, number>();
  for (const row of ladders) {
    const group = text(row.oco_group_id);
    if (group) groups.set(group, (groups.get(group) ?? 0) + 1);
  }
  const straddles = new Map(ladders.filter((row) => isEventStraddle(
    { id: text(row.id), title: text(row.title), oco_group_id: text(row.oco_group_id) || null, mode: text(row.mode) }, groups,
  )).map((row) => [text(row.id), row]));
  const notes: string[] = [`${straddles.size} live event-straddle ladders found by the existing isEventStraddle rule`];
  const legs: StraddleLeg[] = [];
  let unfilled = 0, noPrint = 0, otherCoin = 0, noR = 0;
  for (const outcome of outcomes) {
    const ladder = straddles.get(text(outcome.ladder_id));
    if (!ladder) continue;
    if (!['won', 'lost', 'scratch'].includes(text(outcome.outcome))) { unfilled++; continue; }
    const coin = text(outcome.coin).toUpperCase();
    if (coin !== 'BTC' && coin !== 'ETH') { otherCoin++; continue; }
    const activeFrom = Date.parse(text(ladder.active_from));
    if (!Number.isFinite(activeFrom)) { noPrint++; continue; }
    const risk = finite(outcome.planned_risk_usd);
    const pnl = finite(outcome.realized_pnl_usd);
    const netR = finite(outcome.realized_r) ?? (risk && risk > 0 && pnl !== null ? pnl / risk : null);
    if (netR === null || risk === null || risk <= 0) { noR++; continue; }
    legs.push({ eventId: text(ladder.oco_group_id), coin, printAtMs: activeFrom + PRINT_LEAD_MS, netR, riskUsd: risk });
  }
  notes.push(`legs kept ${legs.length}; skipped: ${unfilled} never filled or open, ${noPrint} without active_from, ${otherCoin} not BTC or ETH, ${noR} without usable net R`);
  return { legs, notes };
}
