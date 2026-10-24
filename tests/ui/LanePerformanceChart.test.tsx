import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import LanePerformanceView, { chartRows } from '@/app/cockpit/components/lanes-performance/LanePerformanceView';
import { lanePerformanceReportFixture } from '../fixtures/lane-performance-report.fixture';

vi.mock('@/hooks/useLanePerformance', () => ({ useLanePerformance: () => ({ data: null, error: null, isStale: false, status: null, retry: vi.fn() }) }));
vi.mock('recharts', () => {
  const Container = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
  return {
    ResponsiveContainer: Container, AreaChart: Container,
    CartesianGrid: () => null, YAxis: () => null, Tooltip: () => null,
    XAxis: ({ dataKey, type, scale, domain }: { dataKey: string; type: string; scale: string; domain: [number, number] }) =>
      <div data-testid="time-axis" data-key={dataKey} data-type={type} data-scale={scale} data-domain={domain.join(',')} />,
    ReferenceLine: ({ x }: { x: number }) => <div data-testid="change-line" data-x={x} />,
    Area: ({ dataKey, fill, strokeDasharray, isAnimationActive }: { dataKey: string; fill?: string; strokeDasharray?: string; isAnimationActive?: boolean }) =>
      <div data-testid={`area-${dataKey}`} data-fill={fill} data-dash={strokeDasharray} data-animated={String(isAnimationActive)} />,
  };
});

describe('Lanes chart time coordinates', () => {
  it('puts a confirmed marker between its neighbouring live points on the numeric axis', () => {
    render(<LanePerformanceView reportOverride={lanePerformanceReportFixture} />);
    const axis = screen.getByTestId('time-axis');
    expect(axis.getAttribute('data-key')).toBe('epoch');
    expect(axis.getAttribute('data-type')).toBe('number');
    expect(axis.getAttribute('data-scale')).toBe('linear');
    const [min, max] = axis.getAttribute('data-domain')!.split(',').map(Number);
    const marker = Number(screen.getAllByTestId('change-line')[0]!.getAttribute('data-x'));
    const history = chartRows(lanePerformanceReportFixture).filter((row) => row.live !== undefined);
    const before = history.filter((row) => row.epoch < marker).at(-1)!.epoch;
    const after = history.find((row) => row.epoch > marker)!.epoch;
    const x = (epoch: number) => (epoch - min) / (max - min);
    expect(x(before)).toBeLessThan(x(marker));
    expect(x(marker)).toBeLessThan(x(after));
    expect(screen.getByTestId('area-band').getAttribute('data-fill')).toBe('rgba(117,160,255,.38)');
    expect(screen.getByTestId('area-p50').getAttribute('data-dash')).toBe('5 4');
    expect(screen.getByTestId('area-scout').getAttribute('data-dash')).toBe('7 4');
    expect(screen.getAllByTestId(/^area-/).every((area) => area.getAttribute('data-animated') === 'false')).toBe(true);
  });
});
