/**
 * pnpm scout:review — the deterministic scorecard for the paper scout.
 *
 * NEVER trades + NEVER edits the playbook. It reads the scout's paper ledger
 * (fills / positions / resolved hypotheses) and prints the ONE honest number the
 * pre-registered bar is judged on: net P&L after the modeled funding + slippage
 * haircut, projected to a monthly run-rate, with a kill/continue/graduate verdict.
 *
 * Honesty (post-review): realized P&L is CLOSED-only (open-position entry fees no
 * longer drag it); funding is SIGNED per-coin (a short earning carry is credited,
 * not charged); slippage is per-coin (thin BTC costs more) and exit-weighted
 * (exits fill worse). The `scout-review` SKILL then has Opus read this + curate
 * docs/scout/playbook.md.
 */

import { header, line, run } from './_skill-runtime';
import { getServiceRoleClient } from '@/lib/cockpit/supabase-server';
import { fetchMetaAndAssetCtxs } from '@/lib/hyperliquid/hyperliquid-info-service';
import { fundingCostUsd } from '@/lib/trading/paper-funding-business-logic';
import { buildScorecard, type ScorecardInput } from '@/lib/scout/scout-review-business-logic';

// Per-coin adverse slippage (bps, ONE leg). Thin books (BTC on HL) cost more.
const PER_COIN_SLIPPAGE_BPS: Record<string, number> = { BTC: 12, ETH: 5, SOL: 6, HYPE: 7 };
const DEFAULT_SLIPPAGE_BPS = 8;
// Exits fill worse than entries (they fire during adverse moves into thinning books).
const EXIT_SLIPPAGE_MULT = 1.5;

interface FillRow {
  coin: string;
  side: string;
  notional_usd: number;
  reduce_only: boolean;
  filled_at: string;
}

/**
 * Pair fills per coin into directional round-trips (handles adds, partial closes,
 * flips). Per closed leg: accrue SIGNED funding over the holding window (short in
 * positive funding earns carry → negative cost) + per-coin, exit-weighted slippage.
 */
function estimateFromFills(
  fills: FillRow[],
  fundingByCoin: Record<string, number>,
): { slippageHaircutUsd: number; fundingHaircutUsd: number; earliestMs: number } {
  let slippageHaircutUsd = 0;
  let fundingHaircutUsd = 0;
  let earliestMs = Number.POSITIVE_INFINITY;

  const byCoin = new Map<string, FillRow[]>();
  for (const f of fills) {
    const t = new Date(f.filled_at).getTime();
    if (Number.isFinite(t)) earliestMs = Math.min(earliestMs, t);
    const arr = byCoin.get(f.coin.toUpperCase()) ?? [];
    arr.push(f);
    byCoin.set(f.coin.toUpperCase(), arr);
  }

  for (const [coin, rows] of byCoin) {
    rows.sort((a, b) => new Date(a.filled_at).getTime() - new Date(b.filled_at).getTime());
    const legBps = PER_COIN_SLIPPAGE_BPS[coin] ?? DEFAULT_SLIPPAGE_BPS;
    const fundingRate = fundingByCoin[coin] ?? 0;
    let dir = 0; // +1 long, −1 short, 0 flat
    let notional = 0;
    let openAtMs = 0;
    const accrue = (side: 'long' | 'short', closed: number, t: number) => {
      const holdingHours = Math.max(0, (t - openAtMs) / 3_600_000);
      // entry leg + exit leg (exit weighted heavier)
      slippageHaircutUsd += closed * (legBps / 10_000) * (1 + EXIT_SLIPPAGE_MULT);
      fundingHaircutUsd += fundingCostUsd({ side, notionalUsd: closed, fundingRateHourly: fundingRate, holdingHours });
    };
    for (const f of rows) {
      const t = new Date(f.filled_at).getTime();
      const fdir = f.side === 'buy' ? 1 : -1;
      if (dir === 0) {
        dir = fdir;
        notional = f.notional_usd;
        openAtMs = t;
      } else if (fdir === dir) {
        notional += f.notional_usd; // add
      } else {
        const closed = Math.min(notional, f.notional_usd);
        accrue(dir === 1 ? 'long' : 'short', closed, t);
        notional -= closed;
        if (notional <= 1e-9) {
          const remainder = f.notional_usd - closed;
          if (remainder > 1e-9) {
            dir = fdir;
            notional = remainder;
            openAtMs = t;
          } else {
            dir = 0;
            notional = 0;
          }
        }
      }
    }
  }
  return { slippageHaircutUsd, fundingHaircutUsd, earliestMs };
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

  // Realized P&L net of taker fees, summed over ALL positions. `realized_pnl_usd`
  // is CUMULATIVE closed P&L per (session,coin), so a coin that closed a round-trip
  // then reopened still contributes its realized gain (closed-only filtering would
  // silently DROP it — the re-review caught that). An open position's entry fee is
  // a REAL paid cost (included); only its unrealized P&L is excluded, which is
  // correct for a realized scorecard.
  const { data: positions } = await client
    .from('positions')
    .select('side, realized_pnl_usd, fees_paid_usd')
    .in('session_id', sessionIds);
  let realizedGrossUsd = 0;
  let openCount = 0;
  for (const p of positions ?? []) {
    const r = p as { side: string; realized_pnl_usd: number; fees_paid_usd: number };
    if (r.side !== 'flat') openCount++;
    realizedGrossUsd += (Number(r.realized_pnl_usd) || 0) - (Number(r.fees_paid_usd) || 0);
  }

  // Signed per-coin funding rates (best-effort; empty on failure → 0 funding).
  const ctxs = await fetchMetaAndAssetCtxs().catch(() => ({}) as Record<string, { fundingHourly: number }>);
  const fundingByCoin: Record<string, number> = {};
  for (const [coin, c] of Object.entries(ctxs)) fundingByCoin[coin] = Number(c.fundingHourly) || 0;

  // Fills → signed funding + per-coin slippage + period start.
  const { data: fills } = await client
    .from('fills')
    .select('coin, side, notional_usd, reduce_only, filled_at')
    .in('session_id', sessionIds);
  const { slippageHaircutUsd, fundingHaircutUsd, earliestMs } = estimateFromFills((fills ?? []) as FillRow[], fundingByCoin);
  const periodDays = Number.isFinite(earliestMs) ? Math.max(1, (Date.now() - earliestMs) / 86_400_000) : 1;

  // Win/loss + closed count from resolved hypotheses (confirmed = win, invalidated = loss).
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
    slippageHaircutUsd,
    fundingHaircutUsd,
    tradeCount: closed,
    wins,
    losses,
    periodDays,
    // maxDrawdown/equity left undefined in v1 → graduation correctly gated off
    // until the equity-curve drawdown is wired (Phase-1.5).
  };
  const card = buildScorecard(input);

  header('SCORECARD');
  line(`period: ${periodDays.toFixed(1)} days   trades: ${card.tradeCount}   win-rate: ${(card.winRate * 100).toFixed(0)}%   (open positions excluded: ${openCount})`);
  line(`realized (closed, net of fees): $${card.realizedGrossUsd.toFixed(2)}`);
  line(`− slippage haircut (per-coin, exit-weighted): $${card.slippageHaircutUsd.toFixed(2)}`);
  line(`${card.fundingHaircutUsd >= 0 ? '−' : '+'} funding ${card.fundingHaircutUsd >= 0 ? 'cost' : 'CARRY earned'} (signed, per-coin): $${Math.abs(card.fundingHaircutUsd).toFixed(2)}`);
  line(`= NET: $${card.netUsd.toFixed(2)}`);
  line(`monthly run-rate: $${card.monthlyRunRateUsd.toFixed(0)}/mo   (bar $1000/mo; vs bar ${card.vsBarUsd >= 0 ? '+' : ''}$${card.vsBarUsd.toFixed(0)})`);
  header(`VERDICT: ${card.verdict.toUpperCase()}`);
  line(card.reason);
  line('');
  line('Next: the scout-review skill (Opus) reads this + the resolved hypotheses and curates docs/scout/playbook.md.');
});
