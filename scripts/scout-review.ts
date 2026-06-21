/**
 * pnpm scout:review — the deterministic scorecard for the paper scout.
 *
 * NEVER trades + NEVER edits the playbook. It reads the scout's paper ledger
 * (fills / positions / resolved hypotheses) and prints the ONE honest number the
 * pre-registered bar is judged on: net P&L after the modeled funding + slippage
 * haircut, projected to a monthly run-rate, with a kill/continue/graduate verdict.
 *
 * The `scout-review` SKILL then has an Opus session READ this scorecard + the
 * track record and CURATE `docs/scout/playbook.md` (the learning-loop curation
 * step). The scoring is here (deterministic); the curation is the model's.
 */

import { header, line, run } from './_skill-runtime';
import { getServiceRoleClient } from '@/lib/cockpit/supabase-server';
import { buildScorecard, type ScorecardInput } from '@/lib/scout/scout-review-business-logic';

const ASSUMED_FUNDING_APR = 0.15; // conservative magnitude; precise per-trade funding is Phase-1.5
const HOURS_PER_YEAR = 365 * 24;

interface FillRow {
  coin: string;
  side: string;
  notional_usd: number;
  reduce_only: boolean;
  filled_at: string;
}

/** Pair fills per coin into round-trips → entry notional + holding hours (estimate). */
function estimateFromFills(fills: FillRow[]): { totalEntryNotionalUsd: number; fundingHaircutUsd: number; earliestMs: number } {
  let totalEntryNotionalUsd = 0;
  let fundingHaircutUsd = 0;
  let earliestMs = Number.POSITIVE_INFINITY;

  const byCoin = new Map<string, FillRow[]>();
  for (const f of fills) {
    const t = new Date(f.filled_at).getTime();
    if (Number.isFinite(t)) earliestMs = Math.min(earliestMs, t);
    const arr = byCoin.get(f.coin) ?? [];
    arr.push(f);
    byCoin.set(f.coin, arr);
  }

  for (const [, rows] of byCoin) {
    rows.sort((a, b) => new Date(a.filled_at).getTime() - new Date(b.filled_at).getTime());
    // Track signed direction so adds extend, opposing fills reduce/close, and a
    // FLIP (close past zero) correctly closes the old leg then opens a new one —
    // bucketing by coin alone (ignoring side) mispairs flips. Funding is modeled
    // as a CONSERVATIVE cost on the held notional regardless of side (precise
    // signed per-period funding is the Phase-1.5 refinement).
    let dir = 0; // +1 long, -1 short, 0 flat
    let notional = 0;
    let openAtMs = 0;
    for (const f of rows) {
      const t = new Date(f.filled_at).getTime();
      const fdir = f.side === 'buy' ? 1 : -1;
      if (dir === 0) {
        dir = fdir;
        notional = f.notional_usd;
        openAtMs = t;
        totalEntryNotionalUsd += f.notional_usd;
      } else if (fdir === dir) {
        notional += f.notional_usd; // add to the position
        totalEntryNotionalUsd += f.notional_usd;
      } else {
        // opposing fill — reduce/close the open leg (accrue funding on closed notional)
        const closed = Math.min(notional, f.notional_usd);
        const holdingHours = Math.max(0, (t - openAtMs) / 3_600_000);
        fundingHaircutUsd += closed * (ASSUMED_FUNDING_APR / HOURS_PER_YEAR) * holdingHours;
        notional -= closed;
        if (notional <= 1e-9) {
          const remainder = f.notional_usd - closed;
          if (remainder > 1e-9) {
            // flip: the excess opens a new leg in the opposite direction
            dir = fdir;
            notional = remainder;
            openAtMs = t;
            totalEntryNotionalUsd += remainder;
          } else {
            dir = 0;
            notional = 0;
          }
        }
      }
    }
  }
  return { totalEntryNotionalUsd, fundingHaircutUsd, earliestMs };
}

run(async () => {
  header('scout:review — paper scorecard (deterministic; never trades)');
  const client = getServiceRoleClient();

  // Scout sessions only.
  const { data: sessions } = await client.from('sessions').select('id').eq('title', 'scout');
  const sessionIds = (sessions ?? []).map((s) => (s as { id: string }).id);
  if (sessionIds.length === 0) {
    line('No scout sessions yet — nothing to score. Launch the scout and let it trade (paper).');
    return;
  }

  // Realized P&L net of taker fees (the gross before the funding+slippage haircut).
  const { data: positions } = await client
    .from('positions')
    .select('realized_pnl_usd, fees_paid_usd')
    .in('session_id', sessionIds);
  let realizedGrossUsd = 0;
  for (const p of positions ?? []) {
    const r = p as { realized_pnl_usd: number; fees_paid_usd: number };
    realizedGrossUsd += (Number(r.realized_pnl_usd) || 0) - (Number(r.fees_paid_usd) || 0);
  }

  // Fills → entry notional + funding estimate + period start.
  const { data: fills } = await client
    .from('fills')
    .select('coin, side, notional_usd, reduce_only, filled_at')
    .in('session_id', sessionIds);
  const { totalEntryNotionalUsd, fundingHaircutUsd, earliestMs } = estimateFromFills((fills ?? []) as FillRow[]);
  const periodDays = Number.isFinite(earliestMs) ? Math.max(1, (Date.now() - earliestMs) / 86_400_000) : 1;

  // Win/loss from resolved hypotheses (confirmed = win, invalidated = loss).
  const { data: hyps } = await client.from('hypotheses').select('status').in('session_id', sessionIds);
  let wins = 0;
  let losses = 0;
  let closed = 0;
  for (const h of hyps ?? []) {
    const st = (h as { status: string }).status;
    if (st === 'confirmed') { wins++; closed++; }
    else if (st === 'invalidated') { losses++; closed++; }
    else if (st === 'resolved') closed++;
  }

  const input: ScorecardInput = {
    realizedGrossUsd,
    totalEntryNotionalUsd,
    fundingHaircutUsd,
    tradeCount: closed,
    wins,
    losses,
    periodDays,
    // maxDrawdown/equity left undefined in v1 → graduation is correctly gated off
    // until the equity-curve drawdown is wired (Phase-1.5).
  };
  const card = buildScorecard(input);

  header('SCORECARD');
  line(`period: ${periodDays.toFixed(1)} days   trades: ${card.tradeCount}   win-rate: ${(card.winRate * 100).toFixed(0)}%`);
  line(`realized (net of fees): $${card.realizedGrossUsd.toFixed(2)}`);
  line(`− slippage haircut:      $${card.slippageHaircutUsd.toFixed(2)}`);
  line(`− funding haircut (est): $${card.fundingHaircutUsd.toFixed(2)}  (assumed ${(ASSUMED_FUNDING_APR * 100).toFixed(0)}% APR over measured holding)`);
  line(`= NET:                   $${card.netUsd.toFixed(2)}`);
  line(`monthly run-rate:        $${card.monthlyRunRateUsd.toFixed(0)}/mo   (bar $1000/mo; vs bar ${card.vsBarUsd >= 0 ? '+' : ''}$${card.vsBarUsd.toFixed(0)})`);
  header(`VERDICT: ${card.verdict.toUpperCase()}`);
  line(card.reason);
  line('');
  line('Next: the scout-review skill (Opus) reads this + the resolved hypotheses and curates docs/scout/playbook.md.');
});
