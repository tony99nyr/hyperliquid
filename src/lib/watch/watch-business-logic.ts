/**
 * Watch daemon — PURE tick logic (fully fixture-testable).
 *
 * The non-agent WATCH DAEMON (scripts/watch.ts) is a long-running, OUTSIDE-the-
 * Claude-session monitor. It NEVER trades — it only observes open positions,
 * runs the existing health engine, and writes cockpit rows so the UI lights up.
 *
 * This module holds the deterministic decision logic of one tick, with NO I/O:
 * given the live position, the freshly-computed health result, the alerts that
 * were already in the active state (from the previous tick), and the watch
 * config, it produces:
 *   - the health snapshot to persist,
 *   - the unrealized / total P&L (reusing pnl-business-logic),
 *   - the set of NEWLY-fired alerts (deduped against the previous tick so the
 *     same alert does not spam the analysis stream every ~20s — it surfaces
 *     ONLY on a state change), each with a severity.
 *
 * It composes the health-engine alerts (bearish-divergence / stop-within-1-ATR /
 * regime-flip / decline-detected) PLUS two watch-specific threshold alerts the
 * health engine does not cover: a drawdown alert (unrealized P&L below a % of
 * notional) and a big-move alert (price moved a large % from entry in either
 * direction). All thresholds are in the config.
 *
 * No I/O, no clock, no env — every input arrives as a parameter. The I/O wrapper
 * (watch-service.ts + scripts/watch.ts) fetches the position + candles, runs the
 * health engine, and persists the outputs this returns.
 */

import { unrealizedPnl, totalPnl } from '@/lib/trading/pnl-business-logic';
import type { Position } from '@/types/position';
import type { HealthResult } from '@/lib/health/health-engine-types';
import type { AlertSeverity } from '@/types/cockpit';

/** Tunable thresholds for the watch-specific alerts. */
export interface WatchConfig {
  /** Unrealized P&L below −(this fraction × notional) fires the drawdown alert. */
  drawdownPctOfNotional: number;
  /** |price − entry| / entry ≥ this fraction fires the big-move alert. */
  bigMovePct: number;
  /** Time-stop: a position open longer than this many days that has NOT reached the
   *  progress bar below fires the advisory 'time-stop' alert (a thesis that isn't
   *  working is wrong even if it isn't yet losing — playbook §8). */
  timeStopDays: number;
  /** ...unless unrealized P&L ≥ this fraction of notional (the trade is "working"). */
  timeStopMinProgressFracOfNotional: number;
}

/** Sensible defaults — conservative, surface real moves without spamming. */
export const DEFAULT_WATCH_CONFIG: WatchConfig = {
  drawdownPctOfNotional: 0.05, // 5% of notional in unrealized loss
  bigMovePct: 0.05, // 5% move from entry
  timeStopDays: 5, // a swing thesis should show progress within ~a week
  timeStopMinProgressFracOfNotional: 0.01, // "working" = up ≥1% of notional
};

/** A computed alert: a stable code plus the severity to log it at. */
export interface WatchAlert {
  code: string;
  severity: AlertSeverity;
}

/** Snapshot fields to persist via the existing health-snapshot service. */
export interface SnapshotToWrite {
  score: number;
  pContinuation: number;
  pAdverse: number;
  /** The composed alert codes (health + watch), for the health_snapshots row. */
  alerts: string[];
}

/** P&L for the open position at the current mark. */
export interface WatchPnl {
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  feesPaidUsd: number;
  /** realized + unrealized − fees. */
  totalPnlUsd: number;
  /** Mark price used (the input mark). */
  markPx: number;
}

/** The full result of one pure tick decision. */
export interface WatchTickDecision {
  /** True when the position is flat / zero — the caller should no-op (skip writes). */
  flat: boolean;
  snapshot: SnapshotToWrite;
  pnl: WatchPnl;
  /** Alerts NEWLY active this tick (not present last tick) — log these. */
  newAlerts: WatchAlert[];
  /** The full active alert set this tick — becomes next tick's `lastAlerts`. */
  activeAlertCodes: string[];
}

/**
 * Severity for an alert code. Health-engine codes mirror the assess-health
 * recommender mapping (regime flip = danger; the rest = warn). Watch-specific
 * codes: drawdown = danger, big-move = warn (informational — could be favorable).
 */
export function severityForAlertCode(code: string): AlertSeverity {
  if (code === 'regime-flip-8h' || code === 'drawdown') return 'danger';
  return 'warn';
}

/**
 * Compute the watch-specific threshold alerts (the ones the health engine does
 * not emit): drawdown (unrealized loss past a % of notional) and big-move (price
 * far from entry). PURE.
 */
export function computeThresholdAlerts(
  position: Position,
  markPx: number,
  uPnl: number,
  config: WatchConfig,
  /** Epoch ms the position opened (null/undefined = unknown → time-stop skipped). */
  openedAtMs?: number | null,
  now?: number,
): string[] {
  const alerts: string[] = [];
  if (position.side === 'flat' || position.sz === 0) return alerts;

  // Drawdown: unrealized loss beyond drawdownPctOfNotional × current notional.
  const notional = Math.abs(position.avgEntryPx * position.sz);
  if (notional > 0 && uPnl < -(config.drawdownPctOfNotional * notional)) {
    alerts.push('drawdown');
  }

  // Big move: price has moved a large % from the average entry (either way).
  if (position.avgEntryPx > 0) {
    const movePct = Math.abs(markPx - position.avgEntryPx) / position.avgEntryPx;
    if (movePct >= config.bigMovePct) alerts.push('big-move');
  }

  // Time-stop (ADVISORY — the no-auto-fire rule is untouched; this only alerts):
  // open past the day bar without reaching the progress bar → the thesis is stalling.
  if (openedAtMs != null && now != null && now > openedAtMs && notional > 0) {
    const ageDays = (now - openedAtMs) / 86_400_000;
    const progressing = uPnl >= config.timeStopMinProgressFracOfNotional * notional;
    if (ageDays >= config.timeStopDays && !progressing) alerts.push('time-stop');
  }

  return alerts;
}

/**
 * Decide one tick. Composes the health-engine alerts with the watch threshold
 * alerts, dedupes the union against `lastAlertCodes` (so only state changes are
 * surfaced as `newAlerts`), and computes P&L at the mark. PURE + deterministic.
 *
 * When the position is flat/zero, returns `flat: true` and empty outputs so the
 * caller skips all writes (no-op tick for that coin).
 */
export function decideTick(input: {
  position: Position;
  markPx: number;
  health: HealthResult;
  /** Alert codes that were active at the end of the previous tick (for dedup). */
  lastAlertCodes: string[];
  config?: WatchConfig;
  /** Epoch ms the position opened (for the time-stop advisory); null = unknown. */
  openedAtMs?: number | null;
  /** Epoch ms "now" — injected with openedAtMs (pure code takes no clock). */
  now?: number;
}): WatchTickDecision {
  const config = input.config ?? DEFAULT_WATCH_CONFIG;
  const { position, markPx, health } = input;

  const uPnl = unrealizedPnl(position, markPx);
  const pnl: WatchPnl = {
    realizedPnlUsd: position.realizedPnlUsd,
    unrealizedPnlUsd: uPnl,
    feesPaidUsd: position.feesPaidUsd,
    totalPnlUsd: totalPnl(position, markPx),
    markPx,
  };

  const flat = position.side === 'flat' || position.sz === 0;
  if (flat) {
    return {
      flat: true,
      snapshot: {
        score: health.score,
        pContinuation: health.pContinuation,
        pAdverse: health.pAdverse,
        alerts: [],
      },
      pnl,
      newAlerts: [],
      activeAlertCodes: [],
    };
  }

  // Union of health alerts + watch threshold alerts, de-duplicated, stable order.
  const thresholdAlerts = computeThresholdAlerts(position, markPx, uPnl, config, input.openedAtMs, input.now);
  const activeAlertCodes = dedupePreserveOrder([...health.alerts, ...thresholdAlerts]);

  // New = active now AND not active last tick (state-change only — no spam).
  const lastSet = new Set(input.lastAlertCodes);
  const newAlerts: WatchAlert[] = activeAlertCodes
    .filter((code) => !lastSet.has(code))
    .map((code) => ({ code, severity: severityForAlertCode(code) }));

  return {
    flat: false,
    snapshot: {
      score: health.score,
      pContinuation: health.pContinuation,
      pAdverse: health.pAdverse,
      alerts: activeAlertCodes,
    },
    pnl,
    newAlerts,
    activeAlertCodes,
  };
}

/** Dedupe an array of strings, keeping first-seen order. PURE. */
function dedupePreserveOrder(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

/**
 * Format a new alert into a human-readable analysis-stream line. PURE — used by
 * the service when writing high-severity alerts to analysis_log.
 */
export function formatAlertMessage(coin: string, alert: WatchAlert, pnl: WatchPnl): string {
  const upnl = pnl.unrealizedPnlUsd;
  const sign = upnl >= 0 ? '+' : '−';
  const upnlStr = `${sign}$${Math.abs(upnl).toFixed(2)}`;
  return `${coin}: ${alert.code} (uPnL ${upnlStr} @ $${pnl.markPx})`;
}
