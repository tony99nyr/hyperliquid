/**
 * htf-trend drafter: PURE. The live expression of the scout's daily 20-day channel
 * breakout lane (docs/scout/PREREGISTRATION_htf-trend.md; live terms:
 * docs/scout/PREREGISTRATION_htf-trend-live.md).
 *
 * On a new daily breakout the cron service drafts ONE low-size LIVE ladder per coin:
 *   - OPEN at the broken 20-day channel level (short: a 15m close below the 20-day low;
 *     long: a 15m close above the 20-day high). The daily close is already beyond the
 *     level, so the gate is usually met at arm time and the arm shows the instant-fire
 *     confirmation. That is intended: this lane enters WITH the breakout.
 *   - The entry gate closes a few hours after the daily close (entryDeadlineMs). The
 *     late-arm study (scripts/analysis/htf-entry-delay-study.ts) measured the cost of a
 *     late entry; past the deadline the rung can no longer enter.
 *   - STOP: the lane's frozen distance, min(2 x ATR20 / close, 12%), as stopFrac.
 *   - EXIT: one CLOSE rung on the daily channel exit indicator (the daily close through
 *     the opposite 10-day channel). No fixed target, no breakeven move, no adds.
 *
 * The signal maths is the frozen scout read (imported, never edited here). This module
 * only shapes a draft and decides which drafts to make. The operator arms.
 */

import type { CreateLadderInput } from './ladder-service';
import type { HtfTrendRead } from '@/lib/scout/htf-trend-signal-business-logic';
import { entryGateClosed, htfChannelExitIndicatorName, type LadderRung, type LadderSide, type LadderWithRungs } from './ladder-types';
import { DAY_MS, HTF_SETTLE_MS, utcDayStart } from './ladder-htf-exit-business-logic';

/** The lane's universe, in drafting priority order. */
export const HTF_TREND_UNIVERSE: readonly string[] = ['BTC', 'ETH', 'SOL', 'HYPE'];
/** At most this many universe coins in one direction (the scout's MAX_SAME_DIRECTION_MAJORS). */
export const HTF_MAX_SAME_DIRECTION = 2;
export const HTF_MAX_DRAFTS_PER_CYCLE = 2;
/** The scout's event blackout: no new entry from 48 h before a print to 4 h after it. */
export const HTF_BLACKOUT_PRE_MS = 48 * 60 * 60 * 1000;
export const HTF_BLACKOUT_POST_MS = 4 * 60 * 60 * 1000;

const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_RISK_USD = 10;
const DEFAULT_LEVERAGE = 2;
/** Bounds riskUsd / stopFrac when the ATR is unusually small, so the draft stays small. */
const NOTIONAL_CAP_USD = 400;
/** Funding headroom in the loss cap, as an annual rate on the notional over the ladder's
 *  life. Above this rate against the side, the arm refuses on the funding fold-in. */
export const HTF_FUNDING_ALLOWANCE_APR = 0.3;
/** Worst stop fill slips this fraction OF PRICE (mirror of the risk read's tolerance). */
const STOP_SLIPPAGE_OF_PRICE = 0.1;

const round = (x: number): number => Number(x.toFixed(6));

// --- Timing -----------------------------------------------------------------------------

/** Every clock value of the lane, measured from the daily close (00:00 UTC). Kept as one
 *  parameter so a different entry window is a new pre-registration, not a code hunt. */
export interface HtfTrendTiming {
  /** Drafting starts this long after the daily close. */
  settleMs: number;
  /** The entry gate closes this long after the daily close. */
  entryWindowMs: number;
  /** Drafting stops this long before the entry gate closes (time to review and arm). */
  draftCutoffMs: number;
  /** Ladder life from the daily close. Covers the exit rung for the whole hold. */
  expiryDays: number;
}

export const DEFAULT_HTF_TREND_TIMING: HtfTrendTiming = {
  settleMs: HTF_SETTLE_MS,
  entryWindowMs: 4 * HOUR_MS,
  draftCutoffMs: 1 * HOUR_MS,
  expiryDays: 90,
};

export interface HtfDraftWindow {
  /** The daily close this window belongs to (00:00 UTC of the current day). */
  signalCloseMs: number;
  entryDeadlineMs: number;
  /** May the drafter create a draft at `now`? */
  open: boolean;
}

/** The drafting window that contains `now`. PURE. */
export function htfDraftWindow(now: number, timing: HtfTrendTiming = DEFAULT_HTF_TREND_TIMING): HtfDraftWindow {
  const signalCloseMs = utcDayStart(now);
  const entryDeadlineMs = signalCloseMs + timing.entryWindowMs;
  const open = Number.isFinite(now) && now >= signalCloseMs + timing.settleMs && now < entryDeadlineMs - timing.draftCutoffMs;
  return { signalCloseMs, entryDeadlineMs, open };
}

/** Is `now` inside the scout-style event blackout? `msOut` = ms until the nearest print
 *  that is not more than HTF_BLACKOUT_POST_MS in the past (null = no such print). */
export function htfEventBlackout(msOut: number | null): boolean {
  return msOut != null && Number.isFinite(msOut) && msOut <= HTF_BLACKOUT_PRE_MS;
}

// --- Titles (the dedupe key and the setup-family anchor) ----------------------------------

/** UTC date of the daily bar that closed at `signalCloseMs` (the breakout bar). */
export const htfSignalDate = (signalCloseMs: number): string => new Date(signalCloseMs - DAY_MS).toISOString().slice(0, 10);

const TITLE_SUFFIX = '(auto-draft, review and arm)';
// The WHOLE title must match. The housekeeping archives and disarms by this parse, so a
// hand-made ladder that only starts like one of these titles is never touched.
const TITLE_RE = /^([A-Z0-9]+) htf-trend (long|short) (\d{4}-\d{2}-\d{2}) \(auto-draft, review and arm\)$/;

export const htfTrendTitle = (coin: string, side: LadderSide, signalCloseMs: number): string =>
  `${coin.toUpperCase()} htf-trend ${side} ${htfSignalDate(signalCloseMs)} ${TITLE_SUFFIX}`;

/** Parse one of this drafter's titles. Null for any other ladder, and for an edited title. */
export function parseHtfTrendTitle(title: string): { coin: string; side: LadderSide; signalDate: string } | null {
  const m = TITLE_RE.exec(title);
  return m ? { coin: m[1], side: m[2] as LadderSide, signalDate: m[3] } : null;
}

// --- Signal + plan ----------------------------------------------------------------------

export interface HtfTrendSignal {
  coin: string;
  side: LadderSide;
  signalCloseMs: number;
  /** The daily close that broke the channel. */
  closePx: number;
  /** The broken 20-day channel level: the entry gate. */
  channelPx: number;
  /** The lane's frozen stop distance (fraction of the entry). */
  stopFrac: number;
  /** The opposite 10-day channel at signal time. Informational: the level moves each day. */
  exitPx: number;
}

/** The breakout signal in a completed-daily read, or null when the bar did not break out. */
export function htfTrendSignal(coin: string, read: HtfTrendRead, signalCloseMs: number): HtfTrendSignal | null {
  const b = read.breakout;
  if (!b) return null;
  const channelPx = b.side === 'long' ? read.don20High : read.don20Low;
  if (![b.entryPx, channelPx, b.stopFrac, b.exitPx].every((v) => Number.isFinite(v) && v > 0)) return null;
  if (!(b.stopFrac < 1)) return null;
  return { coin: coin.toUpperCase(), side: b.side, signalCloseMs, closePx: b.entryPx, channelPx, stopFrac: b.stopFrac, exitPx: b.exitPx };
}

export interface HtfPlanOpts {
  riskUsd?: number;
  leverage?: number;
  timing?: HtfTrendTiming;
}

/** The sizing and caps of a plan: one source for the plan, the message and the tests. */
export function htfPlanNumbers(sig: HtfTrendSignal, opts: HtfPlanOpts = {}): {
  riskUsd: number;
  notionalUsd: number;
  slippedLossUsd: number;
  maxTotalLossUsd: number;
  maxTotalNotionalUsd: number;
} {
  const timing = opts.timing ?? DEFAULT_HTF_TREND_TIMING;
  const riskUsd = round(Math.min(opts.riskUsd ?? DEFAULT_RISK_USD, NOTIONAL_CAP_USD * sig.stopFrac));
  const notionalUsd = riskUsd / sig.stopFrac;
  // The stop sits stopFrac from the entry and can fill 10% of PRICE beyond the stop:
  // long loss = notional x (0.1 + 0.9 x stopFrac), short = notional x (0.1 + 1.1 x stopFrac).
  const slippedLossUsd =
    notionalUsd * (STOP_SLIPPAGE_OF_PRICE + (sig.side === 'long' ? 1 - STOP_SLIPPAGE_OF_PRICE : 1 + STOP_SLIPPAGE_OF_PRICE) * sig.stopFrac);
  const fundingAllowanceUsd = notionalUsd * HTF_FUNDING_ALLOWANCE_APR * (timing.expiryDays / 365);
  return {
    riskUsd,
    notionalUsd,
    slippedLossUsd,
    maxTotalLossUsd: Math.ceil(slippedLossUsd * 1.05 + fundingAllowanceUsd),
    maxTotalNotionalUsd: Math.ceil(notionalUsd * 1.3),
  };
}

/** Build the LIVE draft ladder for one breakout signal. PURE + fixture-tested. */
export function buildHtfTrendLadderPlan(sig: HtfTrendSignal, opts: HtfPlanOpts = {}): CreateLadderInput {
  const timing = opts.timing ?? DEFAULT_HTF_TREND_TIMING;
  const leverage = opts.leverage ?? DEFAULT_LEVERAGE;
  const n = htfPlanNumbers(sig, opts);
  const isLong = sig.side === 'long';
  const entryDeadlineMs = sig.signalCloseMs + timing.entryWindowMs;
  const deadlineIso = new Date(entryDeadlineMs).toISOString().slice(0, 16).replace('T', ' ');
  const stopPct = (sig.stopFrac * 100).toFixed(1);
  const windowHours = timing.entryWindowMs / HOUR_MS;

  return {
    title: htfTrendTitle(sig.coin, sig.side, sig.signalCloseMs),
    thesis:
      `AUTO-DRAFTED from the htf-trend lane: the ${htfSignalDate(sig.signalCloseMs)} daily close ${round(sig.closePx)} broke the ` +
      `20-day ${isLong ? 'high' : 'low'} ${round(sig.channelPx)}. Entry ${sig.side} on a 15m close ${isLong ? 'above' : 'below'} ` +
      `${round(sig.channelPx)}. The price is already beyond that level, so the arm shows the instant-fire confirmation: confirm it, ` +
      `this lane enters with the breakout. The entry gate closes at ${deadlineIso} UTC (${windowHours} h after the daily close). ` +
      `After that the ladder cannot enter. Stop ${stopPct}% from the fill (2 x ATR20, capped at 12%), about $${n.riskUsd} risk on ` +
      `$${n.notionalUsd.toFixed(0)} notional. Exit: the daily close through the opposite 10-day channel (now ${round(sig.exitPx)}, ` +
      `the level moves each day). No target, no breakeven move, no adds: the large winners carry this lane. The loss cap holds ` +
      `the slipped stop plus funding at up to ${(HTF_FUNDING_ALLOWANCE_APR * 100).toFixed(0)}% APR for ${timing.expiryDays} days. If the arm ` +
      `refuses on funding, the funding against this side is above that rate: skip, or raise the cap on purpose. The rule is ` +
      `frozen: arm it or skip it, do not change the levels. LIVE low-size draft. The operator arms.`,
    author: 'operator',
    mode: 'live',
    maxTotalLossUsd: n.maxTotalLossUsd,
    maxTotalNotionalUsd: n.maxTotalNotionalUsd,
    expiresAtMs: sig.signalCloseMs + timing.expiryDays * DAY_MS,
    rungs: [
      {
        seq: 1, coin: sig.coin, side: sig.side, action: 'open',
        triggerKind: isLong ? 'price_above' : 'price_below', triggerPx: round(sig.channelPx),
        riskUsd: n.riskUsd, stopFrac: round(sig.stopFrac), leverage, triggerMeta: { entryDeadlineMs },
      },
      {
        seq: 2, coin: sig.coin, side: sig.side, action: 'close', triggerKind: 'indicator',
        triggerMeta: { op: 'above', indicatorName: htfChannelExitIndicatorName(sig.side), indicatorValue: 0.5 },
      },
    ],
  };
}

/** The Discord ping for a fresh draft. PURE (the caller sends it). */
export function htfTrendAlertMessage(sig: HtfTrendSignal, ladderId: string, cockpitBaseUrl?: string, opts: HtfPlanOpts = {}): string {
  const timing = opts.timing ?? DEFAULT_HTF_TREND_TIMING;
  const n = htfPlanNumbers(sig, opts);
  const link = cockpitBaseUrl ? `\n👉 ${cockpitBaseUrl.replace(/\/$/, '')}/cockpit?tab=ladders` : '';
  const deadline = new Date(sig.signalCloseMs + timing.entryWindowMs).toISOString().slice(11, 16);
  return (
    `📐 **htf-trend ${sig.side.toUpperCase()}: ${sig.coin} broke the 20-day ${sig.side === 'long' ? 'high' : 'low'}** ` +
    `(daily close ${round(sig.closePx)}, level ${round(sig.channelPx)})\n` +
    `Drafted LIVE ladder \`${ladderId.slice(0, 8)}\`: about $${n.riskUsd} risk, stop ${(sig.stopFrac * 100).toFixed(1)}%, ` +
    `exit on the 10-day channel (daily close). **Arm before ${deadline} UTC or skip it.** The arm asks for the ` +
    `instant-fire confirmation. Nothing fires until you arm.${link}`
  );
}

// --- Book decisions ---------------------------------------------------------------------

export interface HtfBookPosition {
  coin: string;
  side: LadderSide;
}

const opener = (l: LadderWithRungs) => l.rungs.find((r) => r.action === 'open') ?? null;
const ladderCoins = (l: LadderWithRungs): string[] => [...new Set(l.rungs.map((r) => r.coin.toUpperCase()))];

/** Can this htf ladder no longer enter? True when its opener is not pending, or the
 *  opener's entry gate is closed. A ladder with no opener can never enter. */
export function htfEntryOver(l: LadderWithRungs, now: number): boolean {
  const o = opener(l);
  return !o || o.status !== 'pending' || entryGateClosed(o, now);
}

/** A DRAFT of this drafter whose entry gate has closed: it can never enter, archive it. */
export function isStaleHtfDraft(l: LadderWithRungs, now: number): boolean {
  if (l.status !== 'draft' || !parseHtfTrendTitle(l.title)) return false;
  const o = opener(l);
  return !!o && entryGateClosed(o, now);
}

/** The spent check waits this long past the entry deadline. A fire that the watcher
 *  started just before the deadline then has its `ladder_fires` row and its position on
 *  record before the housekeeping looks. */
export const HTF_SPENT_GRACE_MS = 15 * 60 * 1000;

/** The opener of an ARMED ladder of this drafter whose entry gate closed at least
 *  HTF_SPENT_GRACE_MS ago, else null. These are the only ladders the spent check can disarm. */
export function htfClosedArmedOpener(l: LadderWithRungs, now: number): LadderRung | null {
  if (l.status !== 'armed' || !parseHtfTrendTitle(l.title)) return null;
  const o = opener(l);
  return o && entryGateClosed(o, now - HTF_SPENT_GRACE_MS) ? o : null;
}

/** Does the housekeeping have anything to look at in this ladder? */
export const needsHtfHousekeeping = (l: LadderWithRungs, now: number): boolean =>
  isStaleHtfDraft(l, now) || htfClosedArmedOpener(l, now) !== null;

export type HtfSpentReason = 'never-entered' | 'flat';

/**
 * Why an ARMED ladder of this drafter has nothing left to manage, or null when it still
 * has work. Its entry gate closed at least HTF_SPENT_GRACE_MS ago, and one of these is true:
 *   - `never-entered`: the opener is not `fired` and has NO fire of any status on record.
 *     It can never enter, and its close rung could only act on a position that is not its own;
 *   - `flat`: it entered, or may have entered, and the account holds no position of its
 *     side on its coin.
 * `positions` MUST come from a fresh, successful account read. `openerFireOnRecord` MUST
 * come from a successful `ladder_fires` read that counts EVERY status: a `failed` fire can
 * be an unknown outcome with a late fill, so any fire counts as "may have entered".
 */
export function htfSpentReason(
  l: LadderWithRungs,
  now: number,
  positions: HtfBookPosition[],
  openerFireOnRecord: boolean,
): HtfSpentReason | null {
  const o = htfClosedArmedOpener(l, now);
  if (!o) return null;
  if (o.status !== 'fired' && !openerFireOnRecord) return 'never-entered';
  const coin = o.coin.toUpperCase();
  return positions.some((p) => p.coin.toUpperCase() === coin && p.side === o.side) ? null : 'flat';
}

export const isSpentHtfArmed = (l: LadderWithRungs, now: number, positions: HtfBookPosition[], openerFireOnRecord: boolean): boolean =>
  htfSpentReason(l, now, positions, openerFireOnRecord) !== null;

/** The Discord note for a housekeeping disarm. PURE (the caller sends it). */
export function htfSpentDisarmMessage(l: LadderWithRungs, reason: HtfSpentReason): string {
  const why = reason === 'never-entered'
    ? 'its entry window closed and it never entered'
    : 'it entered and the account now holds no position of its side on the coin';
  return (
    `🧹 **htf-trend housekeeping: disarmed \`${l.id.slice(0, 8)}\`** (${l.title}): ${why}. ` +
    `A disarm moves no money and cancels no order.`
  );
}

/** Added to the draft ping when the event calendar has no future print: the blackout
 *  check could not see the next event. */
export const HTF_CALENDAR_WARNING =
  '⚠️ The event calendar is exhausted, so the blackout check did not run. Check the calendar for a print in the next 48 h before you arm.';

export interface HtfDraftSelectionInput {
  /** Breakout signals of this daily close. Any order: selection follows the universe order. */
  signals: HtfTrendSignal[];
  now: number;
  /** Unarchived drafts plus every armed ladder, with the stale and spent htf ladders removed. */
  ladders: LadderWithRungs[];
  /** Every open live position (fresh, successful read). */
  positions: HtfBookPosition[];
  /** Coins that already have a draft of this drafter for this signal day (archived included). */
  draftedCoins: ReadonlySet<string>;
  maxSameDirection?: number;
  maxDrafts?: number;
}

export interface HtfDraftSelection {
  draft: HtfTrendSignal[];
  skipped: Array<{ coin: string; reason: 'already-drafted' | 'positioned' | 'vehicle' | 'same-direction-cap' | 'cycle-cap' }>;
}

/** Decide which signals become drafts. PURE. Every refusal is reported with its reason. */
export function selectHtfDrafts(input: HtfDraftSelectionInput): HtfDraftSelection {
  const maxSame = input.maxSameDirection ?? HTF_MAX_SAME_DIRECTION;
  const maxDrafts = input.maxDrafts ?? HTF_MAX_DRAFTS_PER_CYCLE;
  const universe = new Set(HTF_TREND_UNIVERSE);
  const positionedCoins = new Set(input.positions.map((p) => p.coin.toUpperCase()));
  const vehicleCoins = new Set(input.ladders.flatMap(ladderCoins));

  // Same-direction exposure: one count per universe coin and side, from open positions and
  // from htf ladders that can still enter.
  const sameSide: Record<LadderSide, Set<string>> = { long: new Set(), short: new Set() };
  for (const p of input.positions) if (universe.has(p.coin.toUpperCase())) sameSide[p.side].add(p.coin.toUpperCase());
  for (const l of input.ladders) {
    const o = opener(l);
    if (o && parseHtfTrendTitle(l.title) && !htfEntryOver(l, input.now)) sameSide[o.side].add(o.coin.toUpperCase());
  }

  const order = (s: HtfTrendSignal): number => {
    const i = HTF_TREND_UNIVERSE.indexOf(s.coin.toUpperCase());
    return i < 0 ? HTF_TREND_UNIVERSE.length : i;
  };
  const draft: HtfTrendSignal[] = [];
  const skipped: HtfDraftSelection['skipped'] = [];
  for (const sig of [...input.signals].sort((a, b) => order(a) - order(b))) {
    const coin = sig.coin.toUpperCase();
    if (!universe.has(coin)) continue;
    if (input.draftedCoins.has(coin)) skipped.push({ coin, reason: 'already-drafted' });
    else if (positionedCoins.has(coin)) skipped.push({ coin, reason: 'positioned' });
    else if (vehicleCoins.has(coin)) skipped.push({ coin, reason: 'vehicle' });
    else if (sameSide[sig.side].size >= maxSame) skipped.push({ coin, reason: 'same-direction-cap' });
    else if (draft.length >= maxDrafts) skipped.push({ coin, reason: 'cycle-cap' });
    else {
      draft.push(sig);
      sameSide[sig.side].add(coin);
    }
  }
  return { draft, skipped };
}
