/**
 * Scoped agent actions (ADR-0009): the execution site.
 *
 * Two actions, both risk-reducing by construction:
 *  - tightenStop places a tighter reduce-only stop FIRST, confirms that it rests, and
 *    only then cancels the older ones, so the position is never without a stop.
 *  - reduceClose submits a reduce-only MARKET close built from the venue position,
 *    read while it holds the exit lock. The caller supplies a fraction only, never a
 *    side or a size.
 *
 * Fail closed: every unreadable input is a refusal. Live mainnet deployment and live
 * session only (lane boundary): a paper session never reaches the exchange from here.
 */

import { randomUUID } from 'node:crypto';
import { getActiveSession } from '@/lib/cockpit/session-service';
import { executeIntent } from '@/lib/trading/fill-source';
import { buildMarketReduceOnlyClose } from '@/lib/trading/safe-exit-business-logic';
import { fetchAllMids, fetchClearinghouseState, fetchPerpMeta, type HlOpenOrder, type HlPosition } from '@/lib/hyperliquid/hyperliquid-info-service';
import { getTradingMode } from '@/lib/env/mode';
import { validateEnv } from '@/lib/env/env';
import { writeAnalysisLog } from '@/lib/cockpit/analysis-log-service';
import { sendDiscord } from '@/lib/infrastructure/notify/discord-notify';
import { loadAutoExitConfig, getHlAccountAddress } from '@/lib/auto-exit/auto-exit-config';
import { acquireExitLock, releaseExitLock } from '@/lib/auto-exit/auto-exit-lock-service';
import { PreSubmitError } from '@/lib/trading/pre-submit-error';
import { findOpenStops, placeStopOnHl, cancelStopOnHl } from '@/lib/trading/stop-order-service';
import { checkReduce, checkTightenStop, flooredCloseSize, tightestStopPx } from '@/lib/agent-actions/agent-action-business-logic';

const DISCORD_NAME = 'HL Agent Action';

export interface AgentActionResult {
  /** True when the exchange accepted the action. */
  done: boolean;
  /** Why nothing happened, when done is false. */
  skipped: string | null;
  coin: string;
  side?: 'long' | 'short';
  markPx?: number;
  /** tighten-stop: the new and the replaced stop prices, and old stops that still rest. */
  newStopPx?: number;
  oldStopPx?: number | null;
  uncancelledOids?: number[];
  /** tighten-stop: true when the new stop triggered early and a stop was placed again for the rest. */
  reprotected?: boolean;
  /** reduce: the filled size and price, and whether the fill was partial. */
  filledSz?: number;
  fillPx?: number;
  partial?: boolean;
}

type Skipped = { skipped: string };

async function report(sessionId: string, severity: 'info' | 'danger', message: string): Promise<void> {
  await writeAnalysisLog({ sessionId, source: 'agent-action', severity, message }).catch(() => {});
  await sendDiscord(message, DISCORD_NAME).catch(() => false);
}

/** The live session of a live MAINNET deployment, or a refusal. The account read is mainnet-only. */
async function loadLiveSession(): Promise<{ sessionId: string; address: string } | Skipped> {
  if (getTradingMode() !== 'live') return { skipped: 'not-live-deployment' };
  if (validateEnv().HL_NETWORK !== 'mainnet') return { skipped: 'not-mainnet' };
  const session = await getActiveSession();
  if (!session || session.mode !== 'live') return { skipped: 'no-live-session' };
  const address = getHlAccountAddress();
  if (!address) return { skipped: 'no-account-address' };
  return { sessionId: session.id, address };
}

/** The venue position and a fresh mark for `coin`. Any gap is a refusal. */
async function loadVenue(address: string, coin: string): Promise<{ position: HlPosition; markPx: number } | Skipped> {
  let position: HlPosition | null;
  try {
    const ch = await fetchClearinghouseState(address, { uncached: true });
    if (ch.stale || ch.positionsListed !== true) return { skipped: 'account-unreadable' };
    position = ch.positions.find((p) => p.coin.toUpperCase() === coin) ?? null;
  } catch {
    return { skipped: 'account-unreadable' };
  }
  if (!position || !(position.size > 0)) return { skipped: 'flat' };

  let markPx: number;
  try {
    markPx = (await fetchAllMids('mainnet', { uncached: true }))[coin];
  } catch {
    return { skipped: 'bad-mark' };
  }
  if (!Number.isFinite(markPx) || markPx <= 0) return { skipped: 'bad-mark' };
  return { position, markPx };
}

export async function tightenStop(args: { coin: string; triggerPx: number }): Promise<AgentActionResult> {
  const coin = args.coin.toUpperCase();
  const live = await loadLiveSession();
  if ('skipped' in live) return { done: false, skipped: live.skipped, coin };
  const venue = await loadVenue(live.address, coin);
  if ('skipped' in venue) return { done: false, skipped: venue.skipped, coin };
  const { sessionId } = live;
  const { position, markPx } = venue;
  const base = { coin, side: position.side, markPx };

  let oldStops: HlOpenOrder[];
  try {
    oldStops = await findOpenStops(coin);
  } catch {
    return { ...base, done: false, skipped: 'cannot-read-resting-stop' };
  }
  // A position-attached stop is one leg of a stop and take-profit pair. A standalone
  // replacement would outlive the pair, so the operator moves a bracket in the cockpit.
  if (oldStops.some((o) => o.isPositionTpsl === true)) return { ...base, done: false, skipped: 'position-attached-stop' };
  // A stop with no readable price cannot be compared, so the move cannot be proven tighter.
  if (oldStops.some((o) => o.triggerPx == null || !Number.isFinite(o.triggerPx) || o.triggerPx <= 0)) {
    return { ...base, done: false, skipped: 'bad-resting-stop' };
  }
  const oldStopPx = tightestStopPx(position.side, oldStops.map((o) => o.triggerPx as number));
  const check = checkTightenStop({ side: position.side, markPx, newPx: args.triggerPx, oldPx: oldStopPx });
  if (!check.ok) return { ...base, done: false, skipped: check.reason, oldStopPx };

  // Place the NEW stop first. A throw is an UNKNOWN outcome: the stop may rest.
  let newOid: number | null;
  try {
    const placed = await placeStopOnHl(coin, args.triggerPx, position.size, position.side);
    if (!placed.pushed) return { ...base, done: false, skipped: 'stop-not-pushed', oldStopPx };
    newOid = placed.oid;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await report(sessionId, 'danger', `AGENT ACTION FAILED: ${coin} stop @ ${args.triggerPx} threw (${msg}). Outcome UNKNOWN: the old stop still rests. Read the open orders before any retry.`);
    return { ...base, done: false, skipped: 'stop-place-unknown', oldStopPx };
  }

  // Cancel the old stops ONLY when the new stop is confirmed resting. A new stop that
  // already triggered, or that cannot be read back, must not cost the old protection.
  let confirmed = false;
  try {
    confirmed = newOid != null && (await findOpenStops(coin)).some((o) => o.oid === newOid);
  } catch {
    confirmed = false;
  }
  if (!confirmed) {
    await report(sessionId, 'danger', `AGENT ACTION: ${coin} stop @ ${args.triggerPx} was sent but is not confirmed resting (it may have triggered). The old stops are kept: read the position and the open orders.`);
    return { ...base, done: false, skipped: 'new-stop-not-confirmed', oldStopPx };
  }

  const failedCancels = new Set<number>();
  for (const old of oldStops) {
    try {
      await cancelStopOnHl(coin, old.oid);
    } catch {
      failedCancels.add(old.oid); // both stops rest (reduce-only): the tighter one governs
    }
  }

  // Place, confirm and cancel are separate exchange calls, so read the result back. The
  // action is done only when the NEW stop still rests, or when it triggered and closed
  // the whole position. Every other state is reported as not done.
  const resting = await findOpenStops(coin).catch(() => null);
  const restingOids = new Set((resting ?? []).map((o) => o.oid));
  const uncancelledOids = oldStops.map((o) => o.oid).filter((oid) => (resting == null ? failedCancels.has(oid) : restingOids.has(oid)));
  const oldNote = uncancelledOids.length > 0 ? ` Old stop oid ${uncancelledOids.join(', ')} still rests: cancel it by hand.` : '';
  const moved = `${coin} ${position.side} stop ${oldStopPx ?? 'none'} -> ${args.triggerPx} (mark ${markPx}, size ${position.size})`;
  const result = { ...base, newStopPx: args.triggerPx, oldStopPx, uncancelledOids };
  const incomplete = async (skipped: string, why: string): Promise<AgentActionResult> => {
    await report(sessionId, 'danger', `AGENT ACTION INCOMPLETE: ${moved}. ${why}${oldNote}`);
    return { ...result, done: false, skipped };
  };

  if (resting == null) return incomplete('unverified', 'The new stop was confirmed, but the result could not be read back: check the resting stops.');
  if (restingOids.has(newOid as number)) {
    await report(sessionId, oldNote ? 'danger' : 'info', `AGENT ACTION: ${moved}.${oldNote}`);
    return { ...result, done: true, skipped: null };
  }

  // The new stop no longer rests: it triggered between the confirm and the cancel.
  const after = await loadVenue(live.address, coin);
  if ('skipped' in after && after.skipped === 'flat') {
    await report(sessionId, 'danger', `AGENT ACTION: ${moved}. The new stop triggered and closed the position.${oldNote}`);
    return { ...result, done: true, skipped: null };
  }
  if ('skipped' in after) return incomplete('unverified', 'The new stop triggered and the position could not be read: check it now.');
  const rest = `${after.position.size} ${coin} ${after.position.side}`;
  if (resting.length > 0) return incomplete('remainder-on-old-stop', `The new stop triggered and left ${rest} open, protected only by an older stop.`);
  if (after.position.side !== position.side) return incomplete('unprotected', `NO STOP RESTS and the position is now ${rest}: check it now.`);

  // No stop rests on an open remainder: place the stop again and confirm that it rests.
  // If the mark already passed the price, the stop fires at once, which is what it is for.
  let againOid: number | null = null;
  try {
    const again = await placeStopOnHl(coin, args.triggerPx, after.position.size, after.position.side);
    againOid = again.pushed ? again.oid : null;
  } catch {
    againOid = null;
  }
  const againRests = againOid != null && (await findOpenStops(coin).then((stops) => stops.some((o) => o.oid === againOid)).catch(() => false));
  if (!againRests) return incomplete('unprotected', `The new stop triggered and left ${rest} open. A replacement stop is NOT confirmed resting: check the position now.`);
  await report(sessionId, 'danger', `AGENT ACTION: ${moved}. The new stop triggered and left ${rest} open: a stop @ ${args.triggerPx} rests again for the rest.`);
  return { ...result, done: true, skipped: null, reprotected: true };
}

export async function reduceClose(args: { coin: string; fraction: number }): Promise<AgentActionResult> {
  const coin = args.coin.toUpperCase();
  const live = await loadLiveSession();
  if ('skipped' in live) return { done: false, skipped: live.skipped, coin };
  const { sessionId } = live;
  const now = Date.now();
  const pct = `${(args.fraction * 100).toFixed(0)}%`;

  // The same lock as the Layer-1 auto-exit, taken BEFORE the venue read, so the close is
  // built from a position that the auto-exit cannot close underneath it.
  const lock = await acquireExitLock(sessionId, coin, { reason: 'agent-reduce', nowMs: now, ttlMs: loadAutoExitConfig().lockTtlMs });
  if (!lock) return { done: false, skipped: 'locked', coin };
  const refuse = async (skipped: string, extra: Partial<AgentActionResult> = {}): Promise<AgentActionResult> => {
    await releaseExitLock(lock.id, skipped).catch(() => {});
    return { ...extra, done: false, skipped, coin };
  };

  const venue = await loadVenue(live.address, coin);
  if ('skipped' in venue) return refuse(venue.skipped);
  const { position, markPx } = venue;
  const base = { side: position.side, markPx };

  let szDecimals: number | undefined;
  try {
    szDecimals = (await fetchPerpMeta('mainnet')).find((a) => a.name.toUpperCase() === coin)?.szDecimals;
  } catch {
    szDecimals = undefined;
  }
  if (szDecimals == null) return refuse('lot-size-unreadable', base);
  const check = checkReduce({ sz: position.size, markPx, fraction: args.fraction, szDecimals });
  if (!check.ok) return refuse(check.reason, base);

  // Build the close with the size that the venue submits (floored to the lot), so the
  // exchange layer and this code compare a fill against the same number.
  const sentSz = flooredCloseSize(position.size, args.fraction, szDecimals);
  const intent = buildMarketReduceOnlyClose(
    { coin, side: position.side, sz: sentSz, avgEntryPx: position.entryPx ?? markPx, realizedPnlUsd: 0, feesPaidUsd: 0 },
    { clientIntentId: randomUUID(), sessionId, now },
  );
  if (!intent) return refuse('flat', base);

  let fill: Awaited<ReturnType<typeof executeIntent>>;
  try {
    fill = await executeIntent({ ...intent, origin: 'operator' });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // A PreSubmitError means that nothing reached the exchange: a known outcome.
    if (e instanceof PreSubmitError) {
      await report(sessionId, 'danger', `AGENT ACTION FAILED: ${coin} reduce ${pct} was not sent (${msg}). The position is unchanged.`);
      return refuse('not-submitted', base);
    }
    // UNKNOWN outcome: the order may have filled. Hold the lock until it expires, so a
    // blind retry cannot submit a second close.
    await report(sessionId, 'danger', `AGENT ACTION FAILED: ${coin} reduce ${pct} threw (${msg}). Outcome UNKNOWN: verify the position before any retry.`);
    throw e;
  }
  if (!(fill.sz > 0)) {
    await report(sessionId, 'danger', `AGENT ACTION: ${coin} reduce ${pct} got NO FILL. The position is unchanged.`);
    return refuse('no-fill', base);
  }
  const partial = fill.partial === true || fill.sz < sentSz - 1e-9;
  await releaseExitLock(lock.id, partial ? 'partial' : 'closed').catch(() => {});

  // A full close leaves the resting stops on the exchange. This code never removes a
  // stop, so it names them for the operator: a leftover stop can close a later position.
  let leftover = '';
  if (args.fraction === 1 && !partial) {
    const oids = await findOpenStops(coin).then((stops) => stops.map((o) => o.oid)).catch(() => null);
    if (oids == null) leftover = ' Could not read the resting stops: check for a leftover stop.';
    else if (oids.length > 0) leftover = ` Resting stop oid ${oids.join(', ')} remains: cancel it in the cockpit.`;
  }
  await report(
    sessionId,
    partial || leftover ? 'danger' : 'info',
    `AGENT ACTION: ${coin} ${position.side} reduced ${pct}: ${intent.side} ${fill.sz}/${sentSz} @ ${fill.px} reduce-only${partial ? ' (PARTIAL)' : ''}.${leftover}`,
  );
  return { ...base, coin, done: true, skipped: null, filledSz: fill.sz, fillPx: fill.px, partial };
}
