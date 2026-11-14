/**
 * htf-trend drafter (I/O): the live expression of the scout's daily 20-day channel
 * breakout lane. The cycle has two parts:
 *   1. Housekeeping, on EVERY run and with the drafter flag ON or OFF: archive this
 *      drafter's drafts that can no longer enter, and disarm this drafter's armed ladders
 *      that have nothing left to manage. A spent ladder must not stay armed, because its
 *      close rung would act on any later position of its side on the coin. The flag does
 *      not gate this part: a ladder armed before the flag went off still needs it.
 *   2. Drafting, only with the flag on and inside the drafting window after the daily
 *      close: read the completed daily bars of the universe and draft ONE low-size LIVE
 *      ladder per new breakout, then ping Discord.
 *
 * DRAFT only: the operator arms. The cycle never arms, fires or closes anything. The
 * one status write on an armed ladder is a DISARM (risk-reducing, moves no money, leaves
 * the exchange stop in place). Each disarm pings Discord.
 *
 * Fail closed: when the positions cannot be read fresh, the cycle drafts nothing and
 * touches no ladder. A ladder that entered is disarmed only after a SECOND account read
 * confirms the flat side. Every refusal is reported.
 */

import 'server-only';
import { getServiceRoleClient } from '@/lib/cockpit/supabase-server';
import { fetchClearinghouseState } from '@/lib/hyperliquid/hyperliquid-info-service';
import { getHlAccountAddress } from '@/lib/auto-exit/auto-exit-config';
import { calendarExhausted, nearestBlackoutEvent } from '@/lib/skills/event-calendar-business-logic';
import { sendDiscord, isDiscordConfigured } from '@/lib/infrastructure/notify/discord-notify';
import { validateEnv } from '@/lib/env/env';
import { archiveLadder, createLadder, disarmLadder, listLaddersWithRungs } from './ladder-service';
import { readHtfDaily } from './ladder-htf-exit-service';
import type { LadderRung, LadderWithRungs } from './ladder-types';
import {
  HTF_BLACKOUT_POST_MS,
  HTF_CALENDAR_WARNING,
  HTF_TREND_UNIVERSE,
  buildHtfTrendLadderPlan,
  htfDraftWindow,
  htfEventBlackout,
  htfSignalDate,
  htfTrendAlertMessage,
  htfClosedArmedOpener,
  htfSpentDisarmMessage,
  htfSpentReason,
  htfTrendSignal,
  isStaleHtfDraft,
  needsHtfHousekeeping,
  parseHtfTrendTitle,
  selectHtfDrafts,
  type HtfBookPosition,
  type HtfDraftSelection,
  type HtfTrendSignal,
} from './htf-trend-alert-business-logic';

export interface HtfTrendAlertResult {
  /** Why the cycle drafted nothing, when it drafted nothing. Housekeeping may still have run. */
  skipped?: 'drafting-off' | 'outside-window' | 'positions-unreadable' | 'event-blackout';
  /** UTC date of the daily bar this cycle read. */
  signalDate: string;
  scanned: number;
  signals: Array<{ coin: string; side: string }>;
  drafted: Array<{ coin: string; side: string; ladderId: string }>;
  notDrafted: HtfDraftSelection['skipped'];
  archivedStale: string[];
  disarmedSpent: string[];
  /** Every failure and every refusal that the operator should see in the cron response. */
  errors: string[];
}

const DISCORD_NAME = 'HL HTF Trend Desk';
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Every open live position, or null when the account cannot be read fresh. A response
 *  without the positions array is unreadable: it would parse as a flat account. */
async function readPositions(): Promise<HtfBookPosition[] | null> {
  try {
    const address = getHlAccountAddress();
    if (!address) return null;
    const state = await fetchClearinghouseState(address, { uncached: true });
    if (state.stale || state.error || state.positionsListed !== true) return null;
    return state.positions.map((p) => ({ coin: p.coin.toUpperCase(), side: p.side }));
  } catch {
    return null;
  }
}

/** Coins that already have a draft of this drafter for this signal day. Archived and
 *  disarmed rows count: an operator's "not this one" must hold for the whole day. */
async function draftedCoinsFor(signalDate: string): Promise<Set<string>> {
  const { data, error } = await getServiceRoleClient()
    .from('ladders')
    .select('title')
    .like('title', `% htf-trend % ${signalDate} %`);
  if (error) throw new Error(`htf-trend dedupe read failed: ${error.message}`);
  const coins = new Set<string>();
  for (const row of data ?? []) {
    const parsed = parseHtfTrendTitle(String((row as { title: string }).title));
    if (parsed && parsed.signalDate === signalDate) coins.add(parsed.coin);
  }
  return coins;
}

/** Opener rungs that have a fire of ANY status on record. A `failed` fire can be an unknown
 *  outcome with a late fill, so every status counts as "may have entered". Throws on a
 *  failed read so the caller disarms nothing. */
async function openersWithFireOnRecord(rungIds: string[]): Promise<Set<string>> {
  if (rungIds.length === 0) return new Set();
  const { data, error } = await getServiceRoleClient()
    .from('ladder_fires')
    .select('rung_id')
    .in('rung_id', rungIds);
  if (error) throw new Error(`htf-trend fire read failed: ${error.message}`);
  return new Set((data ?? []).map((row) => String((row as { rung_id: string }).rung_id)));
}

/** A second, independent account read before a flat-side disarm. One partial account
 *  response that omits the positions must not disarm a ladder that still has a position. */
async function confirmedFlat(o: LadderRung): Promise<boolean> {
  const again = await readPositions();
  const coin = o.coin.toUpperCase();
  return !!again && !again.some((p) => p.coin === coin && p.side === o.side);
}

/**
 * Archive stale drafts and disarm spent armed ladders. Returns the ladders that remain.
 * `positions` is null only when the caller found no armed candidate (no account read was
 * needed): then the cycle archives stale drafts and disarms nothing.
 */
async function housekeep(
  ladders: LadderWithRungs[],
  positions: HtfBookPosition[] | null,
  now: number,
  out: Pick<HtfTrendAlertResult, 'archivedStale' | 'disarmedSpent' | 'errors'>,
): Promise<LadderWithRungs[]> {
  // Fail closed: without the fire record the cycle cannot tell "never entered" from
  // "entered", so it disarms nothing this cycle.
  let fired: Set<string> | null = null;
  try {
    const openerIds = ladders.map((l) => htfClosedArmedOpener(l, now)?.id).filter((id): id is string => !!id);
    fired = await openersWithFireOnRecord(openerIds);
  } catch (e) {
    out.errors.push(`${errText(e)}: no armed ladder disarmed this cycle`);
    console.warn(`[htf-trend] ${errText(e)}`);
  }

  const remaining: LadderWithRungs[] = [];
  for (const l of ladders) {
    try {
      if (isStaleHtfDraft(l, now)) {
        // A refused archive means the row changed under us (an arm race): keep it counted.
        if (await archiveLadder(l.id)) out.archivedStale.push(l.id);
        else remaining.push(l);
        continue;
      }
      const o = htfClosedArmedOpener(l, now);
      const reason = o && fired && positions ? htfSpentReason(l, now, positions, fired.has(o.id)) : null;
      if (o && reason === 'flat' && !(await confirmedFlat(o))) {
        out.errors.push(`housekeeping ${l.id.slice(0, 8)}: the second account read did not confirm a flat ${o.coin} ${o.side}: not disarmed this cycle`);
      } else if (reason) {
        await disarmLadder(l.id, 'htf-trend-spent');
        out.disarmedSpent.push(l.id);
        if (isDiscordConfigured()) {
          const sent = await sendDiscord(htfSpentDisarmMessage(l, reason), DISCORD_NAME).catch(() => false);
          if (!sent) out.errors.push(`housekeeping ${l.id.slice(0, 8)}: disarmed but the Discord ping FAILED`);
        }
        continue;
      }
    } catch (e) {
      const msg = `housekeeping ${l.id.slice(0, 8)}: ${errText(e)}`;
      out.errors.push(msg);
      console.warn(`[htf-trend] ${msg}`);
    }
    remaining.push(l);
  }
  return remaining;
}

/** Run one htf-trend cycle. Reads, DRAFT writes and housekeeping only: never arms or fires.
 *  `draft: false` (the drafter flag is off) runs the housekeeping alone. */
export async function runHtfTrendAlertCycle(now: number = Date.now(), opts: { draft: boolean } = { draft: true }): Promise<HtfTrendAlertResult> {
  const window = htfDraftWindow(now);
  const drafting = opts.draft && window.open;
  const notDrafting = opts.draft ? 'outside-window' : 'drafting-off';
  const result: HtfTrendAlertResult = {
    signalDate: htfSignalDate(window.signalCloseMs),
    scanned: 0, signals: [], drafted: [], notDrafted: [], archivedStale: [], disarmedSpent: [], errors: [],
  };

  // Ladders FIRST, positions SECOND: a position that opens between the two reads is then
  // visible to the spent check, which can only make it more conservative.
  // With the flag off no new draft exists, so the cycle reads the armed ladders only.
  const current = [
    ...(opts.draft ? await listLaddersWithRungs('draft') : []),
    ...(await listLaddersWithRungs('armed')),
  ];
  // When the cycle does not draft it only does housekeeping, and most runs have none.
  if (!drafting && !current.some((l) => needsHtfHousekeeping(l, now))) return { ...result, skipped: notDrafting };

  // The account read is needed to draft and to judge an armed ladder. A stale draft alone
  // needs no account read.
  let positions: HtfBookPosition[] | null = null;
  if (drafting || current.some((l) => htfClosedArmedOpener(l, now))) {
    positions = await readPositions();
    if (!positions) {
      return { ...result, skipped: 'positions-unreadable', errors: ['account read failed or stale: nothing drafted, archived or disarmed this cycle'] };
    }
  }
  const ladders = await housekeep(current, positions, now, result);
  if (!drafting || !positions) return { ...result, skipped: notDrafting };

  const signals: HtfTrendSignal[] = [];
  for (const coin of HTF_TREND_UNIVERSE) {
    try {
      const daily = await readHtfDaily(coin, now);
      if (!daily) {
        result.errors.push(`${coin}: daily read unavailable (stale, late or gapped feed)`);
        continue;
      }
      result.scanned += 1;
      if (daily.signalCloseMs !== window.signalCloseMs) continue;
      const sig = htfTrendSignal(coin, daily.read, daily.signalCloseMs);
      if (sig) signals.push(sig);
    } catch (e) {
      result.errors.push(`${coin}: ${errText(e)}`);
    }
  }
  result.signals = signals.map((s) => ({ coin: s.coin, side: s.side }));
  if (signals.length === 0) return result;

  // The scout's event blackout, mirrored: no new entry from 48 h before a print to 4 h after.
  const calendarBlind = calendarExhausted(now);
  if (calendarBlind) result.errors.push('event calendar exhausted: the blackout cannot see the next print');
  const ev = nearestBlackoutEvent(now, HTF_BLACKOUT_POST_MS);
  if (htfEventBlackout(ev?.msOut ?? null)) {
    result.errors.push(`event blackout (${ev?.name}): ${signals.map((s) => `${s.coin} ${s.side}`).join(', ')} not drafted`);
    return { ...result, skipped: 'event-blackout' };
  }

  let draftedCoins: Set<string>;
  try {
    draftedCoins = await draftedCoinsFor(result.signalDate);
  } catch (e) {
    result.errors.push(errText(e));
    return result;
  }
  const selection = selectHtfDrafts({ signals, now, ladders, positions, draftedCoins });
  result.notDrafted = selection.skipped;

  for (const sig of selection.draft) {
    try {
      const ladderId = await createLadder(buildHtfTrendLadderPlan(sig));
      result.drafted.push({ coin: sig.coin, side: sig.side, ladderId });
      if (isDiscordConfigured()) {
        // The ping is the product of this lane: a draft the operator never hears about
        // expires unarmed. A failed send is reported in the cron response.
        const message = htfTrendAlertMessage(sig, ladderId, validateEnv().COCKPIT_BASE_URL);
        const sent = await sendDiscord(calendarBlind ? `${message}\n${HTF_CALENDAR_WARNING}` : message, DISCORD_NAME).catch(() => false);
        if (!sent) {
          result.errors.push(`${sig.coin}: drafted ${ladderId.slice(0, 8)} but the Discord ping FAILED`);
          console.warn(`[htf-trend] ${sig.coin} draft ${ladderId.slice(0, 8)} created but the Discord ping failed`);
        }
      }
    } catch (e) {
      const msg = `${sig.coin}: ${errText(e)}`;
      result.errors.push(msg);
      console.warn(`[htf-trend] draft failed: ${msg}`);
    }
  }
  return result;
}
