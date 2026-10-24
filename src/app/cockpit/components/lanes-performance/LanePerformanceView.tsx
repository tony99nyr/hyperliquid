'use client';

import { useState } from 'react';
import { Area, AreaChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { Figure, LanePerformanceReport, LaneResult, MarkerInput } from '@/lib/performance/lane-performance-business-logic';
import { useLanePerformance } from '@/hooks/useLanePerformance';
import { useUrlParamState } from '@/hooks/useUrlParamState';
import { GH, TERM } from '../panel-styles';
import { formatFigure, formatLoss, formatNote, formatUtcDate, formatUtcTimestamp, groupMarkers, verdictChip } from './format';

type Subview = 'overview' | 'lanes' | 'forecast' | 'changes';
type Filter = 'all' | 'live' | 'scout';
const VIEWS: readonly Subview[] = ['overview', 'lanes', 'forecast', 'changes'];
const BLUE = '#75a0ff';
const ORANGE = '#efa965';
const card: React.CSSProperties = { background: TERM.surface, border: `1px solid ${GH.border}`, borderRadius: 12, padding: 16, minWidth: 0 };
const button: React.CSSProperties = { minHeight: 44, minWidth: 44, padding: '9px 14px', border: `1px solid ${GH.border}`, borderRadius: 8, background: TERM.button, color: GH.textBright, cursor: 'pointer', fontSize: 12 };
const selectedButton: React.CSSProperties = { background: '#365a9b', borderColor: '#91b8ff', color: '#ffffff', fontWeight: 700 };
const muted: React.CSSProperties = { color: GH.textMuted, fontSize: 12 };
const chartShell: React.CSSProperties = { width: '100%', height: 260, minWidth: 0 };

function FigureValue({ figure, countUnit, loss = false }: { figure: Figure; countUnit?: string; loss?: boolean }) {
  return <span title={figure.source} style={{ overflowWrap: 'anywhere', fontVariantNumeric: 'tabular-nums' }}>{loss ? formatLoss(figure) : formatFigure(figure)}{figure.unit === 'r_slip' ? ' slip' : figure.unit === 'r_nominal' ? ' nominal' : ''} <small style={muted}>n={figure.n}{countUnit ? ` ${countUnit}${figure.n === 1 ? '' : 's'}` : ''}</small></span>;
}

function Tile({ label, figure, loss = false }: { label: string; figure: Figure; loss?: boolean }) {
  return <div style={card}><div style={muted}>{label}</div><div style={{ fontSize: 20, fontWeight: 650, marginTop: 8, fontVariantNumeric: 'tabular-nums', overflowWrap: 'anywhere' }}><FigureValue figure={figure} loss={loss} /></div></div>;
}

function Tag({ kind }: { kind: string }) {
  const live = kind === 'live';
  return <span style={{ color: live ? BLUE : kind === 'scout' ? ORANGE : GH.textMuted, fontSize: 11, fontWeight: 700, textTransform: 'uppercase' }}>{kind}</span>;
}

function Verdict({ text }: { text: string }) {
  const style = verdictChip(text);
  return <span style={{ color: style.colour, background: style.background, borderRadius: 5, padding: '5px 8px', fontSize: 11, fontWeight: 700 }}>{text}</span>;
}

function ScopeFilter({ value, setValue }: { value: Filter; setValue: (value: Filter) => void }) {
  return <div aria-label="Lane filter" style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
    {(['all', 'live', 'scout'] as const).map((item) => <button key={item} type="button" aria-pressed={value === item} onClick={() => setValue(item)} style={{ ...button, ...(value === item ? selectedButton : {}) }}>{item[0].toUpperCase() + item.slice(1)}</button>)}
  </div>;
}

type ChartRow = { at: string; epoch: number; live?: number | null; scout?: number | null; p5?: number | null; p50?: number | null; p95?: number | null; band?: [number, number] };

export function chartTimeAxis(points: ChartRow[], horizonEnd: string, start?: number): { domain: [number, number]; ticks: number[] } {
  const epochs = points.map((point) => point.epoch).filter(Number.isFinite);
  const horizon = Date.parse(horizonEnd);
  if (Number.isFinite(horizon)) epochs.push(horizon);
  const min = start ?? (epochs.length ? Math.min(...epochs) : Date.now());
  const max = epochs.length ? Math.max(...epochs) : min;
  const domain: [number, number] = [min, max > min ? max : min + 86_400_000];
  const seen = new Set<string>();
  const ticks = Array.from({ length: 6 }, (_, index) => min + (domain[1] - min) * index / 5).filter((tick) => {
    const label = formatUtcDate(tick, 'tick');
    if (seen.has(label)) return false;
    seen.add(label);
    return true;
  });
  return { domain, ticks };
}

function Chart({ points, horizonEnd, forecast, markers, filter, start }: { points: ChartRow[]; horizonEnd: string; forecast?: boolean; markers?: MarkerInput[]; filter?: Filter; start?: number }) {
  const { domain, ticks } = chartTimeAxis(points, horizonEnd, start);
  if (!points.some((point) => [point.live, point.scout, point.p5, point.p50, point.p95].some((value) => value !== null && value !== undefined))) return <p>No chart data yet</p>;
  return <div role="img" aria-label={forecast ? 'Forecast fan from P5 to P95, with dashed P50' : 'Cumulative net profit and loss for live and scout lanes, with confirmed change markers'} style={chartShell}>
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={points} margin={{ top: 18, right: 12, bottom: 2, left: 2 }}>
        <CartesianGrid stroke={GH.border} vertical={false} />
        <XAxis type="number" dataKey="epoch" domain={domain} scale="linear" ticks={ticks} allowDataOverflow tickFormatter={(value: number) => formatUtcDate(value, 'tick')} tick={{ fill: GH.textMuted, fontSize: 11 }} minTickGap={28} />
        <YAxis tick={{ fill: GH.textMuted, fontSize: 11 }} width={55} />
        <Tooltip labelFormatter={(value) => formatUtcDate(Number(value), 'legend')} contentStyle={{ background: TERM.raised, border: `1px solid ${GH.border}`, color: GH.textBright }} />
        {!forecast && filter !== 'scout' && <Area type="monotone" dataKey="live" name="Live USD" stroke={BLUE} fill="rgba(117,160,255,.15)" connectNulls isAnimationActive={false} />}
        {!forecast && filter !== 'live' && <Area type="monotone" dataKey="scout" name="Scout USD" stroke={ORANGE} strokeDasharray="7 4" fill="rgba(239,169,101,.12)" connectNulls isAnimationActive={false} />}
        <Area type="monotone" dataKey="band" name="Forecast P5–P95" stroke="none" fill="rgba(117,160,255,.38)" fillOpacity={1} connectNulls isAnimationActive={false} />
        <Area type="monotone" dataKey="p5" name="Forecast P5" stroke={BLUE} fill="none" connectNulls isAnimationActive={false} />
        <Area type="monotone" dataKey="p95" name="Forecast P95" stroke={BLUE} fill="none" connectNulls isAnimationActive={false} />
        <Area type="monotone" dataKey="p50" name="Forecast P50" stroke={BLUE} strokeDasharray="5 4" fill="none" connectNulls isAnimationActive={false} />
        {markers?.map((marker, index) => ({ marker, index })).filter(({ marker }) => Date.parse(marker.at) >= domain[0] && Date.parse(marker.at) <= domain[1]).map(({ marker, index }) => <ReferenceLine key={marker.id} x={Date.parse(marker.at)} stroke={GH.textMuted} strokeDasharray="3 3" label={{ value: String(index + 1), fill: GH.textBright, fontSize: 12 }} />)}
      </AreaChart>
    </ResponsiveContainer>
  </div>;
}

export function chartRows(report: LanePerformanceReport) {
  const rows = new Map<number, ChartRow>();
  for (const kind of ['live', 'scout'] as const) for (const point of report.overview[kind]) {
    const epoch = Date.parse(point.at);
    const row = rows.get(epoch) ?? { at: point.at, epoch };
    row[kind] = point.usd.value;
    rows.set(epoch, row);
  }
  const lastLive = report.overview.live.at(-1);
  const anchor = lastLive?.usd.value;
  if (lastLive && anchor !== null && anchor !== undefined && report.forecast.fan.length) {
    const epoch = Date.parse(lastLive.at);
    const row = rows.get(epoch) ?? { at: lastLive.at, epoch };
    row.p5 = anchor; row.p50 = anchor; row.p95 = anchor; row.band = [anchor, anchor];
    rows.set(epoch, row);
  }
  for (const point of report.forecast.fan) {
    const epoch = Date.parse(point.at);
    const row = rows.get(epoch) ?? { at: point.at, epoch };
    row.p5 = anchor !== null && anchor !== undefined && point.p5.value !== null ? anchor + point.p5.value : null;
    row.p50 = anchor !== null && anchor !== undefined && point.p50.value !== null ? anchor + point.p50.value : null;
    row.p95 = anchor !== null && anchor !== undefined && point.p95.value !== null ? anchor + point.p95.value : null;
    if (row.p5 !== null && row.p95 !== null) row.band = [row.p5, row.p95];
    rows.set(epoch, row);
  }
  // Every row carries every series key (null when absent) so connectNulls can bridge gaps.
  return [...rows.values()].sort((a, b) => a.epoch - b.epoch).map((row) => ({
    live: null, scout: null, p5: null, p50: null, p95: null, ...row,
  }));
}

function Overview({ report, filter, setFilter }: { report: LanePerformanceReport; filter: Filter; setFilter: (value: Filter) => void }) {
  const confirmed = groupMarkers(report.markers).confirmed;
  const live = report.overview.live.at(-1)?.usd;
  const scout = report.lanes.find((lane) => lane.id === 'htf-trend' && lane.kind === 'scout');
  const rows = chartRows(report);
  return <div style={{ display: 'grid', gap: 14 }}>
    <ScopeFilter value={filter} setValue={setFilter} />
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,190px),1fr))', gap: 10 }}>
      {filter !== 'scout' && live && <Tile label="Net live since window start" figure={live} />}
      {filter !== 'live' && scout && <Tile label="Scout htf-trend mean R" figure={scout.meanRPerTrade} />}
      {filter !== 'scout' && <Tile label={`P50 change by ${formatUtcDate(report.forecast.horizonEnd, 'legend')}`} figure={report.forecast.p50} />}
    </div>
    <section style={card}><h2 style={{ margin: '0 0 12px', fontSize: 15 }}>Cumulative net P&amp;L</h2>
      <Chart points={rows} horizonEnd={report.forecast.horizonEnd} markers={confirmed} filter={filter} />
      <div style={{ ...muted, display: 'flex', gap: 16, flexWrap: 'wrap' }}><span style={{ color: BLUE }}>Live, solid</span><span style={{ color: ORANGE }}>Scout, dashed</span><span>Forecast P5–P95, dashed P50 after today</span></div>
      {confirmed.length > 0 && <ol aria-label="Confirmed change marker legend" style={{ ...muted, listStyle: 'none', paddingLeft: 0 }}>{confirmed.map((marker, index) => <li key={marker.id} style={{ marginTop: 6 }}><span aria-label={`Marker ${index + 1}`} style={{ display: 'inline-block', minWidth: 23, textAlign: 'center', border: `1px solid ${GH.border}`, borderRadius: 4, color: GH.textBright, marginRight: 8 }}>{index + 1}</span>{marker.title} · {formatUtcDate(marker.at, 'legend')}{Date.parse(marker.at) < chartTimeAxis(rows, report.forecast.horizonEnd).domain[0] || Date.parse(marker.at) > chartTimeAxis(rows, report.forecast.horizonEnd).domain[1] ? ' (outside chart range)' : ''}</li>)}</ol>}
    </section>
  </div>;
}

function LaneCard({ lane }: { lane: LaneResult }) {
  const progress = lane.timeToVerdict.required > 0 ? Math.min(100, Math.max(0, lane.timeToVerdict.current / lane.timeToVerdict.required * 100)) : 100;
  const values = lane.series.map((point) => point.usd.value).filter((value): value is number => value !== null);
  const low = Math.min(...values);
  const high = Math.max(...values);
  const span = high - low || 1;
  const sparkPoints = values.map((value, index) => `${values.length === 1 ? 50 : index / (values.length - 1) * 100},${42 - (value - low) / span * 36}`).join(' ');
  return <article data-testid="lane-card" style={card}>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}><div style={{ minWidth: 0, overflowWrap: 'anywhere' }}><Tag kind={lane.kind} /> <strong title={lane.id} style={{ fontSize: 15, marginLeft: 8, overflowWrap: 'anywhere' }}>{lane.id}</strong></div><Verdict text={lane.verdict} /></div>
    {lane.persistedVerdict && lane.persistedVerdict.verdict !== lane.verdict && <p style={{ color: ORANGE, fontSize: 12 }}>Stale card: persisted {lane.persistedVerdict.verdict} at {formatUtcDate(lane.persistedVerdict.updatedAt, 'legend')}; current {lane.verdict}.</p>}
    {values.length ? <><svg role="img" aria-label={`${lane.id} cumulative net USD`} viewBox="0 0 100 48" preserveAspectRatio="none" style={{ display: 'block', width: '100%', height: 48, marginTop: 12 }}><polyline points={sparkPoints} fill="none" stroke={lane.kind === 'live' ? BLUE : ORANGE} strokeWidth="2" vectorEffect="non-scaling-stroke" /></svg><div style={{ ...muted, display: 'flex', justifyContent: 'space-between' }}><span>{formatFigure({ ...lane.netUsd, value: values[0]! })}</span><span>{formatFigure({ ...lane.netUsd, value: values.at(-1)! })}</span></div></> : <p style={muted}>No resolved trades yet</p>}
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(130px,1fr))', gap: 10, marginTop: 12 }}>
      <div style={{ minWidth: 0 }}><span style={muted}>Trades</span><div style={{ fontVariantNumeric: 'tabular-nums' }}>{lane.trades}</div></div><div style={{ minWidth: 0 }}><span style={muted}>Episodes</span><div style={{ fontVariantNumeric: 'tabular-nums' }}>{lane.episodes}</div></div>
      <div style={{ minWidth: 0 }}><span style={muted}>Net</span><div><FigureValue figure={lane.netUsd} countUnit="trade" /></div></div>
      <div style={{ minWidth: 0 }}><span style={muted}>Mean R per trade</span><div><FigureValue figure={lane.meanRPerTrade} countUnit="trade" /></div></div>
      <div style={{ minWidth: 0 }}><span style={muted}>Mean R per episode</span><div><FigureValue figure={lane.meanRPerEpisode} countUnit="episode" /></div></div>
    </div>
    <div style={{ marginTop: 14, ...muted }}>Verdict bar: {lane.timeToVerdict.current} of {lane.timeToVerdict.required} closes</div>
    <div role="progressbar" aria-label={`${lane.id} verdict progress`} aria-valuenow={lane.timeToVerdict.current} aria-valuemin={0} aria-valuemax={Math.max(lane.timeToVerdict.required, lane.timeToVerdict.current)} style={{ height: 7, borderRadius: 7, background: TERM.inset, marginTop: 7 }}><div style={{ height: '100%', width: `${progress}%`, borderRadius: 7, background: lane.kind === 'live' ? BLUE : ORANGE }} /></div>
    <p style={muted}>{lane.trades === 0 ? `No closes in the last 90 days (0 closes for ${lane.id})` : lane.timeToVerdict.eta ? `ETA ${lane.timeToVerdict.eta}` : lane.timeToVerdict.reason ?? 'Bar reached'}</p>
  </article>;
}

function Lanes({ report, filter, setFilter }: { report: LanePerformanceReport; filter: Filter; setFilter: (value: Filter) => void }) {
  return <div style={{ display: 'grid', gap: 14 }}><ScopeFilter value={filter} setValue={setFilter} />
    {['live', 'scout', ...new Set(report.lanes.map((lane) => lane.kind).filter((kind) => kind !== 'live' && kind !== 'scout'))].filter((kind) => (filter === 'all' || kind === filter) && report.lanes.some((lane) => lane.kind === kind)).map((kind) => <section key={kind}>
      <h2 style={{ color: kind === 'live' ? BLUE : ORANGE, fontSize: 15, textTransform: 'uppercase' }}>{kind} lanes</h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,330px),1fr))', gap: 12 }}>{report.lanes.filter((lane) => lane.kind === kind).map((lane) => <LaneCard key={lane.id} lane={lane} />)}</div>
    </section>)}
  </div>;
}

function Forecast({ report }: { report: LanePerformanceReport }) {
  const forecast = report.forecast;
  return <div style={{ display: 'grid', gap: 14 }}>
    <section style={card}><h2 style={{ marginTop: 0, fontSize: 15 }}>Forecast fan · {formatUtcDate(forecast.horizonEnd, 'legend')}</h2>
      {forecast.includedLanes.length === 0 ? <p>No active live lanes to forecast</p> : <Chart points={chartRows(report)} horizonEnd={forecast.horizonEnd} forecast start={Date.parse(report.overview.live.at(-1)?.at ?? report.generatedAt) - 7 * 86_400_000} />}
      <p style={muted}>{forecast.scope}</p><p style={muted}>{forecast.method.name}: {forecast.method.description}</p>
      <p style={muted}>Seed {forecast.seed} · inputs hash {forecast.inputsHash}</p>
    </section>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,190px),1fr))', gap: 10 }}>
      <Tile label="P(net > 0)" figure={forecast.pPositive} /><Tile label="Expected monthly" figure={forecast.expectedMonthly} />
      <Tile label="Realised monthly" figure={forecast.realisedMonthly} /><Tile label="P95 30-day drawdown" figure={forecast.p95Drawdown30d} loss />
    </div>
    <section style={card}><h2 style={{ marginTop: 0, fontSize: 15 }}>Time to verdict</h2><ul style={{ paddingLeft: 20, marginBottom: 0 }}>{report.lanes.map((lane) => <li key={lane.id} style={{ marginBottom: 9 }}><Tag kind={lane.kind} /> {lane.id}: {lane.timeToVerdict.current}/{lane.timeToVerdict.required}, {lane.timeToVerdict.eta ?? lane.timeToVerdict.reason ?? 'bar reached'}</li>)}</ul></section>
    <section style={card}><h2 style={{ marginTop: 0, fontSize: 15 }}>Frozen forecasts</h2>
      {report.snapshots.length === 0 ? <p>No frozen forecasts yet (the retro freezes one monthly)</p> : <div style={{ overflowX: 'auto' }}><table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}><thead><tr>{['Made', 'Horizon', 'P50', 'Actual', 'In band?'].map((label) => <th key={label} style={{ textAlign: 'left', padding: 8 }}>{label}</th>)}</tr></thead><tbody>{report.snapshots.map((snapshot) => <tr key={snapshot.id}><td style={{ padding: 8 }}>{formatUtcDate(snapshot.made_at, 'legend')}</td><td>{formatUtcDate(snapshot.horizon_end, 'legend')}</td><td><FigureValue figure={snapshot.p50} /></td><td><FigureValue figure={snapshot.actual} /></td><td>{snapshot.actual.value === null ? 'Pending' : snapshot.p5.value !== null && snapshot.p95.value !== null && snapshot.actual.value >= snapshot.p5.value && snapshot.actual.value <= snapshot.p95.value ? 'Yes' : 'No'}</td></tr>)}</tbody></table></div>}
    </section>
  </div>;
}

function Changes({ report, onConfirmed }: { report: LanePerformanceReport; onConfirmed: (id: string) => void }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<string | null>(null);
  const grouped = groupMarkers(report.markers);
  async function confirm(marker: MarkerInput) {
    setPending(marker.id);
    setErrors((previous) => ({ ...previous, [marker.id]: '' }));
    try {
      const response = await fetch('/api/cockpit/lane-performance/markers/confirm', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: marker.id }) });
      if (!response.ok) {
        let detail: string | null = null;
        try {
          const body = await response.json() as { error?: unknown };
          if (typeof body.error === 'string') detail = body.error;
        } catch { /* A failed request can have an empty or non-JSON body. */ }
        throw new Error(detail ?? `Confirmation failed (${response.status})`);
      }
      const result = await response.json() as { ok: boolean };
      if (!result.ok) throw new Error('Confirmation failed');
      onConfirmed(marker.id);
    } catch (error) {
      setErrors((previous) => ({ ...previous, [marker.id]: error instanceof Error ? error.message : 'Confirmation failed' }));
    } finally { setPending(null); }
  }
  if (report.markers.length === 0) return <div style={card}>{report.notes.some((note) => note.includes('0046')) ? 'Markers need migration 0046' : 'No change markers yet'}</div>;
  return <div style={{ display: 'grid', gap: 12 }}>{[...grouped.confirmed, ...grouped.proposed].map((marker) => <article key={marker.id} data-testid="marker-row" style={card}>
    <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}><button type="button" aria-expanded={selected === marker.id} onClick={() => setSelected(selected === marker.id ? null : marker.id)} style={button}>{marker.title}</button><span style={muted}>{formatUtcDate(marker.at, 'legend')} · {marker.kind}</span><span>{marker.confirmed_at ? 'Confirmed' : 'Proposed'}</span>
      {!marker.confirmed_at && <button type="button" disabled={pending === marker.id} onClick={() => void confirm(marker)} style={button}>{pending === marker.id ? 'Confirming…' : 'Confirm'}</button>}
    </div>
    {errors[marker.id] && <p role="alert" style={{ color: '#ff8793' }}>{errors[marker.id]}</p>}
    {selected === marker.id && <div style={{ marginTop: 12 }}><p style={muted}>{marker.note}</p>{report.lanes.flatMap((lane) => lane.markerSplits.filter((split) => split.markerId === marker.id).map((split) => <div key={`${lane.id}-${split.markerId}`} style={{ padding: 8, borderTop: `1px solid ${GH.border}` }}><Tag kind={lane.kind} /> {lane.id}: before <FigureValue figure={split.before.usd} /> · <FigureValue figure={split.before.meanR} />; after <FigureValue figure={split.after.usd} /> · <FigureValue figure={split.after.meanR} /></div>))}</div>}
  </article>)}</div>;
}

export interface LanePerformanceViewProps { reportOverride?: LanePerformanceReport | null }

export default function LanePerformanceView({ reportOverride }: LanePerformanceViewProps) {
  const state = useLanePerformance(60_000, reportOverride === undefined);
  const [view, setView] = useUrlParamState<Subview>('lanesView', 'overview', VIEWS);
  const [filter, setFilter] = useState<Filter>('all');
  const [notesOpen, setNotesOpen] = useState(false);
  const [overrideConfirmed, setOverrideConfirmed] = useState<Record<string, string>>({});
  const sourceReport = reportOverride === undefined ? state.data : reportOverride;
  const report = sourceReport && reportOverride !== undefined ? { ...sourceReport, markers: sourceReport.markers.map((marker) => overrideConfirmed[marker.id] && !marker.confirmed_at ? { ...marker, confirmed_at: overrideConfirmed[marker.id]! } : marker) } : sourceReport;
  const skew = reportOverride === undefined && (state.status === 404 || state.status === 422) || Boolean(report && report.schemaVersion !== 1);
  const unauthorised = reportOverride === undefined && state.status === 401;
  const loading = reportOverride === undefined && !report && !state.error && !skew && !unauthorised;
  const onConfirmed = (id: string) => {
    if (reportOverride !== undefined) setOverrideConfirmed((current) => ({ ...current, [id]: new Date().toISOString() }));
    else state.confirmMarker(id);
  };
  return <section data-testid="lanes-view" style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', padding: 14, color: GH.textBright, background: GH.bg, fontSize: 13 }}>
    <div style={{ maxWidth: 1320, margin: '0 auto', display: 'grid', gap: 14, minWidth: 0 }}>
      <h1 style={{ fontSize: 20, margin: 0 }}>Lanes</h1>
      {skew ? <div data-testid="lanes-skew" role="alert" style={card}>{state.status === 404 ? 'The server predates this view. Redeploy or restart it.' : 'The server and view use different report schemas. Redeploy or restart it.'}</div> : loading ? <div role="status" style={card}>Loading lane report…</div> : <>
        {unauthorised ? <div role="alert">Sign in again</div> : <>
          {state.error && reportOverride === undefined && <div data-testid="lanes-error" role="alert" style={{ ...card, borderColor: '#ff8793' }}>{state.error} <button type="button" onClick={state.retry} style={button}>Retry</button></div>}
          {state.isStale && report && reportOverride === undefined && <div role="status" style={muted}>Stale report from {formatUtcTimestamp(report.generatedAt)}</div>}
          {report && <>
            {report.notes.length > 0 && <div style={{ ...card, color: GH.textMuted }}><button type="button" aria-expanded={notesOpen} onClick={() => setNotesOpen((open) => !open)} style={button}>{report.notes.length} {report.notes.length === 1 ? 'note' : 'notes'}</button>{notesOpen && <div style={{ display: 'grid', gap: 6, marginTop: 8 }}>{report.notes.map((note, index) => <div role="note" key={`${index}-${note}`} title={note}>{formatNote(note)}</div>)}</div>}</div>}
            <nav aria-label="Lanes subviews" style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>{VIEWS.map((key) => <button key={key} type="button" aria-pressed={view === key} onClick={() => setView(key)} style={{ ...button, ...(view === key ? selectedButton : {}) }}>{key === 'changes' ? 'Change log' : key[0].toUpperCase() + key.slice(1)}</button>)}</nav>
            {view === 'overview' && <Overview report={report} filter={filter} setFilter={setFilter} />}
            {view === 'lanes' && <Lanes report={report} filter={filter} setFilter={setFilter} />}
            {view === 'forecast' && <Forecast report={report} />}
            {view === 'changes' && <Changes report={report} onConfirmed={onConfirmed} />}
          </>}
        </>}
      </>}
    </div>
  </section>;
}
