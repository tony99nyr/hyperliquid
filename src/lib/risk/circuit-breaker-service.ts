/**
 * Circuit-breaker service (I/O) — computes the scout's paper account equity, rolls
 * the persisted peak/day-start state, and returns the breaker decision. The scout
 * entry path calls this before any new open; the cockpit reads the stored state.
 * NEVER trades — it gates + recommends.
 */

import { getServiceRoleClient } from '@/lib/cockpit/supabase-server';
import { getHlAccountAddress } from '@/lib/auto-exit/auto-exit-config';
import { fetchSpotUsdcBalance, fetchClearinghouseState } from '@/lib/hyperliquid/hyperliquid-info-service';
import { fetchAllMids } from '@/lib/hyperliquid/hyperliquid-info-service';
import {
  evaluateCircuitBreaker,
  rollCircuitBreakerState,
  DEFAULT_CIRCUIT_BREAKER_CONFIG,
  type CircuitBreakerConfig,
  type CircuitBreakerDecision,
  type CircuitBreakerState,
} from './circuit-breaker-business-logic';

/** Paper account's notional starting equity (env-overridable). */
function startingEquityUsd(): number {
  const v = Number(process.env.CIRCUIT_BREAKER_EQUITY);
  return Number.isFinite(v) && v > 0 ? v : 1000;
}

export function getCircuitBreakerConfig(): CircuitBreakerConfig {
  const daily = Number(process.env.CIRCUIT_BREAKER_MAX_DAILY_LOSS_PCT);
  const dd = Number(process.env.CIRCUIT_BREAKER_MAX_DRAWDOWN_PCT);
  return {
    maxDailyLossPct: Number.isFinite(daily) && daily > 0 ? daily : DEFAULT_CIRCUIT_BREAKER_CONFIG.maxDailyLossPct,
    maxDrawdownPct: Number.isFinite(dd) && dd > 0 ? dd : DEFAULT_CIRCUIT_BREAKER_CONFIG.maxDrawdownPct,
    flattenOnDrawdownHalt: process.env.CIRCUIT_BREAKER_FLATTEN !== 'false',
  };
}

interface PositionRow {
  coin: string;
  side: string;
  sz: number;
  avg_entry_px: number;
  realized_pnl_usd: number;
  fees_paid_usd: number;
}

/** Paper equity = starting + realized (net of fees) + unrealized (open marked to mid). */
async function computeScoutEquity(): Promise<number> {
  const client = getServiceRoleClient();
  const { data: sessions } = await client.from('sessions').select('id').eq('title', 'scout');
  const ids = (sessions ?? []).map((s) => (s as { id: string }).id);
  let equity = startingEquityUsd();
  if (ids.length === 0) return equity;

  const [{ data: positions }, mids] = await Promise.all([
    client.from('positions').select('coin, side, sz, avg_entry_px, realized_pnl_usd, fees_paid_usd').in('session_id', ids),
    fetchAllMids().catch(() => ({}) as Record<string, number>),
  ]);
  for (const p of (positions ?? []) as PositionRow[]) {
    equity += (Number(p.realized_pnl_usd) || 0) - (Number(p.fees_paid_usd) || 0);
    if (p.side !== 'flat' && Number(p.sz) > 0) {
      const mark = Number(mids[p.coin?.toUpperCase()]);
      const entry = Number(p.avg_entry_px);
      if (Number.isFinite(mark) && mark > 0 && Number.isFinite(entry) && entry > 0) {
        const dir = p.side === 'long' ? 1 : -1;
        equity += dir * (mark - entry) * Number(p.sz);
      }
    }
  }
  return equity;
}

export interface CircuitBreakerStatus extends CircuitBreakerDecision {
  equityUsd: number;
  peakEquityUsd: number;
  dayStartEquityUsd: number;
}

/**
 * Compute equity, roll + persist the breaker state, and return the decision. The
 * `now` is injectable for tests; production passes Date.now().
 */
/**
 * LIVE account equity under the unified-account model: spot USDC (the collateral
 * pool) + Σ open-position unrealized PnL. Perp marginSummary reads 0 by design
 * (see memory: hl-unified-account) — never use accountValue here. THROWS on an
 * unreadable account so breaker callers fail CLOSED rather than compute from $0.
 */
export async function computeLiveEquity(): Promise<number> {
  return (await computeLiveEquityBreakdown()).totalUsd;
}

/**
 * THE one live-equity definition, with its components. Under HL's unified
 * account the spot USDC balance IS the collateral (perp accountValue reads ~0
 * between/behind positions by design), so equity = spot USDC + Σ open uPnL.
 * Every consumer — circuit breaker, ladder heat gate, Performance header —
 * must derive from THIS, never re-implement (a second definition is how the
 * Performance tab once omitted Σ uPnL). THROWS when unreadable; callers that
 * need fail-soft wrap it.
 */
export async function computeLiveEquityBreakdown(
  /** fresh=true (default) forces an uncached clearinghouse read — REQUIRED for
   *  anything that gates money (breaker, heat gate; fail-closed on stale).
   *  Display surfaces (the 30s cockpit poll) pass fresh:false to ride the
   *  15s cache instead of hammering HL once per open tab per poll. */
  opts: { fresh?: boolean } = {},
): Promise<{ totalUsd: number; spotUsd: number; upnlUsd: number }> {
  const addr = getHlAccountAddress();
  if (!addr) throw new Error('live equity: HL_ACCOUNT_ADDRESS not set');
  const [spot, ch] = await Promise.all([
    fetchSpotUsdcBalance(addr),
    fetchClearinghouseState(addr, { uncached: opts.fresh !== false }),
  ]);
  if (spot == null) throw new Error('live equity: spot balance unreadable');
  if (ch.stale || ch.error) throw new Error(`live equity: clearinghouse unreadable (${ch.error ?? 'stale'})`);
  const upnl = ch.positions.reduce((a, p) => a + (Number(p.unrealizedPnl) || 0), 0);
  return { totalUsd: spot + upnl, spotUsd: spot, upnlUsd: upnl };
}

export async function checkCircuitBreaker(scope = 'scout', now: number = Date.now()): Promise<CircuitBreakerStatus> {
  const client = getServiceRoleClient();
  // scope='live' tracks the REAL account (unified equity); anything else keeps the
  // original paper-scout computation. THROWS for live when the account is unreadable
  // — the fire path treats that as skip-don't-fire (fail closed).
  const equityUsd = scope === 'live' ? await computeLiveEquity() : await computeScoutEquity();

  const { data: row } = await client.from('circuit_breaker_state').select('*').eq('scope', scope).maybeSingle();
  const prev: CircuitBreakerState | null = row
    ? {
        peakEquityUsd: Number((row as { peak_equity_usd: number }).peak_equity_usd),
        dayStartEquityUsd: Number((row as { day_start_equity_usd: number }).day_start_equity_usd),
        dayStartAtMs: new Date((row as { day_start_at: string }).day_start_at).getTime(),
      }
    : null;

  const state = rollCircuitBreakerState(prev, equityUsd, now);
  const decision = evaluateCircuitBreaker({ equityUsd, dayStartEquityUsd: state.dayStartEquityUsd, peakEquityUsd: state.peakEquityUsd }, getCircuitBreakerConfig());

  try {
    await client.from('circuit_breaker_state').upsert(
      {
        scope,
        equity_usd: equityUsd,
        peak_equity_usd: state.peakEquityUsd,
        day_start_equity_usd: state.dayStartEquityUsd,
        day_start_at: new Date(state.dayStartAtMs).toISOString(),
        halted: decision.blockNewEntries,
        tripped: decision.tripped,
        reason: decision.reason,
        updated_at: new Date(now).toISOString(),
      },
      { onConflict: 'scope' },
    );
  } catch {
    /* best-effort persistence — the decision is still returned */
  }

  return { ...decision, equityUsd, peakEquityUsd: state.peakEquityUsd, dayStartEquityUsd: state.dayStartEquityUsd };
}
