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
  // Uncached: the cron reads once per tick and must see a fresh mark (never memoized).
  const mids = await fetchAllMids(validateEnv().HL_NETWORK, { uncached: true });
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
      const ch = await fetchClearinghouseState(address, { uncached: true });
      if (!ch.stale) {
        hlPosition = ch.positions.find((p) => p.coin.toUpperCase() === coin) ?? null;
        // Ledger says open but the VENUE shows this coin flat (e.g. a manual HL
        // close the cockpit ledger hasn't reconciled). Nothing to close — skip,
        // rather than submit a reduce-only on a flat venue position, which no-fills
        // and would re-alert every cycle forever.
        if (hlPosition === null) {
          return { fired: false, reason: null, skipped: 'flat-on-venue' };
        }
      }
    } catch {
      hlPosition = null; // fall back to loss + health triggers
    }
  }

  // 4) Re-assess health from fresh candles. BEST-EFFORT: a health-engine failure
  //    must NEVER gate the liq/loss triggers (the most important guards). On a
  //    failure, health is null → its triggers skip, liq/loss still evaluate.
  let healthScore: number | null = null;
  let alerts: string[] = [];
  try {
    const h = await assessHealth(coin, { side: position.side, entryPx: position.avgEntryPx }, now);
    healthScore = Number.isFinite(h.score) ? h.score : null;
    alerts = h.alerts;
  } catch {
    // swallow — liq/loss triggers carry on without health
  }

  // 5) The decision (PURE).
  const inputs = buildAutoExitInputs({
    position,
    markPx,
    hlPosition,
    healthScore,
    alerts,
  });
  const thresholds = resolveThresholds(config, hlPosition != null);
  const decision = shouldAutoExit(inputs, thresholds);

  if (decision.dataDegraded) {
    await alert(sessionId, `AUTO-EXIT data degraded for ${coin} (a trigger could not be evaluated) — verify the feed.`);
  }
  if (!decision.exit) {
    return { fired: false, reason: null, skipped: 'condition-not-met', dataDegraded: decision.dataDegraded };
  }

  // 6) Claim the lock — SERIALIZES concurrent NAS+cron attempts (the partial unique
  //    index admits one active lock per key). Release policy is deliberate:
  //      • KNOWN terminal outcome (clean close / no-fill / partial / nothing-to-close)
  //        → release immediately, so a freshly reopened position on the same coin is
  //        guarded right away and a partial/no-fill retries next cycle.
  //      • UNKNOWN outcome (executeIntent THREW — the order may have filled on HL
  //        before the response was lost) → do NOT release. Hold until expiry so a
  //        blind retry can't submit a SECOND close. The stuck-lock reaper frees it
  //        after lockTtlMs.
  const lock = await acquireExitLock(sessionId, coin, {
    reason: decision.reason ?? 'auto-exit',
    nowMs: now,
    ttlMs: config.lockTtlMs,
  });
  if (!lock) {
    return { fired: false, reason: decision.reason, skipped: 'locked' };
  }

  // Release on a KNOWN outcome; best-effort so a release failure can't mask the
  // (already-completed) exit result.
  const release = async (outcome: string): Promise<void> => {
    try {
      await releaseExitLock(lock.id, outcome);
    } catch {
      // swallow — the outcome stands; the stuck-lock reaper covers a missed release
    }
  };

  // 7) Build the reduce-only close from the AUTHORITATIVE venue exposure when we have
  //    it (clearinghouse). A cockpit-ledger size that UNDER-states the live position
  //    (manual HL trade, fill drift) would otherwise under-close and strand exposure
  //    — the worst failure for a safety net. Fall back to the ledger in paper /
  //    no-address. The intent is derived ONLY here (caller cannot supply side/size).
  const closeSource =
    hlPosition != null
      ? {
          coin,
          side: hlPosition.side,
          sz: hlPosition.size,
          avgEntryPx: hlPosition.entryPx ?? position.avgEntryPx,
          realizedPnlUsd: 0,
          feesPaidUsd: 0,
        }
      : position;
  const intent = buildMarketReduceOnlyClose(closeSource, { clientIntentId: randomUUID(), sessionId, now });
  if (!intent) {
    await release('flat'); // known: nothing to close
    return { fired: false, reason: decision.reason, skipped: 'flat' };
  }

  let fill: CanonicalFill;
  try {
    fill = await executeIntent(intent);
  } catch (e) {
    // UNKNOWN outcome — HOLD the lock (do not release) so a blind retry can't double
    // a close that may have actually filled. The reaper frees it after lockTtlMs.
    const msg = e instanceof Error ? e.message : String(e);
    await alert(sessionId, `🚨 AUTO-EXIT FAILED for ${coin} (${decision.reason}): ${msg}. Outcome UNKNOWN — lock held ${Math.round(config.lockTtlMs / 1000)}s; verify the position and Safe-Exit if still open.`);
    throw e; // surface to the caller (route → 500, cron → logged)
  }

  if (fill.sz <= 0) {
    await release('no-fill'); // known: nothing happened — retry next cycle
    await alert(sessionId, `🚨 AUTO-EXIT got NO FILL for ${coin} (${decision.reason}). Position STILL OPEN — will retry next cycle.`);
    return { fired: false, reason: decision.reason, skipped: 'no-fill' };
  }

  // Trust the fill's own partial flag (epsilon-aware at the exchange layer); guard
  // the size compare with an epsilon so a rounded full fill isn't "partial".
  const partial = fill.partial || fill.sz < intent.sz - 1e-9;
  if (partial) {
    await release('partial'); // retry the remainder next cycle
    await alert(
      sessionId,
      `🚨 AUTO-EXIT PARTIAL for ${coin} (${decision.reason}): closed ${fill.sz}/${intent.sz} @ $${fill.px}. Remainder retries next cycle.`,
    );
  } else {
    await release('closed'); // clean close → free so a reopened position is guarded
    await alert(
      sessionId,
      `AUTO-EXIT fired (${decision.reason}): ${intent.side} ${fill.sz} ${coin} @ $${fill.px} reduce-only (source=${fill.source}).`,
    );
  }
  return { fired: true, reason: decision.reason, skipped: null, fill, partial };
}
