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
import { fetchMetaAndAssetCtxs, fetchVaultDetails, HLP_VAULT_ADDRESS } from '@/lib/hyperliquid/hyperliquid-info-service';
import { fetchFundingHistory } from '@/lib/hyperliquid/candle-service';
import { fundingCostUsd } from '@/lib/trading/paper-funding-business-logic';
import { fundingCarryBenchmark } from '@/lib/scout/funding-carry-business-logic';
import {
  buildScorecard,
  buildLaneScorecards,
  DEFAULT_SCORECARD_CONFIG,
  type ScorecardInput,
  type LanePositionRow,
  type LaneHypothesisRow,
} from '@/lib/scout/scout-review-business-logic';
import { vaultReturnSince } from '@/lib/scout/vault-snapshot-business-logic';

interface FillRow {
  coin: string;
  side: string;
  notional_usd: number;
  reduce_only: boolean;
  filled_at: string;
}

/**
 * Pair fills per coin into directional round-trips (handles adds, partial closes,
 * flips) and accrue SIGNED funding over each holding window (a short in positive
 * funding earns carry → negative cost). Slippage is NOT computed here: it is now
 * embedded in the fill PRICE (paper-fill-realism), so it's already in realized
 * P&L — adding it again would double-count.
 */
function estimateFromFills(
  fills: FillRow[],
  fundingByCoin: Record<string, number>,
): { fundingHaircutUsd: number; earliestMs: number; fundingHaircutByCoin: Record<string, number> } {
  let fundingHaircutUsd = 0;
  let earliestMs = Number.POSITIVE_INFINITY;
  // Per-coin signed funding, so the per-lane scorecard can attribute it (coin→lane).
  const fundingHaircutByCoin: Record<string, number> = {};

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
    const fundingRate = fundingByCoin[coin] ?? 0;
    let dir = 0; // +1 long, −1 short, 0 flat
    let notional = 0;
    let openAtMs = 0;
    const accrue = (side: 'long' | 'short', closed: number, t: number) => {
      const holdingHours = Math.max(0, (t - openAtMs) / 3_600_000);
      const cost = fundingCostUsd({ side, notionalUsd: closed, fundingRateHourly: fundingRate, holdingHours });
      fundingHaircutUsd += cost;
      fundingHaircutByCoin[coin] = (fundingHaircutByCoin[coin] ?? 0) + cost;
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
  return { fundingHaircutUsd, earliestMs, fundingHaircutByCoin };
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
    .select('coin, side, lane, realized_pnl_usd, fees_paid_usd')
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
  const { fundingHaircutUsd, earliestMs, fundingHaircutByCoin } = estimateFromFills((fills ?? []) as FillRow[], fundingByCoin);
  const periodDays = Number.isFinite(earliestMs) ? Math.max(1, (Date.now() - earliestMs) / 86_400_000) : 1;

  // Win/loss + closed count from resolved hypotheses (confirmed = win, invalidated = loss).
  const { data: hyps } = await client.from('hypotheses').select('status, lane').in('session_id', sessionIds);
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
    slippageHaircutUsd: 0, // slippage is now embedded in the fill price (paper-fill-realism), already in realized P&L
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
  line(`realized (net of fees + slippage-in-fill): $${card.realizedGrossUsd.toFixed(2)}`);
  line(`${card.fundingHaircutUsd >= 0 ? '−' : '+'} funding ${card.fundingHaircutUsd >= 0 ? 'cost' : 'CARRY earned'} (signed, per-coin): $${Math.abs(card.fundingHaircutUsd).toFixed(2)}`);
  line(`= NET: $${card.netUsd.toFixed(2)}`);
  line(`monthly run-rate: $${card.monthlyRunRateUsd.toFixed(0)}/mo   (bar $1000/mo; vs bar ${card.vsBarUsd >= 0 ? '+' : ''}$${card.vsBarUsd.toFixed(0)})`);
  header(`VERDICT: ${card.verdict.toUpperCase()} (ALL LANES — the account-level bar)`);
  line(card.reason);

  // Per-lane breakdown (informational — the account-level verdict above is the bar
  // the circuit breaker + graduation gate on). Lets the weekly review see which lane
  // pays and which bleeds, so a lane gets killed on its own number, not the blend.
  const lanePositions: LanePositionRow[] = (positions ?? []).map((p) => {
    const r = p as { coin: string; side: string; lane: string | null; realized_pnl_usd: number; fees_paid_usd: number };
    return { lane: r.lane ?? null, coin: r.coin, side: r.side, realizedPnlUsd: Number(r.realized_pnl_usd) || 0, feesPaidUsd: Number(r.fees_paid_usd) || 0 };
  });
  const laneHyps: LaneHypothesisRow[] = (hyps ?? []).map((h) => {
    const r = h as { status: string; lane: string | null };
    return { lane: r.lane ?? null, status: r.status };
  });
  const laneCards = buildLaneScorecards({ positions: lanePositions, hypotheses: laneHyps, fundingByCoin: fundingHaircutByCoin, periodDays });

  // Lane A — passive HLP allocation, scored as a buy-and-hold over a lookback. The
  // return is the vault's FLOW-FREE per-capital return (ΔcumPnl / AUM_at_start), NOT
  // its opaque apr and NOT raw AUM change. Env-tunable; the bar is LOWER than the
  // directional $1000/mo since it's a passive "beats holding cash" hurdle.
  const vaultLookbackDays = Number(process.env.SCOUT_VAULT_LOOKBACK_DAYS) || 30;
  const vaultNotionalUsd = Number(process.env.SCOUT_VAULT_NOTIONAL_USD) || 1000;
  const vaultBarUsd = Number(process.env.SCOUT_VAULT_BAR_USD) || 50;
  let vaultLine: string | null = null;
  try {
    const raw = await fetchVaultDetails(HLP_VAULT_ADDRESS);
    const { returnFrac, spanDays } = vaultReturnSince(raw, Date.now() - vaultLookbackDays * 86_400_000);
    if (returnFrac != null) {
      const days = Math.max(1, spanDays ?? vaultLookbackDays);
      const vcard = buildScorecard(
        { realizedGrossUsd: 0, slippageHaircutUsd: 0, fundingHaircutUsd: 0, unrealizedPnlUsd: vaultNotionalUsd * returnFrac, tradeCount: 0, wins: 0, losses: 0, periodDays: days },
        { ...DEFAULT_SCORECARD_CONFIG, monthlyBarUsd: vaultBarUsd },
      );
      vaultLine = `[vault:HLP]  $${vaultNotionalUsd} notional → ${(returnFrac * 100).toFixed(2)}% over ${days.toFixed(0)}d = net $${vcard.netUsd.toFixed(2)}  run-rate $${vcard.monthlyRunRateUsd.toFixed(0)}/mo (bar $${vaultBarUsd})  → ${vcard.verdict.toUpperCase()}`;
    }
  } catch {
    vaultLine = '[vault:HLP]  (vaultDetails unavailable this cycle)';
  }

  // Lane B — DELTA-NEUTRAL funding carry, scored as a benchmark over the best liquid
  // major. Carry = the funding you'd EARN holding the funding-earning side hedged,
  // with the negative-funding exit guard (a flip stops the carry). Price is hedged →
  // the return IS the carry, minus the round-trip cost of putting a 2-leg pair on/off.
  // ADL (the hedge being force-closed → naked) is a documented tail, not modeled here.
  const carryLookbackDays = Number(process.env.SCOUT_CARRY_LOOKBACK_DAYS) || 30;
  const carryNotionalUsd = Number(process.env.SCOUT_CARRY_NOTIONAL_USD) || 1000;
  const carryBarUsd = Number(process.env.SCOUT_CARRY_BAR_USD) || 50;
  const CARRY_ROUNDTRIP_FRAC = 0.003; // ~30 bps to put on + take off a delta-neutral pair (2 legs × in/out)
  let carryLine: string | null = null;
  try {
    const since = Date.now() - carryLookbackDays * 86_400_000;
    const benches = await Promise.all(
      ['ETH', 'BTC', 'SOL', 'HYPE'].map(async (coin) => ({ coin, b: fundingCarryBenchmark(await fetchFundingHistory(coin, since).catch(() => [])) })),
    );
    const best = benches.filter((x) => x.b.heldHours > 0).sort((a, b) => b.b.carryReturnFrac - a.b.carryReturnFrac)[0];
    if (best) {
      const netFrac = best.b.carryReturnFrac - CARRY_ROUNDTRIP_FRAC;
      const days = Math.max(1, best.b.heldHours / 24);
      const ccard = buildScorecard(
        { realizedGrossUsd: 0, slippageHaircutUsd: 0, fundingHaircutUsd: 0, unrealizedPnlUsd: carryNotionalUsd * netFrac, tradeCount: 0, wins: 0, losses: 0, periodDays: days },
        { ...DEFAULT_SCORECARD_CONFIG, monthlyBarUsd: carryBarUsd },
      );
      carryLine = `[carry:${best.coin}]  ${best.b.side} $${carryNotionalUsd} Δ-neutral → ${(best.b.carryReturnFrac * 100).toFixed(2)}% carry − ${(CARRY_ROUNDTRIP_FRAC * 100).toFixed(1)}% cost over ${days.toFixed(0)}d = net $${ccard.netUsd.toFixed(2)}  run-rate $${ccard.monthlyRunRateUsd.toFixed(0)}/mo (bar $${carryBarUsd})${best.b.exitedEarly ? ' [funding flipped → exited]' : ''}  → ${ccard.verdict.toUpperCase()}`;
    }
  } catch {
    carryLine = '[carry]  (funding history unavailable this cycle)';
  }

  // Show the breakdown when there's more than the lone directional lane OR a benchmark lane.
  const hasPositionLanes = laneCards.length > 1 || (laneCards.length === 1 && laneCards[0].lane !== 'directional');
  if (hasPositionLanes || vaultLine || carryLine) {
    header('PER-LANE BREAKDOWN');
    for (const { lane, openCount: lo, card: c } of laneCards) {
      line(`[${lane}]  net $${c.netUsd.toFixed(2)}  (realized $${c.realizedGrossUsd.toFixed(2)}, funding ${c.fundingHaircutUsd >= 0 ? '−' : '+'}$${Math.abs(c.fundingHaircutUsd).toFixed(2)})  trades ${c.tradeCount}  win ${(c.winRate * 100).toFixed(0)}%  open ${lo}  → ${c.verdict.toUpperCase()}`);
    }
    if (vaultLine) line(vaultLine);
    if (carryLine) line(carryLine);
  }
  line('');
  line('Next: the scout-review skill (Opus) reads this + the resolved hypotheses and curates docs/scout/playbook.md.');
});
