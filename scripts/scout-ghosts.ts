import { run, parseArgs, line, header } from './_skill-runtime';
import { getServiceRoleClient } from '@/lib/cockpit/supabase-server';
import { fetchCandles } from '@/lib/hyperliquid/candle-service';
import { resolveBlackoutGhost, type BlackoutGhost } from '@/lib/scout/blackout-ghost-business-logic';
import type { CandleInterval } from '@/lib/hyperliquid/candle-service-business-logic';

interface GhostRow {
  id: string;
  coin: string;
  lane: string;
  created_at: string;
  detail: Record<string, unknown> | null;
}

run(async () => {
  const args = parseArgs(process.argv.slice(2));
  const write = args.write === true;
  const db = getServiceRoleClient();
  const { data, error } = await db.from('scout_decisions')
    .select('id, coin, lane, created_at, detail')
    .eq('kind', 'blackout-ghost').order('created_at', { ascending: true });
  if (error) throw new Error(`ghost read failed: ${error.message}`);
  const ghosts = (data ?? []) as unknown as GhostRow[];
  header(`Blackout ghosts (${ghosts.length})${write ? ' — writing resolutions' : ''}`);
  for (const row of ghosts) {
    const d = row.detail;
    if (!d || typeof d.signalPrice !== 'number' || typeof d.stopPx !== 'number' ||
        typeof d.riskUsd !== 'number' || (d.side !== 'long' && d.side !== 'short')) {
      line(`${row.created_at} ${row.lane} ${row.coin}: missing frozen trade terms`);
      continue;
    }
    const createdAtMs = Date.parse(row.created_at);
    const exitHorizonMs = createdAtMs + 7 * 86_400_000;
    const interval: CandleInterval = row.lane === 'compression-straddle' ? '4h' : '1d';
    const lookbackMs = row.lane === 'compression-straddle' ? 20 * 4 * 3_600_000 : 11 * 86_400_000;
    const candles = await fetchCandles(row.coin, interval, createdAtMs - lookbackMs, Math.min(Date.now(), exitHorizonMs)).catch(() => null);
    if (!candles || candles.candles.length === 0) {
      line(`${row.created_at} ${row.lane} ${row.coin}: candle data unavailable`);
      continue;
    }
    const ghost: BlackoutGhost = {
      lane: row.lane, coin: row.coin, side: d.side,
      entryPx: d.signalPrice, stopPx: d.stopPx, riskUsd: d.riskUsd,
      createdAtMs, exitHorizonMs,
    };
    const result = resolveBlackoutGhost(ghost, candles.candles, interval, Date.now());
    if (result.status === 'pending') {
      line(`${row.created_at} ${row.lane} ${row.coin}: pending (${result.reason})`);
      continue;
    }
    line(`${row.created_at} ${row.lane} ${row.coin} ${String(d.side)}: ${result.r.toFixed(2)}R / $${result.pnlUsd.toFixed(2)} (${result.reason})`);
    const eventId = typeof d.eventId === 'string' ? d.eventId : 'unknown-event';
    const eventAtMs = typeof d.eventAt === 'string' ? Date.parse(d.eventAt) : createdAtMs;
    const { data: taken, error: takenError } = await db.from('positions')
      .select('coin, lane, side, opened_at, realized_pnl_usd, avg_entry_px, sz, stop_px, sessions!inner(mode)')
      .eq('lane', row.lane)
      .eq('sessions.mode', 'paper')
      .gte('opened_at', new Date(eventAtMs - 7 * 86_400_000).toISOString())
      .lte('opened_at', new Date(eventAtMs + 7 * 86_400_000).toISOString());
    if (takenError) line(`  ${eventId}: taken-trade comparison unavailable (${takenError.message})`);
    else {
      line(`  event ${eventId}; lane trades around print:`);
      for (const trade of taken ?? []) {
        const risk = Math.abs(Number(trade.avg_entry_px) - Number(trade.stop_px)) * Math.abs(Number(trade.sz));
        const pnl = Number(trade.realized_pnl_usd ?? 0);
        const r = risk > 0 ? `${(pnl / risk).toFixed(2)}R` : 'R unavailable';
        line(`    ${trade.opened_at ?? '?'} ${trade.coin} ${trade.side}: ${r} / $${pnl.toFixed(2)}`);
      }
    }
    if (write) {
      const { error: updateError } = await db.from('scout_decisions')
        .update({ detail: { ...d, resolution: result } })
        .eq('id', row.id).eq('kind', 'blackout-ghost');
      if (updateError) line(`  write failed: ${updateError.message}`);
    }
  }
});
