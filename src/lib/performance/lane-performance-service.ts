/** Server-only data access for the lane report. No trading or market calls. */
import 'server-only';
import { getServiceRoleClient } from '@/lib/cockpit/supabase-server';
import { computeScoutLaneCards } from '@/lib/scout/lane-scorecard-service';
import { buildLanePerformanceReport, type HypothesisInput, type LadderInput,
  type LanePerformanceReport, type MarkerInput, type OutcomeInput, type RungInput,
  type SnapshotInput } from './lane-performance-business-logic';

export type { LanePerformanceReport } from './lane-performance-business-logic';
type Row = Record<string, unknown>;
const PAGE = 500;
const columns = {
  ladder_outcomes: 'id,ladder_id,title,setup_type,mode,outcome,planned_risk_usd,realized_pnl_usd,realized_r,resolved_at',
  ladders: 'id,title,oco_group_id,mode',
  ladder_rungs: 'id,ladder_id,action,risk_usd',
  hypotheses: 'id,lane,realized_r,realized_pnl_usd,resolved_at,excluded,status',
  change_markers: 'id,at,kind,lanes,title,note,source,ref,proposed_by,confirmed_by,confirmed_at,created_at',
  forecast_snapshots: 'id,made_at,horizon_end,scope,inputs_hash,p5,p25,p50,p75,p95,expected_monthly,p_positive,method,actual,scored_at',
  lane_scorecards: 'lane,kind,verdict,trade_count,updated_at',
} as const;
type Table = keyof typeof columns;

async function readPaged(table: Table, dateColumn: string, missingOk = false, tieColumn = 'id'): Promise<{ rows: Row[]; missing: boolean }> {
  const db = getServiceRoleClient();
  const rows: Row[] = [];
  for (let start = 0; ; start += PAGE) {
    const { data, error } = await db.from(table).select(columns[table])
      .order(dateColumn, { ascending: true }).order(tieColumn, { ascending: true }).range(start, start + PAGE - 1);
    if (error) {
      if (missingOk && (error.code === '42P01' || error.code === 'PGRST205')) return { rows: [], missing: true };
      throw new Error(`${table} read failed: ${error.message}`);
    }
    const page = (data ?? []) as unknown as Row[];
    rows.push(...page);
    if (page.length < PAGE) return { rows, missing: false };
  }
}
const as = <T>(rows: Row[]): T[] => rows as T[];
const iso = (value: string): string => {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`Invalid timestamp: ${value}`);
  return new Date(ms).toISOString();
};

interface Data {
  outcomes: OutcomeInput[]; ladders: LadderInput[]; rungs: RungInput[];
  hypotheses: HypothesisInput[]; markers: MarkerInput[]; snapshots: SnapshotInput[];
  scoutCards: { lane: string; verdict: string; tradeCount: number; updatedAt: string }[];
  persistedScoutCards: { lane: string; verdict: string; tradeCount: number; updatedAt: string }[];
  notes: string[];
}
async function readData(): Promise<Data> {
  const [outcomes, ladders, rungs, hypotheses, markers, snapshots, cards] = await Promise.all([
    readPaged('ladder_outcomes', 'resolved_at'), readPaged('ladders', 'created_at'),
    readPaged('ladder_rungs', 'created_at'), readPaged('hypotheses', 'created_at'),
    readPaged('change_markers', 'at', true), readPaged('forecast_snapshots', 'made_at', true),
    readPaged('lane_scorecards', 'updated_at', true, 'lane'),
  ]);
  const notes: string[] = [];
  if (markers.missing) notes.push('change_markers table is unavailable; apply migration 0046.');
  if (snapshots.missing) notes.push('forecast_snapshots table is unavailable; apply migration 0046.');
  if (cards.missing) notes.push('lane_scorecards table is unavailable; persisted scout verdicts are unavailable.');
  const persistedScoutCards = cards.rows.filter((row) => row.kind === 'positions').map((row) => ({
    lane: String(row.lane), verdict: String(row.verdict), tradeCount: Number(row.trade_count), updatedAt: String(row.updated_at),
  }));
  return { outcomes: as<OutcomeInput>(outcomes.rows), ladders: as<LadderInput>(ladders.rows),
    rungs: as<RungInput>(rungs.rows), hypotheses: as<HypothesisInput>(hypotheses.rows),
    markers: as<MarkerInput>(markers.rows), snapshots: as<SnapshotInput>(snapshots.rows),
    scoutCards: [], persistedScoutCards, notes };
}

function reportFromData(data: Data, options: { since?: string; lane?: string; horizonEnd?: string } = {}, now = new Date()): LanePerformanceReport {
  const horizon = new Date(now);
  horizon.setUTCDate(horizon.getUTCDate() + 30);
  return buildLanePerformanceReport({ ...data, now: now.toISOString(), seed: 20261024,
    horizonEnd: options.horizonEnd ?? horizon.toISOString().slice(0, 10), since: options.since ? iso(options.since) : undefined,
    lane: options.lane });
}

export async function getLanePerformanceReport(options: { since?: string; lane?: string; horizonEnd?: string } = {}): Promise<LanePerformanceReport> {
  const data = await readData();
  try {
    const live = await computeScoutLaneCards();
    data.scoutCards = live.lanes.filter((card) => card.kind === 'positions').map((card) => ({
      lane: card.lane, verdict: card.verdict, tradeCount: card.tradeCount, updatedAt: new Date().toISOString(),
    }));
  } catch (error) {
    data.scoutCards = data.persistedScoutCards;
    data.notes.push(`Live scout scorecard failed; using persisted verdicts: ${error instanceof Error ? error.message : String(error)}`);
  }
  return reportFromData(data, options);
}

export async function getLatestScoutReviewAt(): Promise<string | null> {
  const { data, error } = await getServiceRoleClient().from('scout_reviews').select('created_at')
    .order('created_at', { ascending: false }).order('id', { ascending: false }).limit(1);
  if (error) throw new Error(`scout_reviews read failed: ${error.message}`);
  return data?.[0]?.created_at ?? null;
}

export interface MarkerProposal {
  kind: string; title: string; lanes: string[]; ref: string | null; at: string;
  proposedBy: string; note?: string; source?: string;
}
export async function proposePerformanceMarker(input: MarkerProposal, write: boolean): Promise<MarkerInput> {
  if (!['process', 'system', 'config', 'lane-registered', 'lane-killed', 'sizing'].includes(input.kind)) throw new Error('Invalid marker kind');
  const source = input.source ?? 'manual';
  if (!['commit', 'manifest', 'prereg', 'flag', 'manual'].includes(source)) throw new Error('Invalid marker source');
  const row: MarkerInput = { id: crypto.randomUUID(), at: iso(input.at), kind: input.kind,
    lanes: input.lanes, title: input.title, note: input.note ?? '', source, ref: input.ref,
    proposed_by: input.proposedBy, confirmed_by: null, confirmed_at: null, created_at: new Date().toISOString() };
  if (write) {
    const { error } = await getServiceRoleClient().from('change_markers').insert(row);
    if (error) throw new Error(`change_markers insert failed: ${error.message}`);
  }
  return row;
}

export async function confirmPerformanceMarker(id: string, confirmedBy = 'operator'): Promise<MarkerInput> {
  const { data, error } = await getServiceRoleClient().from('change_markers')
    .update({ confirmed_by: confirmedBy, confirmed_at: new Date().toISOString() })
    .eq('id', id).is('confirmed_at', null).select(columns.change_markers).single();
  if (error) throw new Error(`change_markers confirmation failed: ${error.message}`);
  return data as MarkerInput;
}

export async function freezePerformanceForecast(write: boolean): Promise<SnapshotInput> {
  const now = new Date();
  const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
  const report = await getLanePerformanceReport({ horizonEnd: monthEnd });
  const f = report.forecast;
  if (f.p50.value === null) throw new Error('Cannot freeze a forecast without live episode data');
  const amount = (figure: { value: number | null }) => figure.value ?? 0;
  const row: SnapshotInput = { id: crypto.randomUUID(), made_at: report.generatedAt, horizon_end: f.horizonEnd,
    scope: 'live', inputs_hash: f.inputsHash, p5: amount(f.p5), p25: amount(f.p25),
    p50: amount(f.p50), p75: amount(f.p75), p95: amount(f.p95),
    expected_monthly: amount(f.expectedMonthly), p_positive: amount(f.pPositive),
    method: { ...f.method, seed: f.seed, iterations: f.iterations, sampleN: f.p50.n }, actual: null, scored_at: null };
  if (write) {
    if (report.snapshots.some((snapshot) => snapshot.scope === 'live' && snapshot.made_at.slice(0, 7) === row.made_at.slice(0, 7))) {
      throw new Error('A live forecast is already frozen for this month');
    }
    const { error } = await getServiceRoleClient().from('forecast_snapshots').insert(row);
    if (error) throw new Error(`forecast_snapshots insert failed: ${error.message}`);
  }
  return row;
}

export async function scorePerformanceForecasts(write: boolean): Promise<{ id: string; actual: number; scored_at: string }[]> {
  const data = await readData();
  const now = new Date().toISOString();
  const results = data.snapshots.filter((snapshot) => !snapshot.scored_at && `${snapshot.horizon_end}T23:59:59Z` <= now)
    .map((snapshot) => {
      const after = `${snapshot.made_at}`;
      const through = `${snapshot.horizon_end}T23:59:59Z`;
      const live = data.outcomes.filter((row) => row.mode === 'live' && ['won', 'lost', 'scratch'].includes(row.outcome)
        && row.resolved_at > after && row.resolved_at <= through && row.realized_pnl_usd != null
        && (snapshot.scope === 'live' || row.setup_type === snapshot.scope))
        .reduce((total, row) => total + (row.realized_pnl_usd ?? 0), 0);
      const scout = data.hypotheses.filter((row) => !row.excluded && row.resolved_at != null
        && row.resolved_at > after && row.resolved_at <= through && row.realized_pnl_usd != null
        && (snapshot.scope === 'scout' || row.lane === snapshot.scope))
        .reduce((total, row) => total + (row.realized_pnl_usd ?? 0), 0);
      return { id: snapshot.id, actual: snapshot.scope === 'live' ? live : scout, scored_at: now };
    });
  if (write) for (const row of results) {
    const { error } = await getServiceRoleClient().from('forecast_snapshots')
      .update({ actual: row.actual, scored_at: row.scored_at }).eq('id', row.id).is('scored_at', null);
    if (error) throw new Error(`forecast_snapshots score failed: ${error.message}`);
  }
  return results;
}
