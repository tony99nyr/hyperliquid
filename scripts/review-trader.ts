/**
 * pnpm review-trader <0xADDRESS> — Claude-facing read of the copyability fingerprint
 * (PR-3, the second consumer of trader_evaluations). Prints the latest persisted
 * verdict + the *why* + gating metrics so a skill can justify a follow. If none
 * exists, it enqueues a vet (the NAS worker fills it) and asks you to re-run.
 *
 * READ-ONLY: never imports the fill/execution path.
 */

import { header, line, run } from './_skill-runtime';
import { getLatestEvaluation, enqueueEvaluation } from '@/lib/hyperliquid/research-trader-service';

run(async () => {
  const address = process.argv[2];
  if (!address) throw new Error('usage: review-trader <0xADDRESS>');

  header(`review-trader — ${address}`);
  const e = await getLatestEvaluation(address);
  if (!e) {
    const { queued } = await enqueueEvaluation(address);
    line(queued ? 'No evaluation yet — enqueued a vet. Re-run after the worker processes it.' : 'No evaluation yet — a vet is already queued. Re-run shortly.');
    return;
  }

  const m = e.metrics as Record<string, unknown>;
  line(`verdict: ${e.verdict.toUpperCase()}  (${e.persistence_confidence} · ${e.window_label} · ${e.fills_seen} fills)`);
  if (typeof m.why === 'string') line(`why: ${m.why}`);
  line(
    `win ${fmtPct(m.winRate)} | med-hold ${fmtNum(m.medianHoldHours)}h | round-trips ${fmtNum(m.roundTrips, 0)} | ` +
      `adds/trip ${fmtNum(m.addsPerTrip, 1)} | worst/win ${fmtNum(m.worstLossVsMedianWin, 1)}× | liq ${fmtNum(m.liquidations, 0)}`,
  );
  line('NOTE: certifies operational feasibility (copyable-with-a-stop), NOT forward profit (single-window).');
});

function fmtNum(v: unknown, d = 2): string {
  return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : '—';
}
function fmtPct(v: unknown): string {
  return typeof v === 'number' && Number.isFinite(v) ? `${(v * 100).toFixed(0)}%` : '—';
}
