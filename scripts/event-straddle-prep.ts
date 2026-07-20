/**
 * Event-straddle PRE-PRINT PREP — builds the graduated event-straddle template
 * (ledger `event-straddle`) as two DRAFT OCO legs from the LIVE pre-print
 * reference price, then pings Discord so the operator can arm.
 *
 * Run this shortly BEFORE the print (cron / background timer), never hours
 * ahead: the template's gates are ±N% from the pre-print reference, so building
 * early bakes in a stale reference. Drafts only — arming stays operator-only.
 *
 * Template (graduated 2026-07-14) + Jul-15 first-live-run lessons:
 *   - gates ±1.0% majors / ±1.5% HYPE-SOL from reference, stop AT the reference
 *   - activeFrom = print − 15 min, expiry = print + 24 h, plain OCO
 *   - management rungs INSIDE each leg: breakeven ratchet at +0.7R, banks at
 *     +1R / +2R, momentum stall-exit (≥2, NO floorPx — event fills are
 *     fade-prone; cut the fade even slightly underwater)
 *
 * Usage:
 *   pnpm straddle:prep --coin ETH --event "Retail Sales" --print 2026-07-16T12:30:00Z [--gate-pct 1.0] [--risk 4] [--dry]
 */
import { readFileSync } from 'node:fs';
import type { NewRung } from '@/lib/ladder/ladder-service';
import { randomUUID } from 'node:crypto';

function loadEnv(): void {
  let raw = '';
  try {
    raw = readFileSync('.env.local', 'utf8');
  } catch {
    return;
  }
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!process.env[m[1]]) process.env[m[1]] = v;
  }
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/**
 * Round-number hygiene: if a trigger lands within 0.15% of a psychological level,
 * shove it 0.2% past the level in the leg's direction. The clearance scales with
 * price so it never distorts the gate geometry by more than ~0.2%.
 */
function nudgeOffRound(px: number, dir: 1 | -1): number {
  const step = px >= 10_000 ? 500 : px >= 1_000 ? 50 : px >= 100 ? 5 : px >= 10 ? 0.5 : 0.05;
  const nearest = Math.round(px / step) * step;
  const out = Math.abs(px - nearest) < 0.0015 * px ? nearest + dir * 0.002 * px : px;
  const dp = px >= 1_000 ? 0 : px >= 10 ? 2 : 4;
  return Number(out.toFixed(dp));
}

async function main(): Promise<void> {
  loadEnv();
  const coin = (arg('coin') ?? 'ETH').toUpperCase();
  const eventName = arg('event') ?? 'event';
  const printAtMs = Date.parse(arg('print') ?? '');
  if (!Number.isFinite(printAtMs)) throw new Error('--print <ISO datetime> is required');
  const gatePct = Number(arg('gate-pct') ?? (coin === 'HYPE' || coin === 'SOL' ? 1.5 : 1.0)) / 100;
  const riskUsd = Number(arg('risk') ?? 4);
  const dry = process.argv.includes('--dry');

  const midsRes = await fetch('https://api.hyperliquid.xyz/info', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'allMids' }),
  });
  const mids = (await midsRes.json()) as Record<string, string>;
  const ref = Number(mids[coin]);
  if (!Number.isFinite(ref) || ref <= 0) throw new Error(`no mid for ${coin}`);

  const ocoGroupId = randomUUID();
  const activeFromMs = printAtMs - 15 * 60 * 1000;
  const expiresAtMs = printAtMs + 24 * 60 * 60 * 1000;

  const pxDp = ref >= 1_000 ? 0 : ref >= 10 ? 2 : 4;
  const legs = (['long', 'short'] as const).map((side) => {
    const dir: 1 | -1 = side === 'long' ? 1 : -1;
    const gate = nudgeOffRound(ref * (1 + dir * gatePct), dir);
    // Stop sits AT the pre-print reference (the template's 1R definition).
    const stopFrac = Number((Math.abs(gate - ref) / gate).toFixed(4));
    const kind = side === 'long' ? 'price_above' : 'price_below';
    const lvl = (rMult: number) => nudgeOffRound(gate * (1 + dir * gatePct * rMult), dir);
    const stall = `momentum-stall-${side}`;
    // Trail distance ≈ 0.8 × the 1R gate distance: wide enough to survive
    // post-print chop, tight enough that the tail-carry (the source of the
    // backtest's best FOMC results, +0.6..+3.4R) banks itself on reversal.
    const trailDist = Number((gate * gatePct * 0.8).toFixed(pxDp));
    const rungs: NewRung[] = [
      { seq: 1, coin, side, action: 'open', triggerKind: kind, triggerPx: gate, riskUsd, stopFrac, leverage: 2 },
      { seq: 2, coin, side, action: 'stop_move', triggerKind: kind, triggerPx: lvl(0.7), triggerMeta: { moveTo: 'breakeven' } },
      { seq: 3, coin, side, action: 'reduce', triggerKind: kind, triggerPx: lvl(1.0), reduceFrac: 0.34 },
      { seq: 4, coin, side, action: 'reduce', triggerKind: kind, triggerPx: lvl(2.0), reduceFrac: 0.5 },
      // TAIL-CARRY TRAIL (FOMC toolkit, Jul-19): from +1.2R the runner's stop
      // follows price at trailDist — the +3R tails stop managing themselves at
      // +2R banks otherwise. Only-tightens; per-candle claims; flat terminates.
      { seq: 5, coin, side, action: 'stop_move', triggerKind: kind, triggerPx: lvl(1.2), triggerMeta: { moveTo: 'trail', trailDistancePx: trailDist } },
      {
        seq: 6, coin, side, action: 'reduce', triggerKind: 'indicator', reduceFrac: 0.5,
        triggerMeta: { op: 'above', indicatorName: stall, indicatorValue: 2 },
      },
    ];
    const worst = riskUsd * (0.9 + 0.1 / stopFrac);
    return { side, gate, stopFrac, rungs, worst, notional: riskUsd / stopFrac };
  });

  for (const l of legs) {
    console.log(
      `${coin} ${l.side}: gate ${l.gate} (ref ${ref}), stopFrac ${l.stopFrac}, ` +
      `notional ~$${l.notional.toFixed(0)}, slip-worst ~$${l.worst.toFixed(1)}`,
    );
  }
  if (dry) {
    console.log('[dry] no ladders created');
    return;
  }

  const { createLadder } = await import('@/lib/ladder/ladder-service');
  const ids: string[] = [];
  for (const l of legs) {
    const id = await createLadder({
      title: `${coin} ${eventName} straddle — ${l.side} leg (event template)`,
      thesis:
        `Event-straddle template (graduated 2026-07-14) on ${eventName}, print ${new Date(printAtMs).toISOString()}. ` +
        `Pre-print reference ${ref} measured at build time ${new Date().toISOString()}; gate ${l.gate} ` +
        `(${(gatePct * 100).toFixed(1)}% ${l.side === 'long' ? 'above' : 'below'}), stop at the reference (1R = gate distance). ` +
        `Jul-15 lessons built in: breakeven ratchet at +0.7R, banks +1R/+2R, momentum stall-exit ≥2 with NO floor ` +
        `(event fills are fade-prone — cut the fade even slightly underwater). Plain OCO — first fire disarms the sibling; ` +
        `if the fired side STOPS OUT, re-present the sibling (standing order, ~30% conditional whipsaw). ` +
        `Window: hot from print−15min, expires print+24h. Remainder after banks is a manual time-exit at the next checkpoint.`,
      author: 'operator',
      mode: 'live',
      ocoGroupId,
      activeFromMs,
      expiresAtMs,
      maxTotalNotionalUsd: Math.ceil(l.notional * 1.15),
      maxTotalLossUsd: Math.ceil(l.worst * 1.15),
      rungs: l.rungs,
    });
    ids.push(id);
    console.log(`created ${l.side} leg: ${id}`);
  }

  const { sendDiscord } = await import('@/lib/infrastructure/notify/discord-notify');
  const [longLeg, shortLeg] = legs;
  await sendDiscord(
    `💡 **${eventName} straddle drafted — ARM DECISION NEEDED**\n` +
    `${coin} ref ${ref} · long gate ${longLeg.gate} / short gate ${shortLeg.gate} (stops at ref)\n` +
    `Legs: \`${ids[0].slice(0, 8)}\` (long) + \`${ids[1].slice(0, 8)}\` (short), OCO — hot from ` +
    `${new Date(activeFromMs).toISOString().slice(11, 16)} UTC.\n` +
    `Risk $${riskUsd}/side nominal, slip-worst ~$${Math.max(longLeg.worst, shortLeg.worst).toFixed(0)} for the pair (OCO counted once).\n` +
    `Arm BOTH in the cockpit if you want the trade — drafts do nothing on their own.`,
  );
  console.log('Discord ping sent.');
}

main().catch((e: unknown) => {
  console.error('straddle-prep failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
