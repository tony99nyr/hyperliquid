import type { Figure, MarkerInput } from '@/lib/performance/lane-performance-business-logic';

export function formatUtcDate(value: string | number, length: 'tick' | 'legend'): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric', month: 'short', ...(length === 'legend' ? { year: 'numeric' } : {}), timeZone: 'UTC',
  }).format(date);
}

export function formatUtcTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${new Intl.DateTimeFormat('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
    hourCycle: 'h23', timeZone: 'UTC',
  }).format(date)} UTC`;
}

export function formatFigure(figure: Figure): string {
  if (figure.value === null) return '—';
  const value = figure.value;
  switch (figure.unit) {
    case 'usd': return `${value >= 0 ? '+' : '-'}$${Math.abs(value) >= 1_000_000 ? `${(Math.abs(value) / 1_000_000).toFixed(2)}m` : Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    case 'r': case 'r_slip': case 'r_nominal': return `${value >= 0 ? '+' : ''}${value.toFixed(2)}R`;
    case 'probability': return `${(value * 100).toFixed(0)}%`;
    case 'per_day': case 'days': return value.toLocaleString('en-US', { maximumFractionDigits: 2 });
    default: return String(value);
  }
}

export function formatLoss(figure: Figure): string {
  if (figure.value === null || figure.unit !== 'usd') return formatFigure(figure);
  return `-$${Math.abs(figure.value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatNote(note: string): string {
  return note.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/g, (value) => formatUtcTimestamp(value));
}

export function unitTag(unit: Figure['unit']): string {
  switch (unit) {
    case 'r': return 'R';
    case 'r_slip': return 'R slip';
    case 'r_nominal': return 'R nominal';
    default: return unit;
  }
}

export function verdictChip(verdict: string): { colour: string; background: string } {
  switch (verdict.toUpperCase()) {
    case 'KILL': return { colour: '#ff8793', background: 'rgba(242,77,94,.16)' };
    case 'SIZE-UP': case 'GRADUATE': return { colour: '#69dfad', background: 'rgba(25,201,138,.16)' };
    case 'COLLECT': return { colour: '#91adff', background: 'rgba(91,140,255,.16)' };
    case 'UNREGISTERED': return { colour: '#aab2c0', background: 'rgba(139,149,166,.14)' };
    default: return { colour: '#d6dce6', background: 'rgba(205,212,224,.12)' };
  }
}

export function groupMarkers(markers: MarkerInput[]): { confirmed: MarkerInput[]; proposed: MarkerInput[] } {
  return {
    confirmed: markers.filter((marker) => marker.confirmed_at !== null),
    proposed: markers.filter((marker) => marker.confirmed_at === null),
  };
}
