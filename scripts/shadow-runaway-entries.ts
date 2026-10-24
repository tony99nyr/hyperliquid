/** Read-only paired shadow replay for historical runaway entry variants. */
import { fetchCandles } from '@/lib/hyperliquid/candle-service';
import { getServiceRoleClient } from '@/lib/cockpit/supabase-server';
import {
  detectRunawayFromCandles,
  evaluateRunawayDetection,
  RUNAWAY_HORIZONS_MS,
  type RunawayDetectionResult,
  type RunawayShadowCandle,
  type RunawayShadowDetection,
  type RunawayEntryVariant,
} from '@/lib/backtest/runaway-entry-shadow-business-logic';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const VARIANTS: RunawayEntryVariant[] = ['pullback', 'continuation', 'split'];
const NAMES: Record<RunawayEntryVariant, string> = {
  pullback: 'pullback', continuation: 'continuation', split: 'split',
};

interface LadderRow { id: string; title: string; created_at: string; anchor_px: number | string | null }
interface RungRow { ladder_id: string; coin: string; side: 'long' | 'short'; action: string; trigger_px: number | string | null }
interface EpisodeRow { day: string; results: RunawayDetectionResult[] }

function arg(name: string): string | null {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] ?? null : null;
}
function number(value: number | string | null | undefined): number | null {
  if (value == null || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function average(values: number[]): number { return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0; }
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
function pairedCi(deltas: number[]): [number, number] {
  const random = rng(2_401_024);
  const means: number[] = [];
  for (let i = 0; i < 10_000; i++) {
    const sample: number[] = [];
    for (let j = 0; j < deltas.length; j++) sample.push(deltas[Math.floor(random() * deltas.length)]);
    means.push(average(sample));
  }
  means.sort((a, b) => a - b);
  return [means[Math.floor(0.025 * (means.length - 1))], means[Math.floor(0.975 * (means.length - 1))]];
}
function episodeReturn(episode: EpisodeRow, variant: RunawayEntryVariant, horizon: number): number | null {
  const outcomes = episode.results.map((r) => r.strategies[variant].horizons[horizon]);
  if (outcomes.some((outcome) => outcome == null)) return null;
  return average(outcomes.map((outcome) => outcome?.netReturn ?? 0));
}
function episodeMetric(episode: EpisodeRow, variant: RunawayEntryVariant, horizon: number, key: 'fees' | 'overshoot'): number {
  return average(episode.results.map((r) => r.strategies[variant].horizons[horizon]?.[key] ?? 0));
}
function episodeStops(episode: EpisodeRow, variant: RunawayEntryVariant, horizon: number): number {
  return episode.results.filter((r) => r.strategies[variant].horizons[horizon]?.stopHit).length;
}
function asCandles(items: readonly { timestamp: number; open: number; high: number; low: number; close: number }[]): RunawayShadowCandle[] {
  return items.map(({ timestamp, open, high, low, close }) => ({ timestamp, open, high, low, close }));
}

async function loadDraftDetections(sinceMs: number): Promise<RunawayShadowDetection[]> {
  const db = getServiceRoleClient();
  const { data, error } = await db.from('ladders')
    .select('id,title,created_at,anchor_px')
    .ilike('title', '%runaway%')
    .gte('created_at', new Date(sinceMs).toISOString())
    .order('created_at', { ascending: true });
  if (error) throw new Error(`Runaway ladder query failed: ${error.message}`);
  const ladders = (data ?? []) as LadderRow[];
  const detections: RunawayShadowDetection[] = [];
  for (const ladder of ladders) {
    const { data: rungRows, error: rungError } = await db.from('ladder_rungs')
      .select('ladder_id,coin,side,action,trigger_px')
      .eq('ladder_id', ladder.id).eq('action', 'open').order('seq', { ascending: true }).limit(1);
    if (rungError) throw new Error(`Runaway rung query failed for ${ladder.id}: ${rungError.message}`);
    const rung = (rungRows ?? [])[0] as RungRow | undefined;
    const anchor = number(ladder.anchor_px);
    const entry = number(rung?.trigger_px);
    const mark = anchor ?? (entry == null ? null : entry / (rung?.side === 'long' ? 0.965 : 1.035));
    const detectedAt = Date.parse(ladder.created_at);
    if (!rung || mark == null || !Number.isFinite(detectedAt)) continue;
    detections.push({ id: ladder.id, coin: rung.coin, side: rung.side, detectedAt, mark, extreme: mark });
  }
  return detections;
}

async function loadCandleDetections(sinceMs: number, days: number): Promise<RunawayShadowDetection[]> {
  const endMs = Date.now();
  const detections: RunawayShadowDetection[] = [];
  for (const coin of ['BTC', 'ETH', 'SOL', 'HYPE']) {
    const result = await fetchCandles(coin, '1h', sinceMs - DAY, endMs);
    const candles = asCandles(result.candles);
    for (let i = 24; i < candles.length; i++) {
      if (candles[i].timestamp < sinceMs || candles[i].timestamp > sinceMs + days * DAY) continue;
      const found = detectRunawayFromCandles(coin, candles, i);
      if (found) detections.push(found);
    }
  }
  return detections;
}

async function replay(detection: RunawayShadowDetection): Promise<RunawayDetectionResult> {
  const from = detection.detectedAt - DAY;
  const to = detection.detectedAt + 7 * DAY;
  const data = await fetchCandles(detection.coin, '1h', from, to);
  return evaluateRunawayDetection(detection, asCandles(data.candles), RUNAWAY_HORIZONS_MS);
}

async function main(): Promise<void> {
  const days = Number(arg('days') ?? 180);
  if (!Number.isFinite(days) || days <= 0) throw new Error('--days must be positive');
  const source = arg('source') ?? 'both';
  if (!['drafts', 'candles', 'both'].includes(source)) throw new Error('--source must be drafts, candles, or both');
  const since = Date.now() - days * DAY;
  const detections = [
    ...(source !== 'candles' ? await loadDraftDetections(since) : []),
    ...(source !== 'drafts' ? await loadCandleDetections(since, days) : []),
  ];
  const unique = new Map<string, RunawayShadowDetection>();
  for (const d of detections) {
    const key = `${d.coin}:${d.detectedAt}`;
    if (!unique.has(key)) unique.set(key, d);
  }
  const results: RunawayDetectionResult[] = [];
  for (const detection of unique.values()) results.push(await replay(detection));
  const grouped = new Map<string, EpisodeRow>();
  for (const result of results) {
    const row = grouped.get(result.episodeDay) ?? { day: result.episodeDay, results: [] };
    row.results.push(result);
    grouped.set(result.episodeDay, row);
  }
  const episodes = [...grouped.values()].sort((a, b) => a.day.localeCompare(b.day));
  console.log(`Runaway entry shadow test | ${episodes.length} UTC-day episodes | ${results.length} detections | source=${source}`);
  console.log('Costs: 5bp each side. Stop: 5% from fill. Stops use candle open on gaps. No fill = zero return.');
  console.log('Pullback fills use candle-level price touch; live momentumConfirm inputs are not reconstructed.');
  for (const episode of episodes) {
    const fills = VARIANTS.map((v) => {
      const strategies = episode.results.map((r) => r.strategies[v]);
      const filled = strategies.filter((r) => r.filledFraction > 0).length;
      const fraction = average(strategies.map((r) => r.filledFraction));
      return `${NAMES[v]}=${filled}/${episode.results.length} noTrade=${episode.results.length - filled} meanFill=${(fraction * 100).toFixed(1)}%`;
    }).join(' ');
    console.log(`${episode.day} detections=${episode.results.length} fills ${fills}`);
  }
  for (const horizon of RUNAWAY_HORIZONS_MS) {
    const label = horizon === RUNAWAY_HORIZONS_MS[0] ? '48h' : '7d';
    console.log(`\n${label}: episode means and paired improvements`);
    for (const variant of VARIANTS) {
      const vals = episodes.map((e) => episodeReturn(e, variant, horizon)).filter((v): v is number => v != null);
      const fees = average(episodes.map((e) => episodeMetric(e, variant, horizon, 'fees')));
      const overshoot = average(episodes.map((e) => episodeMetric(e, variant, horizon, 'overshoot')));
      const stops = episodes.reduce((sum, e) => sum + episodeStops(e, variant, horizon), 0);
      console.log(`${variant}: n=${vals.length} mean=${(average(vals) * 100).toFixed(3)}% fees=${(fees * 100).toFixed(3)}% avgOvershoot=${(overshoot * 100).toFixed(3)}% stopDetections=${stops}`);
    }
    for (const alternative of ['continuation', 'split'] as const) {
      const deltas = episodes.flatMap((e) => {
        const candidate = episodeReturn(e, alternative, horizon);
        const baseline = episodeReturn(e, 'pullback', horizon);
        return candidate == null || baseline == null ? [] : [candidate - baseline];
      });
      const [low, high] = deltas.length ? pairedCi(deltas) : [Number.NaN, Number.NaN];
      console.log(`${alternative} - pullback: n=${deltas.length} mean=${(average(deltas) * 100).toFixed(3)}% 95% episode-bootstrap CI [${(low * 100).toFixed(3)}%, ${(high * 100).toFixed(3)}%]`);
    }
    console.log('Paired rows:');
    for (const episode of episodes) {
      const fmt = (v: number | null): string => v == null ? 'NA' : `${(v * 100).toFixed(3)}%`;
      const p = episodeReturn(episode, 'pullback', horizon);
      console.log(`${episode.day} pullback=${fmt(p)} continuation=${fmt(episodeReturn(episode, 'continuation', horizon))} split=${fmt(episodeReturn(episode, 'split', horizon))}`);
    }
  }
  console.log(`Decision gate: do not consider adoption before 10 episodes; require paired improvement CI to exclude 0 after overshoot.`);
}

void main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
