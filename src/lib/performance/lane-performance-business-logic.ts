/** Pure lane ledger. One episode groups consecutive resolutions no more than five days apart. */
import { buildExpectancyReport, DEFAULT_EXPECTANCY_BAR, type LadderOutcomeRow } from '@/lib/skills/ladder-expectancy-business-logic';
import { registeredLaneBar } from '@/lib/scout/scout-lane-bars-business-logic';
import { forecastLanes, type ForecastResult } from './lane-performance-forecast-business-logic';

export type Unit = 'usd' | 'r' | 'r_nominal' | 'r_slip' | 'probability' | 'per_day' | 'days';
export interface Figure { value: number | null; n: number; unit: Unit; source: string }
export interface OutcomeInput {
  ladder_id: string; title: string; setup_type: string; mode: string; outcome: string;
  planned_risk_usd: number; realized_pnl_usd: number | null; realized_r: number | null;
  resolved_at: string;
}
export interface LadderInput { id: string; title: string; oco_group_id: string | null; mode: string }
export interface RungInput { ladder_id: string; action: string; risk_usd: number | null }
export interface HypothesisInput {
  id: string; lane: string | null; realized_r: number | null; realized_pnl_usd: number | null;
  resolved_at: string | null; excluded: boolean; status: string;
}
export interface MarkerInput {
  id: string; at: string; kind: string; lanes: string[]; title: string; note: string;
  source: string; ref: string | null; proposed_by: string; confirmed_by: string | null;
  confirmed_at: string | null; created_at: string;
}
export interface SnapshotInput {
  id: string; made_at: string; horizon_end: string; scope: string; inputs_hash: string;
  p5: number; p25: number; p50: number; p75: number; p95: number;
  expected_monthly: number; p_positive: number; method: Record<string, unknown>;
  actual: number | null; scored_at: string | null;
}
export interface SnapshotResult extends Omit<SnapshotInput, 'p5' | 'p25' | 'p50' | 'p75' | 'p95' | 'expected_monthly' | 'p_positive' | 'actual'> {
  p5: Figure; p25: Figure; p50: Figure; p75: Figure; p95: Figure;
  expected_monthly: Figure; p_positive: Figure; actual: Figure;
}
export interface SeriesPoint {
  at: string; usd: Figure; r: Figure; slipR: Figure; nominalR: Figure;
}
export interface MarkerSplit {
  markerId: string; before: { usd: Figure; meanR: Figure }; after: { usd: Figure; meanR: Figure };
}
export interface LaneResult {
  id: string; kind: 'live' | 'scout'; verdict: string;
  persistedVerdict: { verdict: string; updatedAt: string } | null;
  bar: { minCloses: number; minMeanR: number; killMeanR: number | null; killAfterCloses: number | null;
    slowBleedDays: number | null; slowBleedMinCloses: number | null; source: string };
  trades: number; episodes: number; signalRatePerDay: Figure; plannedRiskUsd: Figure;
  netUsd: Figure; netR: Figure; netSlipR: Figure; netNominalR: Figure;
  meanRPerTrade: Figure; meanRPerEpisode: Figure;
  timeToVerdict: { current: number; required: number; remaining: number; ratePerDay: Figure; eta: string | null; reason: string | null };
  series: SeriesPoint[]; markerSplits: MarkerSplit[];
}
export interface LanePerformanceReport {
  schemaVersion: 1; generatedAt: string; lanes: LaneResult[]; markers: MarkerInput[];
  overview: { live: SeriesPoint[]; scout: SeriesPoint[] }; forecast: ForecastResult;
  snapshots: SnapshotResult[]; notes: string[];
}
export interface ReportInput {
  outcomes: OutcomeInput[]; ladders: LadderInput[]; rungs: RungInput[];
  hypotheses: HypothesisInput[]; markers: MarkerInput[]; snapshots: SnapshotInput[];
  scoutCards: { lane: string; verdict: string; tradeCount: number; updatedAt: string }[];
  persistedScoutCards?: { lane: string; verdict: string; tradeCount: number; updatedAt: string }[];
  now: string; seed: number; horizonEnd: string; since?: string; lane?: string; notes?: string[];
}
interface Event { lane: string; kind: 'live' | 'scout'; at: string; usd: number; slipR: number | null; nominalR: number | null; risk: number | null; source: string }
const DAY = 86_400_000;
const EPISODE_GAP = 5 * DAY;
const fig = (value: number | null, n: number, unit: Unit, source: string): Figure => ({ value, n, unit, source });
const finite = (value: number | null | undefined): value is number => value != null && Number.isFinite(value);
const sum = (values: number[]): number => values.reduce((a, b) => a + b, 0);

/** The prep script names both legs "straddle" and gives them one OCO group. */
export function isEventStraddle(ladder: LadderInput, groupCounts: Map<string, number>): boolean {
  return ladder.mode === 'live' && /straddle/i.test(ladder.title) &&
    ladder.oco_group_id != null && (groupCounts.get(ladder.oco_group_id) ?? 0) >= 2;
}

function eventsOf(input: ReportInput): Event[] {
  const ladders = new Map(input.ladders.map((row) => [row.id, row]));
  const groups = new Map<string, number>();
  for (const row of input.ladders) if (row.oco_group_id) groups.set(row.oco_group_id, (groups.get(row.oco_group_id) ?? 0) + 1);
  const risk = new Map<string, number>();
  for (const row of input.rungs) if (row.action === 'open' || row.action === 'add') {
    risk.set(row.ladder_id, (risk.get(row.ladder_id) ?? 0) + (finite(row.risk_usd) ? row.risk_usd : 0));
  }
  const result: Event[] = [];
  for (const row of input.outcomes) {
    if (row.mode !== 'live' || !['won', 'lost', 'scratch'].includes(row.outcome) || !finite(row.realized_pnl_usd)) continue;
    const ladder = ladders.get(row.ladder_id);
    const lane = ladder && isEventStraddle(ladder, groups) ? 'event-straddle' : row.setup_type;
    const nominalRisk = risk.get(row.ladder_id);
    result.push({ lane, kind: 'live', at: row.resolved_at, usd: row.realized_pnl_usd,
      slipR: finite(row.realized_r) ? row.realized_r : row.planned_risk_usd > 0 ? row.realized_pnl_usd / row.planned_risk_usd : null,
      nominalR: nominalRisk && nominalRisk > 0 ? row.realized_pnl_usd / nominalRisk : null,
      risk: row.planned_risk_usd > 0 ? row.planned_risk_usd : null, source: 'ladder_outcomes' });
  }
  for (const row of input.hypotheses) {
    if (row.excluded || !row.lane || !row.resolved_at || !finite(row.realized_pnl_usd)) continue;
    result.push({ lane: row.lane, kind: 'scout', at: row.resolved_at, usd: row.realized_pnl_usd,
      slipR: finite(row.realized_r) ? row.realized_r : null, nominalR: null,
      risk: null,
      source: 'hypotheses' });
  }
  return result.filter((event) => Number.isFinite(Date.parse(event.at)) && (!input.since || event.at >= input.since) && (!input.lane || event.lane === input.lane))
    .sort((a, b) => a.at.localeCompare(b.at) || a.lane.localeCompare(b.lane));
}

interface Episode { at: string; usd: number; slipR: number | null; nominalR: number | null; risk: number | null }
function episodesOf(events: Event[]): Episode[] {
  const episodes: Episode[] = [];
  for (const event of events) {
    const last = episodes.at(-1);
    // The five-day window is anchored to the first resolution in each episode.
    if (!last || Date.parse(event.at) - Date.parse(last.at) > EPISODE_GAP) {
      episodes.push({ at: event.at, usd: event.usd, slipR: event.slipR, nominalR: event.nominalR, risk: event.risk });
    } else {
      last.usd += event.usd;
      last.slipR = finite(last.slipR) && finite(event.slipR) ? last.slipR + event.slipR : null;
      last.nominalR = finite(last.nominalR) && finite(event.nominalR) ? last.nominalR + event.nominalR : null;
      last.risk = finite(last.risk) && finite(event.risk) ? last.risk + event.risk : last.risk ?? event.risk;
    }
  }
  return episodes;
}

function split(episodes: Episode[], marker: MarkerInput, source: string, kind: 'live' | 'scout'): MarkerSplit {
  const aggregate = (rows: Episode[]) => {
    const rs = rows.map((row) => row.slipR).filter(finite);
    return { usd: fig(sum(rows.map((row) => row.usd)), rows.length, 'usd', source),
      meanR: fig(rs.length ? sum(rs) / rs.length : null, rs.length, kind === 'live' ? 'r_slip' : 'r', source) };
  };
  return { markerId: marker.id, before: aggregate(episodes.filter((row) => row.at < marker.at)),
    after: aggregate(episodes.filter((row) => row.at >= marker.at)) };
}

export function buildLanePerformanceReport(input: ReportInput): LanePerformanceReport {
  const events = eventsOf(input);
  const byLane = new Map<string, Event[]>();
  for (const event of events) (byLane.get(event.lane) ?? byLane.set(event.lane, []).get(event.lane)!).push(event);
  const markers = input.markers.filter((marker) => !input.lane || marker.lanes.length === 0 || marker.lanes.includes(input.lane));
  const confirmed = markers.filter((marker) => marker.confirmed_at != null);
  const nowMs = Date.parse(input.now);
  const ladderById = new Map(input.ladders.map((row) => [row.id, row]));
  const groupCounts = new Map<string, number>();
  for (const row of input.ladders) if (row.oco_group_id) groupCounts.set(row.oco_group_id, (groupCounts.get(row.oco_group_id) ?? 0) + 1);
  const canonicalRows: LadderOutcomeRow[] = input.outcomes.filter((row) => row.mode === 'live' &&
    ['won', 'lost', 'scratch'].includes(row.outcome) && finite(row.realized_pnl_usd) &&
    (!input.since || row.resolved_at >= input.since)).map((row) => {
    const ladder = ladderById.get(row.ladder_id);
    return { ladderId: row.ladder_id, title: row.title, coin: '', side: 'long', mode: 'live',
      setupType: ladder && isEventStraddle(ladder, groupCounts) ? 'event-straddle' : row.setup_type,
      signalScore: null, timingScore: null, plannedRiskUsd: row.planned_risk_usd,
      realizedPnlUsd: row.realized_pnl_usd, feesUsd: null, realizedR: row.realized_r,
      outcome: row.outcome as 'won' | 'lost' | 'scratch', windowStartMs: 0,
      windowEndMs: Date.parse(row.resolved_at), notes: null };
  });
  const liveCards = new Map(buildExpectancyReport(canonicalRows, DEFAULT_EXPECTANCY_BAR).perSetup.map((row) => [row.setupType, row]));
  const scoutCards = new Map(input.scoutCards.map((row) => [row.lane, row]));
  const persistedScoutCards = new Map((input.persistedScoutCards ?? []).map((row) => [row.lane, row]));
  const lanes: LaneResult[] = [...byLane].sort(([a], [b]) => a.localeCompare(b)).map(([id, rows]) => {
    const kind = rows[0].kind;
    const source = rows[0].source;
    const episodes = episodesOf(rows);
    const episodeRs = episodes.map((row) => row.slipR).filter(finite);
    const tradeRs = rows.map((row) => row.slipR).filter(finite);
    const recent = rows.filter((row) => Date.parse(row.at) >= nowMs - 90 * DAY && Date.parse(row.at) <= nowMs);
    const recentEpisodes = episodes.filter((row) => Date.parse(row.at) >= nowMs - 90 * DAY && Date.parse(row.at) <= nowMs);
    const risks = episodes.map((row) => row.risk).filter(finite);
    const bar = kind === 'scout' ? registeredLaneBar(id) : null;
    const minCloses = kind === 'live' ? DEFAULT_EXPECTANCY_BAR.minTrades : bar?.config.minTradesToGraduate ?? 0;
    const minMeanR = kind === 'live' ? DEFAULT_EXPECTANCY_BAR.sizeUpExpectancyR : bar?.minExpectancyR ?? 0;
    const liveCard = liveCards.get(id);
    const scoutCard = scoutCards.get(id);
    const persistedCard = persistedScoutCards.get(id);
    const verdict = kind === 'live' ? liveCard?.verdict ?? 'UNAVAILABLE' : scoutCard?.verdict.toUpperCase() ?? 'UNAVAILABLE';
    const trades = kind === 'live' ? liveCard?.closedTrades ?? rows.length : scoutCard?.tradeCount ?? rows.length;
    const remaining = Math.max(0, minCloses - trades);
    const ratePerDay = recent.length / 90;
    const eta = ratePerDay > 0 ? remaining === 0 ? input.now.slice(0, 10)
      : new Date(nowMs + Math.ceil(remaining / ratePerDay) * DAY).toISOString().slice(0, 10) : null;
    const reason = eta ? null : `No closes in the last 90 days for ${id}.`;
    let usd = 0; let slip = 0; let nom = 0; let slipN = 0; let nomN = 0;
    let episodeStart = ''; let episodeCount = 0; let episodeHasSlip = false; let episodeHasNominal = false;
    const series = rows.map((row) => {
      if (!episodeStart || Date.parse(row.at) - Date.parse(episodeStart) > EPISODE_GAP) {
        episodeStart = row.at; episodeCount++; episodeHasSlip = false; episodeHasNominal = false;
      }
      usd += row.usd;
      if (finite(row.slipR)) { slip += row.slipR; if (!episodeHasSlip) slipN++; episodeHasSlip = true; }
      if (finite(row.nominalR)) { nom += row.nominalR; if (!episodeHasNominal) nomN++; episodeHasNominal = true; }
      return { at: row.at, usd: fig(usd, episodeCount, 'usd', source),
        r: fig(kind === 'scout' && slipN ? slip : null, kind === 'scout' ? slipN : 0, 'r', source),
        slipR: fig(kind === 'live' && slipN ? slip : null, kind === 'live' ? slipN : 0, 'r_slip', source),
        nominalR: fig(kind === 'live' && nomN ? nom : null, kind === 'live' ? nomN : 0, 'r_nominal', source) };
    });
    return { id, kind, verdict,
      persistedVerdict: kind === 'scout' && persistedCard
        ? { verdict: persistedCard.verdict.toUpperCase(), updatedAt: persistedCard.updatedAt } : null,
      bar: { minCloses, minMeanR,
      killMeanR: kind === 'live' ? DEFAULT_EXPECTANCY_BAR.killExpectancyR : null,
      killAfterCloses: kind === 'scout' ? bar?.config.killAfterTrades ?? null : null,
      slowBleedDays: kind === 'scout' ? bar?.config.slowBleedDays ?? null : null,
      slowBleedMinCloses: kind === 'scout' ? bar?.config.slowBleedMinTrades ?? null : null,
      source: kind === 'live' ? 'DEFAULT_EXPECTANCY_BAR' : bar ? `data/scout/lane-bars-${bar.version}.json` : 'unregistered' },
      trades, episodes: episodes.length, signalRatePerDay: fig(recentEpisodes.length / 90, recentEpisodes.length, 'per_day', source),
      plannedRiskUsd: fig(risks.length ? sum(risks) / risks.length : null, risks.length, 'usd', kind === 'live' ? 'ladder_outcomes' : 'hypotheses'),
      netUsd: fig(usd, episodes.length, 'usd', source), netR: fig(kind === 'scout' && slipN ? slip : null, kind === 'scout' ? slipN : 0, 'r', source),
      netSlipR: fig(kind === 'live' && slipN ? slip : null, kind === 'live' ? slipN : 0, 'r_slip', source),
      netNominalR: fig(kind === 'live' && nomN ? nom : null, kind === 'live' ? nomN : 0, 'r_nominal', source),
      meanRPerTrade: fig(tradeRs.length === rows.length ? sum(tradeRs) / rows.length : null,
        rows.length, kind === 'live' ? 'r_slip' : 'r', source),
      meanRPerEpisode: fig(episodeRs.length === episodes.length ? sum(episodeRs) / episodes.length : null,
        episodes.length, kind === 'live' ? 'r_slip' : 'r', source),
      timeToVerdict: { current: trades, required: minCloses, remaining, ratePerDay: fig(ratePerDay, recent.length, 'per_day', source), eta, reason },
      series, markerSplits: confirmed.filter((marker) => marker.lanes.length === 0 || marker.lanes.includes(id)).map((marker) => split(episodes, marker, source, kind)) };
  });
  const episodeUsd = new Map<string, number[]>();
  for (const lane of lanes.filter((row) => row.kind === 'live')) {
    episodeUsd.set(lane.id, episodesOf(byLane.get(lane.id) ?? [])
      .filter((row) => Date.parse(row.at) >= nowMs - 90 * DAY && Date.parse(row.at) <= nowMs)
      .map((row) => row.usd));
  }
  const overview = { live: [] as SeriesPoint[], scout: [] as SeriesPoint[] };
  for (const kind of ['live', 'scout'] as const) {
    let usd = 0; let slip = 0; let nominal = 0; let slipN = 0; let nominalN = 0;
    const ordered = events.filter((event) => event.kind === kind);
    overview[kind] = ordered.map((event, index) => {
      usd += event.usd;
      if (finite(event.slipR)) { slip += event.slipR; slipN++; }
      if (finite(event.nominalR)) { nominal += event.nominalR; nominalN++; }
      const source = kind === 'live' ? 'ladder_outcomes' : 'hypotheses';
      return { at: event.at, usd: fig(usd, index + 1, 'usd', source),
        r: fig(kind === 'scout' && slipN ? slip : null, kind === 'scout' ? slipN : 0, 'r', source),
        slipR: fig(kind === 'live' && slipN ? slip : null, kind === 'live' ? slipN : 0, 'r_slip', source),
        nominalR: fig(kind === 'live' && nominalN ? nominal : null, kind === 'live' ? nominalN : 0, 'r_nominal', source) };
    });
  }
  const snapshots: SnapshotResult[] = input.snapshots.map((snapshot) => {
    const n = typeof snapshot.method.sampleN === 'number' ? snapshot.method.sampleN : 0;
    const dollars = (value: number | null) => fig(value, n, 'usd', 'forecast_snapshots');
    return { ...snapshot, p5: dollars(snapshot.p5), p25: dollars(snapshot.p25),
      p50: dollars(snapshot.p50), p75: dollars(snapshot.p75), p95: dollars(snapshot.p95),
      expected_monthly: dollars(snapshot.expected_monthly),
      p_positive: fig(snapshot.p_positive, n, 'probability', 'forecast_snapshots'),
      actual: dollars(snapshot.actual) };
  });
  return { schemaVersion: 1, generatedAt: input.now, lanes, overview, markers,
    forecast: forecastLanes(lanes, episodeUsd, input.now, input.horizonEnd, input.seed), snapshots,
    notes: [...(input.notes ?? []), ...lanes.filter((lane) => lane.kind === 'scout' &&
      lane.persistedVerdict && lane.verdict !== lane.persistedVerdict.verdict).map((lane) =>
      `${lane.id}: live ${lane.verdict} differs from persisted ${lane.persistedVerdict!.verdict} (${lane.persistedVerdict!.updatedAt}).`)] };
}
