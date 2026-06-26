/**
 * Liquidation-proximity alerter (NOTIFY-ONLY) — pages Discord when an open position
 * nears liquidation. Runs inside the auto-exit cron tick INDEPENDENT of the gated
 * auto-CLOSE: even with AUTO_EXIT_ENABLED off, the operator still gets warned (so
 * they can Add margin in time). It NEVER trades.
 *
 * Data: one clearinghouse read (real liquidationPx for every coin) + one mids read,
 * matched to the cockpit's open positions (listExitCandidates → sessionId+coin).
 * Dedup: escalation-based against recent `liq-alert` analysis_log rows (no new
 * table) — same-tier re-fires are suppressed for the window; WARN→CRITICAL pings.
 */

import 'server-only';
import { getServiceRoleClient } from '@/lib/cockpit/supabase-server';
import { listExitCandidates } from './auto-exit-scan';
import { getHlAccountAddress } from './auto-exit-config';
import { fetchAllMids, fetchClearinghouseState } from '@/lib/hyperliquid/hyperliquid-info-service';
import { validateEnv } from '@/lib/env/env';
import { writeAnalysisLog } from '@/lib/cockpit/analysis-log-service';
import { sendDiscord, isDiscordConfigured } from '@/lib/infrastructure/notify/discord-notify';
import {
  liqDistancePct,
  liqTier,
  shouldAlert,
  liqLogLine,
  parseLogTier,
  formatLiqDiscord,
  TIER_RANK,
  DEFAULT_LIQ_ALERT_CONFIG,
  type LiqTier,
  type LiqAlertConfig,
} from './liq-alert-business-logic';

/** Re-ping window: a still-near-liq position re-alerts at most once per this span. */
const DEDUP_WINDOW_MS = 2 * 60 * 60 * 1000; // 2h

export interface LiqAlertScanResult {
  skipped?: string;
  scanned: number;
  warned: number;
  critical: number;
  paged: number;
}

/** Highest tier already alerted per coin (this session) within the dedup window. */
async function priorTiersForSession(sessionId: string, sinceMs: number): Promise<Map<string, LiqTier>> {
  const map = new Map<string, LiqTier>();
  const { data } = await getServiceRoleClient()
    .from('analysis_log')
    .select('message, created_at')
    .eq('session_id', sessionId)
    .eq('source', 'liq-alert')
    .gte('created_at', new Date(sinceMs).toISOString());
  for (const r of (data ?? []) as Array<{ message: string }>) {
    const p = parseLogTier(r.message);
    if (!p) continue;
    const prev = map.get(p.coin);
    if (!prev || TIER_RANK[p.tier] > TIER_RANK[prev]) map.set(p.coin, p.tier);
  }
  return map;
}

/**
 * Scan open positions for liquidation proximity and page Discord on escalation.
 * NOTIFY-ONLY; safe to call every cron tick regardless of AUTO_EXIT_ENABLED.
 */
export async function scanAndAlertLiqProximity(now: number = Date.now()): Promise<LiqAlertScanResult> {
  // Real liq prices come from the clearinghouse (live account). No address → skip
  // (the formula-liq fallback for paper lives in the watch path, not here).
  const address = getHlAccountAddress();
  if (!address) return { skipped: 'no-hl-address', scanned: 0, warned: 0, critical: 0, paged: 0 };
  if (!isDiscordConfigured()) return { skipped: 'no-discord-webhook', scanned: 0, warned: 0, critical: 0, paged: 0 };

  const candidates = await listExitCandidates();
  if (candidates.length === 0) return { scanned: 0, warned: 0, critical: 0, paged: 0 };

  // Thresholds: env overrides (LIQ_ALERT_WARN_PCT / LIQ_ALERT_CRIT_PCT) else 8% / 4%.
  const cfg: LiqAlertConfig = {
    warnPct: Number(process.env.LIQ_ALERT_WARN_PCT) || DEFAULT_LIQ_ALERT_CONFIG.warnPct,
    critPct: Number(process.env.LIQ_ALERT_CRIT_PCT) || DEFAULT_LIQ_ALERT_CONFIG.critPct,
  };

  const network = validateEnv().HL_NETWORK;
  const [ch, mids] = await Promise.all([fetchClearinghouseState(address), fetchAllMids(network)]);
  // coin → { liqPx, side } from the real account book.
  const byCoin = new Map<string, { liqPx: number | null; side: 'long' | 'short' }>();
  for (const p of ch.positions) byCoin.set(p.coin.toUpperCase(), { liqPx: p.liquidationPx, side: p.side });

  // Prior-alert state per session (one query per distinct session — usually 1).
  const priorBySession = new Map<string, Map<string, LiqTier>>();
  for (const c of candidates) {
    if (!priorBySession.has(c.sessionId)) priorBySession.set(c.sessionId, await priorTiersForSession(c.sessionId, now - DEDUP_WINDOW_MS));
  }

  let warned = 0, critical = 0, paged = 0;
  for (const c of candidates) {
    const coin = c.coin.toUpperCase();
    const pos = byCoin.get(coin);
    const markPx = mids[coin];
    if (!pos || pos.liqPx == null || !Number.isFinite(markPx) || markPx <= 0) continue;
    const distPct = liqDistancePct(markPx, pos.liqPx);
    const tier = liqTier(distPct, cfg);
    if (tier === 'warn') warned++;
    if (tier === 'critical') critical++;
    if (tier === 'none') continue;

    const prior = priorBySession.get(c.sessionId)?.get(coin) ?? 'none';
    if (!shouldAlert(tier, prior)) continue;

    const ok = await sendDiscord(formatLiqDiscord({ coin, side: pos.side, tier, distPct, liqPx: pos.liqPx, markPx }));
    // Record state for dedup EVEN if the Discord post failed transiently? No — only
    // record on a successful page so a failed send retries next tick.
    if (ok) {
      paged++;
      priorBySession.get(c.sessionId)?.set(coin, tier);
      await writeAnalysisLog({
        sessionId: c.sessionId,
        source: 'liq-alert',
        severity: tier === 'critical' ? 'danger' : 'warn',
        message: liqLogLine(coin, tier, distPct, pos.liqPx, markPx),
      }).catch(() => {});
    }
  }

  return { scanned: candidates.length, warned, critical, paged };
}
