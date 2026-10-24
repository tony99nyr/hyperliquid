/**
 * pnpm skill:desk-retro — the weekly retro's DISCARD VET gather (read-only).
 *
 * Lists every ladder archived or disarmed inside the window and replays its core
 * entry rung over the completed 4h candles since the discard: never-triggered /
 * dodged-stop / missed-target / would-be-open. This is the hindsight half the
 * other retro tools don't cover — it judges the discards in BOTH directions.
 *
 * READ-ONLY: one SELECT on ladders (+rungs), candles from HL. Never trades,
 * never writes. The other retro steps have their own entrypoints
 * (scout:review, scout:shadow-replay, the ladder-expectancy skill).
 *
 *   pnpm skill:desk-retro                 # discards in the last 7 days
 *   pnpm skill:desk-retro --days 14 --json
 */

import { run } from './_skill-runtime';
import { fetchCandles } from '@/lib/hyperliquid/candle-service';
import { getServiceRoleClient } from '@/lib/cockpit/supabase-server';
import {
  replayDiscardedEntry,
  summarizeDiscardVet,
  type DiscardedPlan,
  type DiscardVerdict,
  type RetroCandle,
} from '@/lib/skills/desk-retro-business-logic';

const H4_MS = 4 * 3_600_000;

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

interface LadderRow {
  id: string;
  title: string;
  status: string;
  created_at: string;
  armed_at: string | null;
  archived_at: string | null;
  disarmed_at: string | null;
  disarm_reason: string | null;
  expires_at: string | null;
}

interface RungRow {
  seq: number;
  coin: string;
  side: 'long' | 'short';
  action: string;
  trigger_kind: string;
  trigger_px: number | string | null;
  stop_px: number | string | null;
  stop_frac: number | string | null;
  target_px: number | string | null;
  status: string;
}

/** NUMERIC columns can arrive as strings depending on the driver — coerce safely
 *  (an empty string must NOT become 0). */
function num(v: number | string | null): number | null {
  if (v == null) return null;
  if (typeof v === 'string' && v.trim() === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** The earliest moment the plan was taken off the board (the decision under vet). */
function discardedAtMs(l: LadderRow): number | null {
  const stamps = [l.archived_at, l.disarmed_at]
    .filter((s): s is string => s != null)
    .map((s) => Date.parse(s))
    .filter((n) => Number.isFinite(n));
  return stamps.length ? Math.min(...stamps) : null;
}

const fmt = (ms: number | null): string => (ms == null ? '—' : new Date(ms).toISOString().slice(0, 16).replace('T', ' '));

async function main(): Promise<void> {
  const daysRaw = arg('days');
  const days = daysRaw == null ? 7 : Number(daysRaw);
  if (!Number.isFinite(days) || days <= 0) {
    console.error(`--days must be a positive number, got "${daysRaw}"`);
    process.exit(1);
  }
  const json = process.argv.includes('--json');
  const now = Date.now();
  const sinceIso = new Date(now - days * 86_400_000).toISOString();

  const db = getServiceRoleClient();
  const { data: ladders, error } = await db
    .from('ladders')
    .select('id, title, status, created_at, armed_at, archived_at, disarmed_at, disarm_reason, expires_at')
    .or(`archived_at.gte.${sinceIso},disarmed_at.gte.${sinceIso}`)
    .order('created_at', { ascending: false });
  if (error) throw new Error(`ladders query failed: ${error.message}`);

  console.log(`\n=== desk-retro — discard vet, last ${days}d (read-only hindsight replay) ===\n`);
  if (!ladders?.length) {
    console.log('No ladders were archived or disarmed in the window. Nothing to vet.');
    printChecklist();
    return;
  }

  const rows: Array<{ ladder: LadderRow; reason: string; verdict: DiscardVerdict | null; skip?: string; plan?: DiscardedPlan }> = [];
  for (const ladder of ladders as LadderRow[]) {
    const at = discardedAtMs(ladder);
    const reason = ladder.disarm_reason ?? (ladder.archived_at ? 'archived' : 'disarmed');
    if (at == null) {
      rows.push({ ladder, reason, verdict: null, skip: 'no discard timestamp' });
      continue;
    }
    const { data: rungs, error: rErr } = await db
      .from('ladder_rungs')
      .select('seq, coin, side, action, trigger_kind, trigger_px, stop_px, stop_frac, target_px, status')
      .eq('ladder_id', ladder.id)
      .order('seq', { ascending: true });
    if (rErr) throw new Error(`rungs query failed for ${ladder.id}: ${rErr.message}`);
    const all = (rungs ?? []) as RungRow[];

    // A ladder whose entry already FIRED is not a discard to vet — its real outcome
    // lives in the expectancy ledger (step 3 of the bundle).
    if (all.some((r) => r.action === 'open' && r.status === 'fired')) {
      rows.push({ ladder, reason, verdict: null, skip: 'entry fired before the discard — see ladder-expectancy' });
      continue;
    }

    // The core = the first still-pending price-triggered OPEN rung carrying a stop
    // (absolute or fractional — drafter rungs size via risk_usd + stop_frac).
    const core = all.find(
      (r) =>
        r.action === 'open' &&
        r.status === 'pending' &&
        (r.trigger_kind === 'price_above' || r.trigger_kind === 'price_below') &&
        num(r.trigger_px) != null &&
        (num(r.stop_px) != null || num(r.stop_frac) != null),
    );
    if (!core) {
      rows.push({ ladder, reason, verdict: null, skip: 'no replayable price-triggered open rung with a stop' });
      continue;
    }

    // The counterfactual window: a never-armed draft replays from CREATION ("what
    // if we had armed it when drafted"); a deliberately disarmed ladder from the
    // DISARM moment ("what did the disarm cost"); an armed ladder that EXPIRED
    // un-fired from its ARM ("the setup never came while it was live" — expiry is
    // the plan's own invalidation, not a decision). The expiry clamp applies always.
    const windowStartMs =
      ladder.armed_at == null
        ? Date.parse(ladder.created_at)
        : reason === 'expired'
          ? Date.parse(ladder.armed_at)
          : at;

    if (!Number.isFinite(windowStartMs)) {
      rows.push({ ladder, reason, verdict: null, skip: 'no parseable window-start timestamp' });
      continue;
    }

    // Target proxy: the rung's own target, else the FIRST reduce rung whose trigger
    // sits on the PROFIT side of the entry trigger (T1 — where the plan starts
    // paying). A reduce on the wrong side (a de-risk level) is NOT a target.
    const coreTrigger = num(core.trigger_px) as number;
    const reduceT1 = all.find((r) => {
      if (r.action !== 'reduce') return false;
      const px = num(r.trigger_px);
      return px != null && (core.side === 'long' ? px > coreTrigger : px < coreTrigger);
    });
    const plan: DiscardedPlan = {
      coin: core.coin,
      side: core.side,
      triggerKind: core.trigger_kind as DiscardedPlan['triggerKind'],
      triggerPx: coreTrigger,
      stopPx: num(core.stop_px),
      stopFrac: num(core.stop_frac),
      targetPx: num(core.target_px) ?? (reduceT1 ? num(reduceT1.trigger_px) : null),
      windowStartMs,
      expiresAtMs: ladder.expires_at ? Date.parse(ladder.expires_at) : null,
    };
    const result = await fetchCandles(core.coin, '4h', windowStartMs, now);
    // A stale/failed/empty candle fetch must SKIP, never read as "never-triggered"
    // — an empty replay window is false comfort, not evidence.
    if (result.stale || result.error || result.candles.length === 0) {
      rows.push({ ladder, reason, verdict: null, skip: `candles unavailable (${result.error ?? 'stale/empty'})` });
      continue;
    }
    // Drop the still-forming last bar — the vet replays COMPLETED candles only.
    const bars: RetroCandle[] = result.candles
      .filter((c) => c.timestamp + H4_MS <= now)
      .map((c) => ({ timeMs: c.timestamp, highPx: c.high, lowPx: c.low, closePx: c.close }));
    // A very fresh discard can leave ZERO completed bars — that is "no evidence
    // yet", never a "never-triggered" verdict.
    if (bars.filter((b) => b.timeMs >= plan.windowStartMs).length === 0) {
      rows.push({ ladder, reason, verdict: null, skip: 'no completed bar since the window start yet — re-vet next week' });
      continue;
    }
    rows.push({ ladder, reason, plan, verdict: replayDiscardedEntry(plan, bars) });
  }

  const verdicts = rows.map((r) => r.verdict).filter((v): v is DiscardVerdict => v != null);
  const summary = summarizeDiscardVet(verdicts);

  if (json) {
    console.log(JSON.stringify({ sinceIso, rows, summary }, null, 2));
    printChecklist();
    return;
  }

  for (const r of rows) {
    const head = `${r.ladder.title} (${r.ladder.id.slice(0, 8)}) — discarded ${fmt(discardedAtMs(r.ladder))} [${r.reason}]`;
    if (!r.verdict || !r.plan) {
      console.log(`  ∅ ${head} — skipped: ${r.skip}`);
      continue;
    }
    const v = r.verdict;
    const mark = v.outcome === 'missed-target' ? '✗' : v.outcome === 'dodged-stop' ? '✓' : '·';
    const rTxt = v.rMultiple == null ? '' : ` → ${v.rMultiple > 0 ? '+' : ''}${v.rMultiple.toFixed(2)}R`;
    console.log(`  ${mark} ${head}`);
    const stopTxt = r.plan.stopPx != null ? `${r.plan.stopPx}` : `${((r.plan.stopFrac ?? 0) * 100).toFixed(1)}% off fill`;
    console.log(
      `     ${r.plan.coin} ${r.plan.side} @ ${r.plan.triggerPx} (stop ${stopTxt}${r.plan.targetPx != null ? `, target ${r.plan.targetPx}` : ''}) · ${v.outcome}` +
        (v.triggeredAtMs ? ` · would have fired ${fmt(v.triggeredAtMs)} @ ${v.entryPx}` : '') +
        rTxt +
        ` · window from ${fmt(r.plan.windowStartMs)}${
          r.ladder.armed_at == null
            ? ' (creation — never armed; assumes it was armable as drafted, which the instant-fire guard may have refused)'
            : r.reason === 'expired'
              ? ' (arm → expiry)'
              : ' (disarm)'
        }`,
    );
  }

  console.log(
    `\nSummary: ${summary.total} vetted — ${summary.neverTriggered} never triggered, ` +
      `${summary.dodgedStops} dodged stops, ${summary.missedTargets} missed targets, ` +
      `${summary.wouldBeOpen} would be open, ${summary.notEvaluable} not evaluable` +
      (summary.firedWithoutTarget > 0
        ? ` (${summary.firedWithoutTarget} fired with NO usable target — a miss was not measurable for those)`
        : ''),
  );
  console.log(
    `Net hindsight R of the fired set: ${summary.netHindsightR > 0 ? '+' : ''}${summary.netHindsightR.toFixed(2)}R ` +
      '(positive = the discards would have paid). DESCRIPTIVE ONLY: one replayed path per\n' +
      'discard, tiny n, gross of fees/funding/slippage, no pre-registered bar — not P&L, never\n' +
      'a verdict by itself. A sound discard stays sound even when its one path would have paid;\n' +
      'cross-check each row against the reason it was discarded before concluding anything.',
  );
  printChecklist();
}

function printChecklist(): void {
  console.log(
    '\n=== The rest of the weekly retro bundle (each has its own entrypoint) ===\n' +
      '  1. pnpm scout:review -- --write # record scorecard, then curate docs/scout/playbook.md\n' +
      '  2. pnpm scout:shadow-replay     # lane sample loss; attribute misses via scout_decisions\n' +
      '  3. ladder-expectancy skill      # ladder/manual fires vs their pre-registered bars\n' +
      'Synthesis is the SKILL’s job: .claude/skills/desk-retro/SKILL.md',
  );
}

run(main);
