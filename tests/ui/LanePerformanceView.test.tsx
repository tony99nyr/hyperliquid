import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import LanePerformanceView, { chartRows, chartTimeAxis } from '@/app/cockpit/components/lanes-performance/LanePerformanceView';
import { useLanePerformance } from '@/hooks/useLanePerformance';
import type { LanePerformanceReport, LaneResult, MarkerInput } from '@/lib/performance/lane-performance-business-logic';
import { lanePerformanceReportFixture } from '../fixtures/lane-performance-report.fixture';

vi.mock('@/hooks/useLanePerformance', () => ({ useLanePerformance: vi.fn() }));

const fig = (value: number | null, unit: 'usd' | 'r' | 'r_slip' | 'r_nominal' | 'probability' | 'per_day' | 'days' = 'usd') => ({ value, n: 1, unit, source: 'test' });
function lane(id: string, kind: 'live' | 'scout', verdict: string, persistedVerdict: LaneResult['persistedVerdict'] = null): LaneResult {
  return {
    id, kind, verdict, persistedVerdict,
    bar: { minCloses: 8, minMeanR: 0, killMeanR: null, killAfterCloses: null, slowBleedDays: null, slowBleedMinCloses: null, source: 'test' },
    trades: 3, episodes: 2, signalRatePerDay: fig(.02, 'per_day'), plannedRiskUsd: fig(20),
    netUsd: fig(42), netR: fig(.5, 'r'), netSlipR: fig(.5, 'r_slip'), netNominalR: fig(.4, 'r_nominal'),
    meanRPerTrade: fig(.25, kind === 'live' ? 'r_slip' : 'r'), meanRPerEpisode: fig(.4, kind === 'live' ? 'r_slip' : 'r'),
    timeToVerdict: { current: 3, required: 8, remaining: 5, ratePerDay: fig(.03, 'per_day'), eta: null, reason: 'Need more closes' },
    series: [], markerSplits: [],
  };
}

const markers: MarkerInput[] = [
  { id: 'm1', at: '2026-10-01', kind: 'process', lanes: ['breakout'], title: 'Confirmed gate change', note: 'Adjusted entry gate', source: 'manual', ref: null, proposed_by: 'operator', confirmed_by: 'operator', confirmed_at: '2026-10-02', created_at: '2026-10-01' },
  { id: 'm2', at: '2026-10-03', kind: 'process', lanes: [], title: 'Proposed risk change', note: 'Review risk cap', source: 'manual', ref: null, proposed_by: 'operator', confirmed_by: null, confirmed_at: null, created_at: '2026-10-03' },
];

function report(): LanePerformanceReport {
  const live = lane('breakout', 'live', 'COLLECT');
  const scout = lane('directional', 'scout', 'KILL', { verdict: 'CONTINUE', updatedAt: '2026-10-20T12:00:00Z' });
  return {
    schemaVersion: 1, generatedAt: '2026-10-24T12:00:00Z', lanes: [live, scout], markers,
    overview: { live: [{ at: '2026-10-24', usd: fig(42), r: fig(null, 'r'), slipR: fig(.5, 'r_slip'), nominalR: fig(.4, 'r_nominal') }], scout: [] },
    forecast: {
      horizonEnd: '2026-11-30', includedLanes: [], excludedLanes: [], scope: 'Current live lanes',
      method: { name: 'Monte Carlo', description: 'Resample observed episodes.' }, seed: 1, inputsHash: 'abc',
      p5: fig(-10), p25: fig(0), p50: fig(15), p75: fig(30), p95: fig(50), pPositive: fig(.7, 'probability'),
      expectedMonthly: fig(20), realisedMonthly: fig(10), p95Drawdown30d: fig(12), fan: [],
    },
    snapshots: [], notes: [],
  } as unknown as LanePerformanceReport;
}

const mockHook = vi.mocked(useLanePerformance);
function hookState(overrides: Partial<ReturnType<typeof useLanePerformance>> = {}) {
  return { data: null, lastGood: null, error: null, isStale: false, status: null, retry: vi.fn(), confirmMarker: vi.fn(), ...overrides };
}

describe('LanePerformanceView', () => {
  beforeEach(() => { window.history.replaceState({}, '', '/cockpit?lanesView=overview'); vi.clearAllMocks(); mockHook.mockReturnValue(hookState()); });
  afterEach(() => vi.unstubAllGlobals());

  it('renders lane cards, verdicts, units, stale persisted verdict and the marker legend', () => {
    render(<LanePerformanceView reportOverride={report()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Lanes' }));
    expect(screen.getAllByTestId('lane-card')).toHaveLength(2);
    expect(within(screen.getAllByTestId('lane-card')[1]!).getByText('KILL')).toBeTruthy();
    expect(screen.getByText('COLLECT')).toBeTruthy();
    expect(screen.getByText(/Stale card: persisted CONTINUE/)).toBeTruthy();
    expect(screen.getAllByText(/R slip/).length).toBeGreaterThan(0);
    expect(screen.getAllByText('No resolved trades yet')).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: 'Overview' }));
    expect(screen.getByLabelText('Confirmed change marker legend').textContent).toContain('Confirmed gate change');
    expect(screen.getByLabelText('Marker 1').textContent).toBe('1');
    expect(screen.getByText(/Forecast P5–P95/)).toBeTruthy();
  });

  it('switches the lane cards with the Live and Scout filters', () => {
    render(<LanePerformanceView reportOverride={report()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Lanes' }));
    fireEvent.click(screen.getByRole('button', { name: 'Live' }));
    expect(screen.getAllByTestId('lane-card')).toHaveLength(1);
    expect(screen.getByText('breakout')).toBeTruthy();
    expect(screen.queryByText('directional')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Scout' }));
    expect(screen.getAllByTestId('lane-card')).toHaveLength(1);
    expect(screen.getByText('directional')).toBeTruthy();
    expect(screen.queryByText('breakout')).toBeNull();
  });

  it('renders forecast and change log subviews, including empty snapshots', () => {
    render(<LanePerformanceView reportOverride={report()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Forecast' }));
    expect(screen.getByText('No frozen forecasts yet (the retro freezes one monthly)')).toBeTruthy();
    expect(screen.getByText('No active live lanes to forecast')).toBeTruthy();
    expect(screen.getByText(/Monte Carlo/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Change log' }));
    expect(screen.getAllByTestId('marker-row')).toHaveLength(2);
    expect(screen.getByText('Proposed risk change')).toBeTruthy();
  });

  it('confirms a proposed marker and displays a server error without changing its state', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal('fetch', fetchMock);
    const { unmount } = render(<LanePerformanceView reportOverride={report()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Change log' }));
    const confirm = screen.getAllByRole('button', { name: 'Confirm' })[0];
    fireEvent.click(confirm);
    await waitFor(() => expect(screen.getByText('Confirmed')).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledWith('/api/cockpit/lane-performance/markers/confirm', expect.objectContaining({ method: 'POST' }));

    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 });
    unmount();
    render(<LanePerformanceView reportOverride={report()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Change log' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Confirmation failed (500)');
    expect(screen.getAllByText('Proposed').length).toBeGreaterThan(0);
  });

  it('shows the POST 500 message inside the proposed marker row', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({ ok: false, error: 'Marker write failed' }) }));
    render(<LanePerformanceView reportOverride={report()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Change log' }));
    const row = screen.getByText('Proposed risk change').closest('[data-testid="marker-row"]');
    expect(row).not.toBeNull();
    fireEvent.click(row!.querySelector('button:last-of-type')!);
    await waitFor(() => expect(row!.querySelector('[role="alert"]')?.textContent).toContain('Marker write failed'));
    expect(row!.textContent).toContain('Proposed');
    expect(row!.textContent).not.toContain('Confirmed');
  });

  it('gives selected subviews and filters a distinct border and pressed state', () => {
    render(<LanePerformanceView reportOverride={report()} />);
    const overview = screen.getByRole('button', { name: 'Overview' });
    const lanes = screen.getByRole('button', { name: 'Lanes' });
    expect(overview.getAttribute('aria-pressed')).toBe('true');
    expect(lanes.getAttribute('aria-pressed')).toBe('false');
    expect(overview.style.borderColor).not.toBe(lanes.style.borderColor);
    fireEvent.click(lanes);
    expect(lanes.getAttribute('aria-pressed')).toBe('true');
    expect(lanes.style.borderColor).not.toBe(overview.style.borderColor);
    const all = screen.getByRole('button', { name: 'All' });
    const live = screen.getByRole('button', { name: 'Live' });
    expect(all.getAttribute('aria-pressed')).toBe('true');
    expect(all.style.borderColor).not.toBe(live.style.borderColor);
    fireEvent.click(live);
    expect(live.getAttribute('aria-pressed')).toBe('true');
    expect(live.style.borderColor).not.toBe(all.style.borderColor);
  });

  it('reserves a full width 48px sparkline or shows the empty series message', () => {
    const populated = lane('populated', 'live', 'CONTINUE');
    populated.series = [{ at: '2026-10-24T12:00:00Z', usd: fig(12), r: fig(.2, 'r'), slipR: fig(.2, 'r_slip'), nominalR: fig(.2, 'r_nominal') }];
    render(<LanePerformanceView reportOverride={{ ...report(), lanes: [populated, lane('empty', 'scout', 'COLLECT')] }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Lanes' }));
    const sparkline = screen.getByRole('img', { name: 'populated cumulative net USD' });
    expect(sparkline.style.width).toBe('100%');
    expect(sparkline.style.height).toBe('48px');
    expect(screen.getByText('No resolved trades yet')).toBeTruthy();
  });

  it('uses readable UTC dates in chart and marker labels', () => {
    render(<LanePerformanceView reportOverride={report()} />);
    const legend = screen.getByLabelText('Confirmed change marker legend');
    expect(legend.textContent).toContain('1 Oct 2026');
    expect(legend.textContent).not.toContain('T12:00:00');
  });

  it('renders the synthetic report with all verdicts, R units and an empty lane series', () => {
    render(<LanePerformanceView reportOverride={lanePerformanceReportFixture} />);
    fireEvent.click(screen.getByRole('button', { name: 'Lanes' }));
    expect(screen.getAllByTestId('lane-card')).toHaveLength(10);
    for (const verdict of ['KILL', 'CONTINUE', 'COLLECT', 'HOLD', 'UNREGISTERED']) {
      expect(screen.getAllByText(verdict).length).toBeGreaterThan(0);
    }
    expect(screen.getByText('No resolved trades yet')).toBeTruthy();
    expect(screen.getAllByText(/R slip/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Overview' }));
    expect(screen.getByLabelText('Confirmed change marker legend').textContent).toContain('9 Sept 2026');
  });

  it('feeds a 30-day P5 to P95 cone after today into the overview chart', () => {
    const rows = chartRows(lanePerformanceReportFixture);
    const today = Date.parse(lanePerformanceReportFixture.generatedAt);
    const futureBand = rows.filter((row) => row.epoch > today && row.band);
    expect(futureBand.length).toBeGreaterThanOrEqual(30);
    expect(futureBand.every((row) => row.band![0] < row.band![1] && row.p50! > row.band![0] && row.p50! < row.band![1])).toBe(true);
  });

  it('uses ordered, unique time ticks and places markers between neighbouring history points', () => {
    const rows = chartRows(lanePerformanceReportFixture);
    const { domain, ticks } = chartTimeAxis(rows, lanePerformanceReportFixture.forecast.horizonEnd);
    const labels = ticks.map((tick) => new Date(tick).toISOString().slice(0, 10));
    expect(new Set(labels).size).toBe(labels.length);
    expect(ticks).toEqual([...ticks].sort((a, b) => a - b));
    expect(domain[0]).toBeLessThanOrEqual(Date.parse(lanePerformanceReportFixture.overview.live[0]!.at));
    expect(domain[1]).toBeGreaterThanOrEqual(Date.parse(lanePerformanceReportFixture.forecast.horizonEnd));
    const marker = Date.parse(lanePerformanceReportFixture.markers[0]!.at);
    const before = rows.filter((row) => row.live !== undefined && row.epoch < marker).at(-1)!;
    const after = rows.find((row) => row.live !== undefined && row.epoch > marker)!;
    expect(before.epoch).toBeLessThan(marker);
    expect(marker).toBeLessThan(after.epoch);
  });

  it('anchors the incremental forecast at the last live cumulative value', () => {
    const rows = chartRows(lanePerformanceReportFixture);
    const lastLive = lanePerformanceReportFixture.overview.live.at(-1)!;
    const anchor = rows.find((row) => row.epoch === Date.parse(lastLive.at))!;
    expect(anchor.p5).toBe(lastLive.usd.value);
    expect(anchor.p50).toBe(lastLive.usd.value);
    expect(anchor.p95).toBe(lastLive.usd.value);
    expect(anchor.band).toEqual([lastLive.usd.value, lastLive.usd.value]);
    const firstForecast = rows.find((row) => row.at === lanePerformanceReportFixture.forecast.fan[0]!.at)!;
    expect(firstForecast.p50).toBe(lastLive.usd.value! + lanePerformanceReportFixture.forecast.fan[0]!.p50.value!);
  });

  it('shows compatibility banners for a missing endpoint and a schema version mismatch', () => {
    mockHook.mockReturnValue(hookState({ status: 404, error: 'request failed (404)' }));
    render(<LanePerformanceView />);
    expect(screen.getByTestId('lanes-skew')).toBeTruthy();

    const skewed = { ...report(), schemaVersion: 2 } as unknown as LanePerformanceReport;
    render(<LanePerformanceView reportOverride={skewed} />);
    expect(screen.getAllByTestId('lanes-skew')).toHaveLength(2);
  });

  it('keeps the last good report visible after a network error and retries on request', () => {
    const retry = vi.fn();
    mockHook.mockReturnValue(hookState({ data: report(), lastGood: report(), isStale: true, status: 0, error: 'Network unavailable', retry }));
    render(<LanePerformanceView />);
    expect(screen.getByText('Stale report from 24 Oct 2026, 12:00 UTC')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('Network unavailable');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it('shows GET 500 in an error strip with Retry and the stale report', () => {
    const retry = vi.fn();
    mockHook.mockReturnValue(hookState({ data: report(), lastGood: report(), isStale: true, status: 500, error: 'Ledger unavailable', retry }));
    render(<LanePerformanceView />);
    expect(screen.queryByTestId('lanes-skew')).toBeNull();
    expect(screen.getByTestId('lanes-error').textContent).toContain('Ledger unavailable');
    expect(screen.getByText('Stale report from 24 Oct 2026, 12:00 UTC')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Overview' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it('shows the migration notice when marker storage is absent', () => {
    render(<LanePerformanceView reportOverride={{ ...report(), markers: [], notes: ['apply migration 0046'] }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Change log' }));
    expect(screen.getByText('Markers need migration 0046')).toBeTruthy();
  });

  it('shows loading without skew before the first response', () => {
    render(<LanePerformanceView />);
    expect(screen.getByText('Loading lane report…')).toBeTruthy();
    expect(screen.queryByTestId('lanes-skew')).toBeNull();
  });

  it.each([
    [401, 'Sign in again'], [500, 'Server unavailable'], [0, 'Network unavailable'],
  ])('shows first-load error %i without skew', (status, error) => {
    mockHook.mockReturnValue(hookState({ status, error }));
    render(<LanePerformanceView />);
    expect(screen.queryByTestId('lanes-skew')).toBeNull();
    expect(screen.getByRole('alert').textContent).toContain(error);
    if (status !== 401) expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('collapses notes and formats timestamps for display', () => {
    render(<LanePerformanceView reportOverride={{ ...report(), notes: ['First', 'Second 2026-10-24T12:00:00Z', 'Third'] }} />);
    const notes = screen.getByRole('button', { name: '3 notes' });
    expect(notes.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('First')).toBeNull();
    fireEvent.click(notes);
    expect(notes.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Second 24 Oct 2026, 12:00 UTC').getAttribute('title')).toBe('Second 2026-10-24T12:00:00Z');
  });

  it('filters overview tiles and labels the forecast as a change', () => {
    render(<LanePerformanceView reportOverride={report()} />);
    expect(screen.getByText(/P50 change by/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Scout' }));
    expect(screen.queryByText('Net live since window start')).toBeNull();
    expect(screen.queryByText(/P50 change by/)).toBeNull();
  });

  it('keeps out-of-range markers in the legend but off the chart', () => {
    const outside = { ...markers[0]!, id: 'old', at: '2020-01-01' };
    const future = { ...markers[0]!, id: 'future', at: '2031-01-01' };
    const fixture = { ...lanePerformanceReportFixture, markers: [...lanePerformanceReportFixture.markers, outside, future] };
    const rows = chartRows(fixture);
    expect(rows.some((row) => row.epoch === Date.parse(outside.at))).toBe(false);
    render(<LanePerformanceView reportOverride={fixture} />);
    expect(screen.getByLabelText('Confirmed change marker legend').textContent?.match(/outside chart range/g)).toHaveLength(2);
  });

  it('starts the forecast axis seven days before the live anchor', () => {
    const rows = chartRows(lanePerformanceReportFixture);
    const anchor = Date.parse(lanePerformanceReportFixture.overview.live.at(-1)!.at);
    expect(chartTimeAxis(rows, lanePerformanceReportFixture.forecast.horizonEnd, anchor - 7 * 86_400_000).domain[0]).toBe(anchor - 7 * 86_400_000);
  });

  it('renders unknown unit and kind, and a populated forecast', () => {
    const unknown = { ...lane('odd', 'live', 'HOLD'), kind: 'new-kind', netUsd: { ...fig(7), unit: 'new-unit' } } as unknown as LaneResult;
    const fixture = { ...lanePerformanceReportFixture, lanes: [unknown, ...lanePerformanceReportFixture.lanes] };
    render(<LanePerformanceView reportOverride={fixture} />);
    fireEvent.click(screen.getByRole('button', { name: 'Lanes' }));
    expect(screen.getByText('new-kind')).toBeTruthy();
    expect(screen.getByText('7')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Forecast' }));
    expect(screen.getByRole('img', { name: /Forecast fan/ })).toBeTruthy();
  });

  it('shows drawdown as a loss, count units, and sparkline endpoints', () => {
    const fixture = { ...lanePerformanceReportFixture, forecast: { ...lanePerformanceReportFixture.forecast, p95Drawdown30d: fig(.1) } };
    render(<LanePerformanceView reportOverride={fixture} />);
    fireEvent.click(screen.getByRole('button', { name: 'Forecast' }));
    expect(screen.getByText(/-\$0\.10/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Lanes' }));
    const first = screen.getAllByTestId('lane-card')[0]!;
    expect(first.textContent).toContain('n=8 trades');
    expect(first.textContent).toContain('n=8 episodes');
    expect(first.textContent).toContain('Verdict bar: 36 of 12 closes');
    expect(first.querySelector('svg + div')?.children).toHaveLength(2);
  });

  it('uses the singular episode count and names a zero-close lane', () => {
    const empty = lane('zero-close', 'scout', 'COLLECT');
    empty.trades = 0;
    empty.meanRPerEpisode = { ...empty.meanRPerEpisode, n: 1 };
    render(<LanePerformanceView reportOverride={{ ...report(), lanes: [empty] }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Lanes' }));
    const card = screen.getByTestId('lane-card');
    expect(card.textContent).toContain('n=1 episode');
    expect(card.textContent).toContain('0 closes for zero-close');
  });

  it('keeps a confirmed marker across subview switches with an override', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) }));
    render(<LanePerformanceView reportOverride={report()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Change log' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(screen.getAllByText('Confirmed')).toHaveLength(2));
    fireEvent.click(screen.getByRole('button', { name: 'Overview' }));
    expect(screen.getByLabelText('Confirmed change marker legend').textContent).toContain('Proposed risk change');
    fireEvent.click(screen.getByRole('button', { name: 'Change log' }));
    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
  });
});
