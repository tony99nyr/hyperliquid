/** A short, quotable view of the full structured lane report. */
import type { Figure, LanePerformanceReport } from './lane-performance-business-logic';

const cell = (value: string): string => value.replaceAll('|', '\\|').replaceAll('\n', ' ');
const number = (value: number | null, digits = 2): string => value == null ? 'n/a' : value.toFixed(digits);
const money = (value: number | null): string => value == null ? 'n/a' : `$${number(value)}`;
const mean = (figure: Figure): string => figure.value == null ? 'n/a' :
  `${figure.value >= 0 ? '+' : ''}${number(figure.value)} ${figure.unit}`;
const row = (values: string[]): string => `| ${values.map(cell).join(' | ')} |`;

function realisedLiveMonthly90d(report: LanePerformanceReport): number {
  const since = Date.parse(report.generatedAt) - 90 * 86_400_000;
  let previous = 0;
  let net = 0;
  for (const point of report.overview.live) {
    const cumulative = point.usd.value ?? previous;
    if (Date.parse(point.at) >= since && Date.parse(point.at) <= Date.parse(report.generatedAt)) net += cumulative - previous;
    previous = cumulative;
  }
  return net / 3;
}

export function renderLanePerformanceMarkdown(report: LanePerformanceReport): string {
  const lines = [
    '# Lane performance report',
    `Generated: ${report.generatedAt} | Notes: ${report.notes.length ? report.notes.join('; ') : 'none'}`,
    '',
    '## Lanes',
    row(['lane', 'kind', 'verdict', 'persisted verdict (updated at)', 'n trades', 'n episodes', 'net $', 'mean R per trade (unit)', 'progress to bar', 'ETA']),
    row(Array(10).fill('---')),
  ];
  for (const lane of report.lanes) {
    const eta = lane.timeToVerdict.eta ?? lane.timeToVerdict.reason ?? 'n/a';
    lines.push(row([lane.id, lane.kind, lane.verdict,
      lane.persistedVerdict ? `${lane.persistedVerdict.verdict} (${lane.persistedVerdict.updatedAt})` : 'n/a',
      String(lane.trades), String(lane.episodes),
      money(lane.netUsd.value), mean(lane.meanRPerTrade),
      lane.bar.source === 'unregistered' ? 'unregistered' : `${lane.timeToVerdict.current}/${lane.timeToVerdict.required}`, eta]));
  }
  lines.push(`Per-episode mean R: ${report.lanes.length ? report.lanes.map((lane) =>
    `${lane.id} ${mean(lane.meanRPerEpisode)} (n=${lane.meanRPerEpisode.n})`).join('; ') : 'n/a'}`);
  lines.push('', '## Markers',
    row(['status', 'marker', 'lane', 'before (net $, mean R per episode)', 'after (net $, mean R per episode)']),
    row(Array(5).fill('---')));
  const ordered = [...report.markers].sort((a, b) => Number(b.confirmed_at != null) - Number(a.confirmed_at != null) || a.at.localeCompare(b.at));
  for (const marker of ordered) {
    const affected = marker.lanes.length ? marker.lanes : report.lanes.map((lane) => lane.id);
    for (const id of affected) {
      const lane = report.lanes.find((item) => item.id === id);
      const split = lane?.markerSplits.find((item) => item.markerId === marker.id);
      const summary = (side: { usd: Figure; meanR: Figure } | undefined): string => side
        ? `${money(side.usd.value)}, ${mean(side.meanR)} (n=${side.usd.n})` : 'pending confirmation';
      lines.push(row([marker.confirmed_at ? 'confirmed' : 'proposed', marker.title, id,
        summary(split?.before), summary(split?.after)]));
    }
  }
  const f = report.forecast;
  lines.push('', '## Forecast',
    `Horizon: ${f.horizonEnd} | Scope: ${f.scope}`,
    `P5 / P50 / P95: ${money(f.p5.value)} / ${money(f.p50.value)} / ${money(f.p95.value)}`,
    `P(net>0): ${f.pPositive.value == null ? 'n/a' : `${number(f.pPositive.value * 100, 1)}%`} | Expected monthly: ${money(f.expectedMonthly.value)} | Realised live net/month (last 90d): ${money(realisedLiveMonthly90d(report))} | P95 30-day drawdown: ${money(f.p95Drawdown30d.value)}`,
    `Method: ${f.method.description} seed ${f.seed}; inputs hash ${f.inputsHash}.`,
  );
  return lines.join('\n');
}
