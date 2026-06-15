import { describe, it, expect } from 'vitest';
import {
  healthZone,
  healthColor,
  contextZoneColor,
  severityColor,
  pnlColor,
  fmtUsd,
  fmtPx,
  fmtPct,
  alertLabel,
  ZONE_COLORS,
} from '@/app/cockpit/components/panel-styles';

describe('panel-styles', () => {
  describe('healthZone thresholds', () => {
    it('ok at >= 60', () => {
      expect(healthZone(60)).toBe('ok');
      expect(healthZone(100)).toBe('ok');
    });
    it('warn in [35, 60)', () => {
      expect(healthZone(59.9)).toBe('warn');
      expect(healthZone(35)).toBe('warn');
    });
    it('critical below 35', () => {
      expect(healthZone(34.9)).toBe('critical');
      expect(healthZone(0)).toBe('critical');
    });
  });

  it('healthColor maps zones to palette', () => {
    expect(healthColor(80)).toBe(ZONE_COLORS.ok);
    expect(healthColor(40)).toBe(ZONE_COLORS.warn);
    expect(healthColor(10)).toBe(ZONE_COLORS.danger);
  });

  it('contextZoneColor maps zones', () => {
    expect(contextZoneColor('ok')).toBe(ZONE_COLORS.ok);
    expect(contextZoneColor('warn')).toBe(ZONE_COLORS.warn);
    expect(contextZoneColor('critical')).toBe(ZONE_COLORS.danger);
  });

  it('severityColor maps severities', () => {
    expect(severityColor('danger')).toBe(ZONE_COLORS.danger);
    expect(severityColor('warn')).toBe(ZONE_COLORS.warn);
    expect(severityColor('info')).not.toBe(ZONE_COLORS.danger);
  });

  it('pnlColor: green up, red down, muted flat', () => {
    expect(pnlColor(5)).toBe(ZONE_COLORS.ok);
    expect(pnlColor(-5)).toBe(ZONE_COLORS.danger);
    expect(pnlColor(0)).not.toBe(ZONE_COLORS.ok);
  });

  it('fmtUsd signs and 2dp', () => {
    expect(fmtUsd(12.3)).toBe('+$12.30');
    expect(fmtUsd(-5)).toBe('−$5.00');
    expect(fmtUsd(0)).toBe('$0.00');
  });

  it('fmtPx handles null + precision', () => {
    expect(fmtPx(null)).toBe('—');
    expect(fmtPx(3000.123)).toBe('$3,000.12');
    expect(fmtPx(0.012345)).toBe('$0.01235');
  });

  it('fmtPct', () => {
    expect(fmtPct(0.42)).toBe('42%');
    expect(fmtPct(0.4267, 1)).toBe('42.7%');
  });

  it('alertLabel humanizes codes', () => {
    expect(alertLabel('bearish-divergence-1h')).toBe('Bearish divergence 1H');
    expect(alertLabel('stop-within-1-ATR')).toBe('Stop within 1 ATR');
  });
});
