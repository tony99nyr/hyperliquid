/**
 * /api/cockpit/entry-trigger — manage a resting STOP-ENTRY (trigger-to-open) for a coin.
 *
 *   GET  ?coin=ETH                          → the current resting entry trigger (or null).
 *   POST { action:'place', coin, side, triggerPx, riskUsd, stopFrac, timeframe?, leverage, confirmPhrase }
 *   POST { action:'cancel', coin }
 *
 * This OPENS exposure when it fires (NON-reduce-only), so unlike the protective stop it
 * gets the full open gate: admin + same-origin + rate-limit + the LIVE typed-phrase.
 * Validates breakout/breakdown direction: a LONG entry triggers ABOVE the mark (up-break),
 * a SHORT entry BELOW (down-break). One entry trigger per coin. PAPER is a no-op.
 *
 * Size is computed SERVER-SIDE off the trigger level via the shared risk-based sizer
 * (riskUsd + stopFrac) — never a client coin count; leverage is server-clamped to the
 * coin/timeframe ceiling. NOTE: this only OPENS — it does NOT attach a protective stop;
 * the operator must place one after it fills (surfaced in the modal + the analysis log).
 *
 * ⚠ NEW live signing path (reduceOnly:false trigger) — testnet-rehearse long+short first.
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminAuth, getClientIdentifier } from '@/lib/infrastructure/auth/auth';
import { isSameOrigin } from '@/lib/infrastructure/auth/same-origin';
import { checkRateLimit } from '@/lib/infrastructure/rate-limiting/in-memory-rate-limit';
import { getActiveSession } from '@/lib/cockpit/session-service';
import { fetchAllMids } from '@/lib/hyperliquid/hyperliquid-info-service';
import { validateEnv } from '@/lib/env/env';
import { getTradingMode } from '@/lib/env/mode';
import { findOpenEntryTrigger, placeEntryTriggerOnHl, cancelEntryTriggerOnHl } from '@/lib/trading/entry-trigger-service';
import { entryLiveConfirmPhrase } from '@/app/cockpit/components/entry-modal-helpers';
import { buildOpenProposal } from '@/lib/skills/open-position-business-logic';
import { resolveCoinMaxLeverage, serverValidateLeverage } from '@/lib/trading/leverage-business-logic';
import { HOLD_TIMEFRAMES, type HoldTimeframe } from '@/lib/cockpit/stop-suggestion-business-logic';
import { writeAnalysisLog } from '@/lib/cockpit/analysis-log-service';
import { extractErrorMessage } from '@/lib/infrastructure/logging/logger';
import { randomUUID } from 'node:crypto';

export const dynamic = 'force-dynamic';

const ENTRY_MAX_PER_MIN = 10;
const MAX_DIST_FRAC = 0.5;
const MIN_DIST_FRAC = 0.001; // a breakout level can sit close to the mark, but not AT it
// Server-side stop floor — a near-zero stop fraction would EXPLODE the risk-based
// size (sz = riskUsd / (triggerPx*stopFrac)) into instant liquidation. Mirrors the
// open-position route; the client slider is advisory, the server refuses below this.
const MIN_STOP_FRAC = 0.005; // 0.5%

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) : NaN;
  return Number.isFinite(n) ? n : null;
}
function summary(s: Awaited<ReturnType<typeof findOpenEntryTrigger>>) {
  return s ? { oid: s.oid, triggerPx: s.triggerPx, sz: s.sz, side: s.side === 'B' ? 'long' : 'short' } : null;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!(await verifyAdminAuth(request))) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
  const coin = request.nextUrl.searchParams.get('coin')?.trim().toUpperCase() ?? '';
  if (!coin) return NextResponse.json({ ok: false, error: 'coin required' }, { status: 400 });
  try {
    return NextResponse.json({ ok: true, entry: summary(await findOpenEntryTrigger(coin)) });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMessage(err) }, { status: 502 });
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!(await verifyAdminAuth(request))) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
  if (!isSameOrigin(request)) {
    return NextResponse.json({ ok: false, error: 'Cross-origin request rejected' }, { status: 403 });
  }
  const limit = checkRateLimit(`entry-trigger:${getClientIdentifier(request)}`, ENTRY_MAX_PER_MIN, 60_000);
  if (!limit.allowed) return NextResponse.json({ ok: false, error: 'Too many requests' }, { status: 429 });

  let body: { action?: unknown; coin?: unknown; side?: unknown; triggerPx?: unknown; riskUsd?: unknown; stopFrac?: unknown; timeframe?: unknown; leverage?: unknown; confirmPhrase?: unknown };
  try { body = (await request.json()) as typeof body; } catch { return NextResponse.json({ ok: false, error: 'Invalid body' }, { status: 400 }); }
  const action = body.action === 'place' || body.action === 'cancel' ? body.action : null;
  const coin = typeof body.coin === 'string' ? body.coin.trim().toUpperCase() : '';
  if (!action) return NextResponse.json({ ok: false, error: "action must be 'place' or 'cancel'" }, { status: 400 });
  if (!coin) return NextResponse.json({ ok: false, error: 'coin required' }, { status: 400 });

  const session = await getActiveSession();
  if (!session) return NextResponse.json({ ok: false, error: 'No active session' }, { status: 409 });

  // ----- CANCEL -----
  if (action === 'cancel') {
    try {
      const existing = await findOpenEntryTrigger(coin);
      if (!existing) return NextResponse.json({ ok: false, error: `No resting ${coin} entry trigger to cancel` }, { status: 409 });
      const res = await cancelEntryTriggerOnHl(coin, existing.oid);
      await writeAnalysisLog({ sessionId: session.id, source: 'entry-trigger', severity: 'info', message: `CANCEL ENTRY: ${coin} oid ${existing.oid} (${res.pushed ? 'pushed' : 'paper'}).` }).catch(() => {});
      return NextResponse.json({ ok: true, action, pushed: res.pushed });
    } catch (err) {
      return NextResponse.json({ ok: false, error: `Cancel failed: ${extractErrorMessage(err)}` }, { status: 502 });
    }
  }

  // ----- PLACE -----
  // The position side to OPEN (long = up-break buy; short = down-break sell).
  const side = body.side === 'long' || body.side === 'short' ? body.side : null;
  const orderSide = side === 'long' ? 'buy' : 'sell'; // OrderSide for the shared sizer
  const triggerPx = num(body.triggerPx);
  const riskUsd = num(body.riskUsd);
  const stopFrac = num(body.stopFrac);
  if (!side) return NextResponse.json({ ok: false, error: "side must be 'long' or 'short'" }, { status: 400 });
  if (triggerPx == null || triggerPx <= 0) return NextResponse.json({ ok: false, error: 'triggerPx must be positive' }, { status: 400 });
  if (riskUsd == null || riskUsd <= 0) return NextResponse.json({ ok: false, error: 'riskUsd must be positive' }, { status: 400 });
  if (stopFrac == null || stopFrac >= 1) return NextResponse.json({ ok: false, error: 'stopFrac must be in (0, 1)' }, { status: 400 });
  if (stopFrac < MIN_STOP_FRAC) {
    return NextResponse.json({ ok: false, error: `stopFrac too tight — min ${(MIN_STOP_FRAC * 100).toFixed(1)}% (a tighter stop would oversize the position into liquidation)` }, { status: 422 });
  }

  // Validate the optional hold timeframe (allowlist) — it tightens the leverage cap.
  const timeframe = typeof body.timeframe === 'string' ? body.timeframe : null;
  if (timeframe !== null && !(timeframe in HOLD_TIMEFRAMES)) {
    return NextResponse.json({ ok: false, error: 'invalid timeframe' }, { status: 400 });
  }
  const tfCeiling = timeframe ? HOLD_TIMEFRAMES[timeframe as HoldTimeframe].maxLeverage : Infinity;
  // SERVER-VALIDATE leverage to [1, min(coinMax, tfCeiling)] — never trust the client.
  const coinMax = Math.min(resolveCoinMaxLeverage(coin, null), tfCeiling);
  const leverage = serverValidateLeverage(body.leverage, coinMax, 1);

  // One entry trigger per coin — cancel first to replace.
  try {
    if (await findOpenEntryTrigger(coin)) {
      return NextResponse.json({ ok: false, error: `A ${coin} entry trigger already rests — cancel it first to replace.`, hasEntry: true }, { status: 409 });
    }
  } catch (e) {
    return NextResponse.json({ ok: false, error: `Couldn't verify resting ${coin} entry triggers — retry. (${extractErrorMessage(e)})` }, { status: 502 });
  }

  // Fresh mark (uncached) — validate the breakout/breakdown direction.
  const mids = await fetchAllMids(validateEnv().HL_NETWORK, { uncached: true });
  const markPx = mids[coin];
  if (!Number.isFinite(markPx) || markPx <= 0) return NextResponse.json({ ok: false, error: `No live ${coin} mark — try again` }, { status: 503 });
  // A LONG entry triggers on an UP-break (above the mark); a SHORT on a DOWN-break (below).
  if (side === 'long' ? triggerPx <= markPx : triggerPx >= markPx) {
    return NextResponse.json({ ok: false, error: `A ${side} breakout entry must trigger ${side === 'long' ? 'above' : 'below'} the mark ($${markPx}).` }, { status: 422 });
  }
  const distFrac = Math.abs(markPx - triggerPx) / markPx;
  if (distFrac > MAX_DIST_FRAC) return NextResponse.json({ ok: false, error: `Trigger is > ${MAX_DIST_FRAC * 100}% from the mark — check the price.` }, { status: 422 });
  if (distFrac < MIN_DIST_FRAC) return NextResponse.json({ ok: false, error: `Trigger is < ${MIN_DIST_FRAC * 100}% from the mark — it would fire instantly.` }, { status: 422 });

  // SIZE SERVER-SIDE off the TRIGGER level via the SHARED risk-based sizer (never trust
  // a client coin count) — the order fills AT triggerPx, so size against that, not the
  // current mark. sz = riskUsd / (triggerPx * stopFrac). Warnings ⇒ refuse.
  const proposal = buildOpenProposal({
    sessionId: session.id,
    coin,
    side: orderSide,
    entryPx: triggerPx,
    riskUsd,
    stopDistanceFrac: stopFrac,
    leverage,
    clientIntentId: randomUUID(),
    now: Date.now(),
    thesis: `Breakout ${side} ${coin} @ ${triggerPx}`,
  });
  if (proposal.warnings.length > 0) {
    return NextResponse.json({ ok: false, error: `Invalid setup: ${proposal.warnings.join(' ')}` }, { status: 422 });
  }
  const sizeCoins = proposal.intent.sz;
  if (!(sizeCoins > 0)) return NextResponse.json({ ok: false, error: 'Computed size is zero — raise risk or widen the stop.' }, { status: 422 });

  // LIVE needs the exact "side coin" phrase (this OPENS exposure — parity with open-position).
  if (getTradingMode() === 'live') {
    const typed = typeof body.confirmPhrase === 'string' ? body.confirmPhrase.trim().toLowerCase() : '';
    const required = entryLiveConfirmPhrase(orderSide, coin);
    if (typed !== required) {
      return NextResponse.json({ ok: false, error: `LIVE confirm phrase mismatch — type exactly: ${required}` }, { status: 422 });
    }
  }

  try {
    const res = await placeEntryTriggerOnHl(coin, triggerPx, sizeCoins, side, leverage);
    await writeAnalysisLog({ sessionId: session.id, source: 'entry-trigger', severity: 'info', message: `PLACE ENTRY: ${coin} ${side} ${sizeCoins} @ trigger $${triggerPx} · ${leverage}x · risk $${riskUsd} (${res.pushed ? `pushed oid ${res.oid}` : 'paper'}). Opens WITHOUT a stop — operator must add one after fill.` }).catch(() => {});
    return NextResponse.json({ ok: true, action, pushed: res.pushed, oid: res.oid, triggerPx, sizeCoins });
  } catch (err) {
    return NextResponse.json({ ok: false, error: `Place failed: ${extractErrorMessage(err)}` }, { status: 502 });
  }
}
