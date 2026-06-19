/**
 * performRiskExit — the ONE autonomous exit-only execution site (Layer 1).
 *
 * Given a candidate (sessionId, coin), it RE-VERIFIES the risk condition from
 * fresh data server-side (never trusts the caller's "please exit"), and only if a
 * trigger genuinely fires does it acquire the per-(session,coin) lock and submit a
 * reduce-only MARKET close via the same executeIntent seam every trade rides.
 *
 * EXIT-ONLY by construction: the intent is built ONLY by buildMarketReduceOnlyClose
 * from the live position (opposite side, reduceOnly:true). The caller cannot supply
 * a side/size — so this can never open, add, or flip. The worst case is "flattened
 * out of the market."
 *
 * Both the HTTP route (/api/cockpit/risk-exit, for the NAS/manual) and the Vercel
 * cron backup call THIS. The kill-switch (AUTO_EXIT_ENABLED) is checked by the
 * callers before reaching here; this function assumes it has been authorized.
 */

import { randomUUID } from 'node:crypto';
import { loadPosition } from '@/lib/cockpit/fill-persistence-service';
import { executeIntent } from '@/lib/trading/fill-source';
import { buildMarketReduceOnlyClose } from '@/lib/trading/safe-exit-business-logic';
import { assessHealth } from '@/lib/health/health-engine';
import { fetchAllMids, fetchClearinghouseState } from '@/lib/hyperliquid/hyperliquid-info-service';
import { getTradingMode } from '@/lib/env/mode';
import { validateEnv } from '@/lib/env/env';
import { writeAnalysisLog } from '@/lib/cockpit/analysis-log-service';
import { shouldAutoExit } from '@/lib/trading/auto-exit-business-logic';
import { buildAutoExitInputs, resolveThresholds } from '@/lib/auto-exit/risk-inputs-business-logic';
import { loadAutoExitConfig, getHlAccountAddress } from '@/lib/auto-exit/auto-exit-config';
import { acquireExitLock, releaseExitLock } from '@/lib/auto-exit/auto-exit-lock-service';
import type { CanonicalFill } from '@/types/fill';

export interface RiskExitResult {
  /** True ⇒ a reduce-only close was submitted and (at least partially) filled. */
  fired: boolean;
  /** The trigger reason when fired (or the would-be reason). */
  reason: string | null;
  /** Why nothing fired: 'flat' | 'bad-mark' | 'condition-not-met' | 'locked' | 'no-fill'. */
  skipped: string | null;
  /** A critical input was unusable; the operator was alerted to re-check the feed. */
  dataDegraded?: boolean;
  fill?: CanonicalFill;
  partial?: boolean;
}

/** Best-effort loud alert via the danger-severity analysis log (the cockpit's alert surface). */
async function alert(sessionId: string, message: string): Promise<void> {
  try {
    await writeAnalysisLog({ sessionId, source: 'auto-exit', severity: 'danger', message });
  } catch {
    // never let logging failure mask the exit outcome
  }
}

export async function performRiskExit(args: {
  sessionId: string;
  coin: string;
  /** The detector's hint (audited; the server re-derives the authoritative reason). */
  triggerHint?: string;
  now: number;
}): Promise<RiskExitResult> {
  const { sessionId, now } = args;
  const coin = args.coin.toUpperCase();
  const config = loadAutoExitConfig();

  // 1) Live position — nothing to do if flat.
  const position = await loadPosition(sessionId, coin);
  if (!position || position.side === 'flat' || position.sz <= 0) {
    return { fired: false, reason: null, skipped: 'flat' };
  }

  // 2) Fresh mark. A bad mark is itself a risk signal — alert, don't silently pass.
  const mids = await fetchAllMids(validateEnv().HL_NETWORK);
  const markPx = mids[coin];
  if (!Number.isFinite(markPx) || markPx <= 0) {
    await alert(sessionId, `AUTO-EXIT could not read a valid mark for ${coin} — skipping this cycle (feed issue).`);
    return { fired: false, reason: null, skipped: 'bad-mark', dataDegraded: true };
  }

  // 3) Clearinghouse (live + account address) for liq/margin; null otherwise.
  let hlPosition = null;
  const address = getHlAccountAddress();
  if (getTradingMode() === 'live' && address) {
    try {
      const ch = await fetchClearinghouseState(address);
      if (!ch.stale) hlPosition = ch.positions.find((p) => p.coin.toUpperCase() === coin) ?? null;
    } catch {
      hlPosition = null; // fall back to loss + health triggers
    }
  }

  // 4) Re-assess health from fresh candles (authoritative, same as the watcher).
  const health = await assessHealth(coin, { side: position.side, entryPx: position.avgEntryPx }, now);

  // 5) The decision (PURE).
  const inputs = buildAutoExitInputs({
    position,
    markPx,
    hlPosition,
    healthScore: health.score,
    alerts: health.alerts,
  });
  const thresholds = resolveThresholds(config, hlPosition != null);
  const decision = shouldAutoExit(inputs, thresholds);

  if (decision.dataDegraded) {
    await alert(sessionId, `AUTO-EXIT data degraded for ${coin} (a trigger could not be evaluated) — verify the feed.`);
  }
  if (!decision.exit) {
    return { fired: false, reason: null, skipped: 'condition-not-met', dataDegraded: decision.dataDegraded };
  }

  // 6) Claim the lock (anti-double-close + cooldown). Loser backs off.
  const lock = await acquireExitLock(sessionId, coin, {
    reason: decision.reason ?? 'auto-exit',
    nowMs: now,
    ttlMs: config.cooldownMs,
  });
  if (!lock) {
    return { fired: false, reason: decision.reason, skipped: 'locked' };
  }

  // 7) Build + submit the reduce-only close. The intent is derived ONLY here.
  const intent = buildMarketReduceOnlyClose(position, { clientIntentId: randomUUID(), sessionId, now });
  if (!intent) {
    await releaseExitLock(lock.id, 'flat');
    return { fired: false, reason: decision.reason, skipped: 'flat' };
  }

  let fill: CanonicalFill;
  try {
    fill = await executeIntent(intent);
  } catch (e) {
    await releaseExitLock(lock.id, 'failed'); // free it so the next cycle retries
    const msg = e instanceof Error ? e.message : String(e);
    await alert(sessionId, `🚨 AUTO-EXIT FAILED for ${coin} (${decision.reason}): ${msg}. Position STILL OPEN — manual Safe-Exit may be needed.`);
    throw e; // surface to the caller (route → 500, cron → logged)
  }

  if (fill.sz <= 0) {
    await releaseExitLock(lock.id, 'no-fill');
    await alert(sessionId, `🚨 AUTO-EXIT got NO FILL for ${coin} (${decision.reason}). Position STILL OPEN — will retry next cycle.`);
    return { fired: false, reason: decision.reason, skipped: 'no-fill' };
  }

  const partial = fill.partial || fill.sz < intent.sz;
  if (partial) {
    // Free the lock so the remainder closes next cycle; alert loudly.
    await releaseExitLock(lock.id, 'partial');
    await alert(
      sessionId,
      `🚨 AUTO-EXIT PARTIAL for ${coin} (${decision.reason}): closed ${fill.sz}/${intent.sz} @ $${fill.px}. Remainder retries next cycle.`,
    );
  } else {
    // Clean full close — leave the lock active until expiry (= cooldown).
    await alert(
      sessionId,
      `AUTO-EXIT fired (${decision.reason}): ${intent.side} ${fill.sz} ${coin} @ $${fill.px} reduce-only (source=${fill.source}).`,
    );
  }

  return { fired: true, reason: decision.reason, skipped: null, fill, partial };
}
