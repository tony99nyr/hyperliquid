/**
 * Derived analytics + alerts for the Wallet Copy-Monitor overlay.
 *
 * Pure functions: take a leader's live state + fills + rating, produce
 * human-readable insights/alerts so the user can see martingale / no-stop /
 * deep-stack risk BEFORE deciding to follow a leader down.
 *
 * READ-ONLY. Nothing here executes a trade — these are advisory signals only.
 */

import type { HlClearinghouseState, HlFill } from './hyperliquid-info-service';
import type { RatedWallet } from './rated-wallets-service';

export type AlertSeverity = 'info' | 'warn' | 'danger';

export interface MonitorAlert {
  severity: AlertSeverity;
  title: string;
  detail: string;
}

/** Per-coin add-history derived from fills: how many times the leader added. */
export interface CoinAddHistory {
  coin: string;
  /** Number of fills that increased exposure in the prevailing direction. */
  addCount: number;
  /** Total fills for this coin in the lookback. */
  fillCount: number;
  /** Net realized PnL across closed fills for this coin in the lookback. */
  realizedPnl: number;
  lastFillTime: number;
}

export interface CopyMonitorAnalytics {
  alerts: MonitorAlert[];
  addHistory: CoinAddHistory[];
  /** Sum of closed PnL across the lookback (proxy for realized performance). */
  realizedPnlLookback: number;
  /** Count of fills classified as adds (same-direction exposure increases). */
  totalAdds: number;
}

/**
 * Build add-history per coin from recent fills.
 * A fill is an "add" when it pushes net exposure further from zero in the
 * direction the leader is currently net (heuristic — fills lack running size).
 * We approximate: buys are adds for longs, sells are adds for shorts.
 */
function buildAddHistory(
  fills: HlFill[],
  positions: HlClearinghouseState['positions'],
): CoinAddHistory[] {
  const sideByCoin = new Map<string, 'long' | 'short'>();
  for (const p of positions) sideByCoin.set(p.coin, p.side);

  const byCoin = new Map<string, CoinAddHistory>();
  for (const f of fills) {
    let h = byCoin.get(f.coin);
    if (!h) {
      h = { coin: f.coin, addCount: 0, fillCount: 0, realizedPnl: 0, lastFillTime: 0 };
      byCoin.set(f.coin, h);
    }
    h.fillCount += 1;
    h.realizedPnl += f.closedPnl ?? 0;
    h.lastFillTime = Math.max(h.lastFillTime, f.time);

    const side = sideByCoin.get(f.coin);
    const isOpenLike = !f.dir || /open|long|short|buy/i.test(f.dir);
    if (side === 'long' && f.side === 'buy' && isOpenLike) h.addCount += 1;
    else if (side === 'short' && f.side === 'sell' && isOpenLike) h.addCount += 1;
  }

  return [...byCoin.values()].sort((a, b) => b.addCount - a.addCount);
}

/**
 * Derive advisory alerts from the leader's rating + live state + fills.
 * These surface the copy-trading tail risks (martingale, no-stop, deep stack)
 * the user is meant to apply their own human-stop against.
 */
export function buildCopyMonitorAnalytics(
  rating: RatedWallet | null,
  leaderState: HlClearinghouseState,
  fills: HlFill[],
): CopyMonitorAnalytics {
  const addHistory = buildAddHistory(fills, leaderState.positions);
  const totalAdds = addHistory.reduce((sum, h) => sum + h.addCount, 0);
  const realizedPnlLookback = addHistory.reduce((sum, h) => sum + h.realizedPnl, 0);

  const alerts: MonitorAlert[] = [];
  const m = rating?.metrics ?? {};
  const flags = rating?.flags ?? [];

  // --- Flag-driven alerts ---
  if (flags.includes('DISQUALIFIED')) {
    alerts.push({
      severity: 'danger',
      title: 'Disqualified by at least one rating philosophy',
      detail: 'This wallet failed a hard rule (e.g. blow-up, liquidations, thin alts). Treat as high risk.',
    });
  }
  if (flags.includes('NO_STOPS')) {
    alerts.push({
      severity: 'danger',
      title: 'No stop-loss history',
      detail: 'The leader has never closed a losing position via a stop — they ride positions. Apply YOUR OWN stop.',
    });
  }
  if (flags.includes('DEEP_MARTINGALE')) {
    alerts.push({
      severity: 'danger',
      title: 'Deep martingale',
      detail: 'The leader averages down aggressively. Following blindly inherits the martingale tail.',
    });
  }
  if (flags.includes('LIVE_DEEP_STACK') || flags.includes('LIVE_UNDERWATER')) {
    alerts.push({
      severity: 'warn',
      title: 'Live deep stack / underwater',
      detail: 'The leader currently holds an oversized or underwater position. Do not enter at the bottom of their stack.',
    });
  }
  if (flags.includes('RIDE_OR_LIQUIDATE')) {
    alerts.push({
      severity: 'danger',
      title: 'Ride-or-liquidate behavior',
      detail: 'The leader tends to hold to liquidation rather than cut. Your human-stop is the safety net here.',
    });
  }
  if (flags.includes('EXTREME_WIN_RATE')) {
    alerts.push({
      severity: 'warn',
      title: 'Extreme win rate',
      detail: 'A near-100% win rate usually means they never cut losers — wins are small, the eventual loss is large.',
    });
  }
  if (flags.includes('SUB_MINUTE_SCALPER')) {
    alerts.push({
      severity: 'warn',
      title: 'Sub-minute scalper',
      detail: 'Holds are too short to copy manually — by the time you mirror it, the edge is gone.',
    });
  }
  if (flags.includes('THIN_ALT_TRADER')) {
    alerts.push({
      severity: 'warn',
      title: 'Thin-alt trader',
      detail: 'Trades illiquid alts — slippage and exit risk are high for a copier.',
    });
  }
  if (flags.includes('CLEAN_BOOK')) {
    alerts.push({
      severity: 'info',
      title: 'Clean book',
      detail: 'No disqualifying risk patterns detected by the rating philosophies.',
    });
  }

  // --- Metric-driven alerts ---
  if (typeof m.maxAddDepth === 'number' && typeof m.medianAddDepth === 'number' && m.medianAddDepth > 0) {
    const ratio = m.maxAddDepth / m.medianAddDepth;
    if (ratio >= 5) {
      alerts.push({
        severity: 'warn',
        title: `Add-depth tail: max ${m.maxAddDepth} vs median ${m.medianAddDepth}`,
        detail: `On a bad day the leader added ${ratio.toFixed(0)}× their typical depth — a martingale signature.`,
      });
    }
  }
  if (typeof m.worstLossVsMedianWin === 'number' && m.worstLossVsMedianWin >= 3) {
    alerts.push({
      severity: 'warn',
      title: `Worst loss is ${m.worstLossVsMedianWin.toFixed(1)}× the median win`,
      detail: 'Asymmetric tail: many small wins, one large loss. Size small and use your own stop.',
    });
  }
  if (typeof m.openPeakVsMedianPeak === 'number' && m.openPeakVsMedianPeak >= 3) {
    alerts.push({
      severity: 'danger',
      title: `Live stack is ${m.openPeakVsMedianPeak.toFixed(0)}× their median position`,
      detail: 'The leader is currently holding far more than usual — likely averaging into a loser right now.',
    });
  }
  if (typeof m.liquidations === 'number' && m.liquidations > 0) {
    alerts.push({
      severity: 'warn',
      title: `${m.liquidations} prior liquidation(s)`,
      detail: 'The leader has been liquidated before — capital preservation is not guaranteed.',
    });
  }

  // --- Live add-history alert (from fills) ---
  const topAdd = addHistory[0];
  if (topAdd && topAdd.addCount >= 5) {
    alerts.push({
      severity: 'warn',
      title: `Leader is averaging down — ${topAdd.addCount} adds on ${topAdd.coin}`,
      detail: 'Recent fills show repeated same-direction adds. If you are following, this is where the martingale begins.',
    });
  }

  // Live underwater check from positions themselves.
  for (const p of leaderState.positions) {
    if (p.unrealizedPnl < 0 && Math.abs(p.unrealizedPnl) > leaderState.accountValueUsd * 0.25) {
      alerts.push({
        severity: 'danger',
        title: `${p.coin} ${p.side} is deeply underwater`,
        detail: `Unrealized loss (${formatUsd(p.unrealizedPnl)}) exceeds 25% of account value. Do not chase this entry.`,
      });
    }
  }

  if (alerts.length === 0) {
    alerts.push({
      severity: 'info',
      title: 'No elevated copy-risk signals detected',
      detail: 'Still apply your own entry/exit discipline — you are the stop, not the leader.',
    });
  }

  // Stable order: danger → warn → info.
  const rank: Record<AlertSeverity, number> = { danger: 0, warn: 1, info: 2 };
  alerts.sort((a, b) => rank[a.severity] - rank[b.severity]);

  return { alerts, addHistory, realizedPnlLookback, totalAdds };
}

function formatUsd(n: number): string {
  const sign = n < 0 ? '-' : '';
  return `${sign}$${Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}
