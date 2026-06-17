'use client';

/**
 * PerformanceView — the cockpit's Performance screen (design-handoff recreation).
 *
 * An 8-card KPI strip, a 30-day account-equity area chart (recharts), and a trade
 * ledger, all DERIVED server-side and folded into a `PerformanceSummary` (the UI
 * never computes money — it only renders). Data comes from `usePerformance`
 * (read-only poll); tests/RSC may seed via `summaryOverride`.
 */

import { css } from '@styled-system/css';
import { ResponsiveContainer, AreaChart, Area, YAxis, Tooltip } from 'recharts';
import { usePerformance } from '@/hooks/usePerformance';
import type { PerformanceSummary } from '@/lib/cockpit/performance-service';
import type { LedgerTrade } from '@/lib/cockpit/performance-business-logic';
import { GH, ZONE_COLORS, fmtUsd } from '../panel-styles';

export interface PerformanceViewProps {
  sessionId: string | null;
  /** Test/RSC seed: render this summary instead of fetching. */
  summaryOverride?: PerformanceSummary | null;
}

const TNUM = { fontFeatureSettings: '"tnum"' } as const;

/** Per-coin price precision: BTC→0, HYPE/LTC→2, else→1. */
function pxDecimals(coin: string): number {
  const c = coin.trim().toUpperCase();
  if (c === 'BTC') return 0;
  if (c === 'HYPE' || c === 'LTC') return 2;
  return 1;
}

function fmtPxFor(coin: string, px: number): string {
  return px.toLocaleString('en-US', {
    minimumFractionDigits: pxDecimals(coin),
    maximumFractionDigits: pxDecimals(coin),
  });
}

/** Format an epoch-ms timestamp as `MM-DD HH:mm` (UTC). */
function fmtTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

function fmtMoney(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

interface KpiSpec {
  slug: string;
  label: string;
  value: string;
  color: string;
  sub: string;
}

function profitFactorColor(pf: number): string {
  if (pf >= 1.5) return ZONE_COLORS.ok;
  if (pf >= 1) return ZONE_COLORS.warn;
  return ZONE_COLORS.danger;
}

function buildKpis(summary: PerformanceSummary): KpiSpec[] {
  const k = summary.kpis;
  return [
    {
      slug: 'net-pnl',
      label: 'Net PnL (all-time)',
      value: fmtUsd(k.netPnlUsd),
      color: k.netPnlUsd >= 0 ? ZONE_COLORS.ok : ZONE_COLORS.danger,
      sub: `${k.closedCount} closed trades`,
    },
    {
      slug: 'win-rate',
      label: 'Win rate',
      value: `${k.winRatePct.toFixed(0)}%`,
      color: GH.textBright,
      sub: `${k.winCount}W / ${k.lossCount}L`,
    },
    {
      slug: 'profit-factor',
      label: 'Profit factor',
      value: k.profitFactor.toFixed(2),
      color: profitFactorColor(k.profitFactor),
      sub: 'gross win / loss',
    },
    {
      slug: 'today',
      label: 'Today',
      value: fmtUsd(k.todayPnlUsd),
      color: k.todayPnlUsd >= 0 ? ZONE_COLORS.ok : ZONE_COLORS.danger,
      sub: 'realized so far',
    },
    {
      slug: 'avg-trade',
      label: 'Avg trade',
      value: fmtUsd(k.avgTradeUsd),
      color: GH.textBright,
      sub: 'per closed trade',
    },
    {
      slug: 'max-drawdown',
      label: 'Max drawdown',
      value: `-${k.maxDrawdownPct.toFixed(1)}%`,
      color: ZONE_COLORS.warn,
      sub: 'trailing 30d',
    },
    {
      slug: 'fees',
      label: 'Fees paid',
      value: `$${k.feesUsd.toFixed(2)}`,
      color: GH.textMuted,
      sub: 'all-time',
    },
    {
      slug: 'open-exposure',
      label: 'Open exposure',
      value: `$${k.openExposureUsd.toLocaleString('en-US', { maximumFractionDigits: 2 })}`,
      color: GH.textBright,
      sub: `${k.openCount} open`,
    },
  ];
}

const STATUS_CHIP: Record<LedgerTrade['status'], { label: string; color: string; bg: string }> = {
  open: { label: 'OPEN', color: '#5b8cff', bg: 'rgba(91,140,255,.12)' },
  win: { label: 'WIN', color: '#19c98a', bg: 'rgba(25,201,138,.12)' },
  loss: { label: 'LOSS', color: '#f24d5e', bg: 'rgba(242,77,94,.12)' },
};

const LEDGER_GRID = '120px 110px 90px 110px 110px 90px 1fr 110px';

function KpiCard({ spec }: { spec: KpiSpec }) {
  return (
    <div
      data-testid="kpi-card"
      data-kpi={spec.slug}
      className={css({
        bg: 'cockpit.panel',
        border: '1px solid token(colors.github.border)',
        borderRadius: '11px',
        padding: '14px 16px',
      })}
    >
      <div
        className={css({
          fontFamily: 'sans',
          fontSize: '10px',
          letterSpacing: '.12em',
          textTransform: 'uppercase',
          fontWeight: 'semibold',
        })}
        style={{ color: '#586273' }}
      >
        {spec.label}
      </div>
      <div
        className={css({ fontFamily: 'mono', fontSize: '21px', fontWeight: 'semibold', marginTop: '7px' })}
        style={{ color: spec.color, ...TNUM }}
      >
        {spec.value}
      </div>
      <div
        className={css({ fontSize: '10.5px', marginTop: '3px' })}
        style={{ color: '#586273' }}
      >
        {spec.sub}
      </div>
    </div>
  );
}

function EquityCard({ summary }: { summary: PerformanceSummary }) {
  const up = summary.equity30dPct >= 0;
  return (
    <div
      data-testid="equity-card"
      className={css({
        bg: 'cockpit.panel',
        border: '1px solid token(colors.github.border)',
        borderRadius: '12px',
      })}
    >
      <div
        className={css({
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          padding: '13px 15px',
          borderBottom: '1px solid token(colors.github.border)',
        })}
      >
        <span
          className={css({ fontFamily: 'sans', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '.14em', fontWeight: 'semibold' })}
          style={{ color: '#9aa4b5' }}
        >
          Account Equity
        </span>
        <span className={css({ fontFamily: 'mono', fontSize: '11px' })} style={{ color: '#586273' }}>
          30 days
        </span>
        <span className={css({ flex: 1 })} />
        <span className={css({ fontFamily: 'mono', fontSize: '18px', fontWeight: 'semibold' })} style={{ color: GH.textBright, ...TNUM }}>
          ${fmtMoney(summary.equityUsd)}
        </span>
        <span
          className={css({ fontFamily: 'mono', fontSize: '12px' })}
          style={{ color: up ? ZONE_COLORS.ok : ZONE_COLORS.danger, ...TNUM }}
        >
          {`${up ? '+' : ''}${summary.equity30dPct.toFixed(1)}% · 30d`}
        </span>
      </div>
      <div style={{ height: 280, padding: '8px 4px' }}>
        {summary.equity.length === 0 ? (
          <div
            className={css({ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'mono', fontSize: '12px' })}
            style={{ color: '#586273' }}
          >
            No equity history yet.
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={summary.equity} margin={{ top: 8, right: 8, bottom: 4, left: 4 }}>
              <defs>
                <linearGradient id="perf-equity-fill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="rgba(25,201,138,0.22)" />
                  <stop offset="100%" stopColor="rgba(25,201,138,0)" />
                </linearGradient>
              </defs>
              <YAxis
                orientation="right"
                domain={['auto', 'auto']}
                width={56}
                axisLine={false}
                tickLine={false}
                tick={{ fill: '#586273', fontSize: 10, fontFamily: 'monospace' }}
                tickFormatter={(v: number) => `$${v.toFixed(0)}`}
              />
              <Tooltip
                contentStyle={{ background: '#0a0d13', border: '1px solid #21262d' }}
                labelStyle={{ color: '#e8ebf2' }}
                itemStyle={{ color: '#e8ebf2' }}
                formatter={(v) => `$${Number(v).toFixed(2)}`}
              />
              <Area
                type="monotone"
                dataKey="equity"
                stroke="#19c98a"
                strokeWidth={1.8}
                fill="url(#perf-equity-fill)"
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}

function LedgerRow({ trade }: { trade: LedgerTrade }) {
  const chip = STATUS_CHIP[trade.status];
  const exitText =
    trade.exitPx == null
      ? '—'
      : trade.status === 'open'
        ? `${fmtPxFor(trade.coin, trade.exitPx)} ·`
        : fmtPxFor(trade.coin, trade.exitPx);

  return (
    <div
      data-testid="ledger-row"
      className={css({
        display: 'grid',
        gap: '12px',
        alignItems: 'center',
        padding: '11px 18px',
        borderBottom: '1px solid rgba(255,255,255,.04)',
        fontFamily: 'mono',
        fontSize: '11.5px',
      })}
      style={{ gridTemplateColumns: LEDGER_GRID, minWidth: '860px' }}
    >
      <span style={{ color: '#8b95a6', ...TNUM }}>{fmtTime(trade.openedAt)}</span>
      <span style={{ color: '#e8ebf2', fontWeight: 500 }}>{trade.coin}-PERP</span>
      <span style={{ color: trade.side === 'long' ? ZONE_COLORS.ok : ZONE_COLORS.danger }}>
        {trade.side.toUpperCase()}
      </span>
      <span style={{ color: '#cdd4e0', ...TNUM }}>{fmtPxFor(trade.coin, trade.entryPx)}</span>
      <span style={{ color: '#cdd4e0', ...TNUM }}>{exitText}</span>
      <span style={{ color: '#8b95a6', ...TNUM }}>
        {trade.leverage == null ? '—' : `${trade.leverage}x`}
      </span>
      <span
        style={{
          textAlign: 'right',
          fontWeight: 600,
          color: trade.pnlUsd >= 0 ? ZONE_COLORS.ok : ZONE_COLORS.danger,
          ...TNUM,
        }}
      >
        {fmtUsd(trade.pnlUsd)}
      </span>
      <span style={{ textAlign: 'right' }}>
        <span
          data-testid="ledger-status"
          className={css({ fontFamily: 'mono', display: 'inline-block' })}
          style={{
            fontSize: '10px',
            letterSpacing: '.05em',
            padding: '2px 8px',
            borderRadius: '5px',
            color: chip.color,
            background: chip.bg,
          }}
        >
          {chip.label}
        </span>
      </span>
    </div>
  );
}

function TradeLedger({ summary }: { summary: PerformanceSummary }) {
  return (
    <div
      data-testid="trade-ledger"
      className={css({
        bg: 'cockpit.panel',
        border: '1px solid token(colors.github.border)',
        borderRadius: '12px',
      })}
    >
      <div className={css({ display: 'flex', alignItems: 'center', gap: '12px', padding: '13px 15px' })}>
        <span
          className={css({ fontFamily: 'sans', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '.14em', fontWeight: 'semibold' })}
          style={{ color: '#9aa4b5' }}
        >
          Trade Ledger
        </span>
        <span className={css({ flex: 1 })} />
        <span className={css({ fontFamily: 'mono', fontSize: '11px' })} style={{ color: '#586273' }}>
          {summary.ledger.length} entries
        </span>
      </div>
      <div className={css({ overflowX: 'auto' })}>
        <div style={{ minWidth: '860px' }}>
          <div
            className={css({
              display: 'grid',
              gap: '12px',
              padding: '10px 18px',
              fontFamily: 'sans',
              fontSize: '10px',
              textTransform: 'uppercase',
              letterSpacing: '.1em',
              fontWeight: 'semibold',
            })}
            style={{ gridTemplateColumns: LEDGER_GRID, color: '#586273' }}
          >
            <span>Time</span>
            <span>Market</span>
            <span>Side</span>
            <span>Entry</span>
            <span>Exit</span>
            <span>Lev</span>
            <span style={{ textAlign: 'right' }}>Realized PnL</span>
            <span style={{ textAlign: 'right' }}>Status</span>
          </div>
          {summary.ledger.length === 0 ? (
            <div
              className={css({ padding: '11px 18px', fontFamily: 'mono', fontSize: '11.5px' })}
              style={{ color: '#586273', minWidth: '860px' }}
            >
              No trades yet — the ledger fills as fills land.
            </div>
          ) : (
            summary.ledger.map((t) => <LedgerRow key={t.id} trade={t} />)
          )}
        </div>
      </div>
    </div>
  );
}

export function PerformanceView({ sessionId, summaryOverride }: PerformanceViewProps) {
  const live = usePerformance(summaryOverride !== undefined ? null : sessionId);
  const summary = summaryOverride !== undefined ? summaryOverride : live.summary;

  const rootClass = css({ flex: 1, overflowY: 'auto', padding: '16px' });

  if (summary == null) {
    return (
      <section data-testid="performance-view" className={rootClass}>
        <div
          className={css({
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            minHeight: '200px',
            fontFamily: 'mono',
            fontSize: '13px',
          })}
          style={{ color: '#586273' }}
        >
          {live.loading
            ? 'Loading performance…'
            : 'No active session — open one to see performance.'}
        </div>
      </section>
    );
  }

  const kpis = buildKpis(summary);

  return (
    <section data-testid="performance-view" className={rootClass}>
      <div
        className={css({
          maxWidth: '1280px',
          margin: '0 auto',
          display: 'flex',
          flexDirection: 'column',
          gap: '14px',
        })}
      >
        <div
          className={css({
            display: 'grid',
            gridTemplateColumns: 'repeat(2, 1fr)',
            gap: '12px',
            md: { gridTemplateColumns: 'repeat(4, 1fr)' },
          })}
        >
          {kpis.map((spec) => (
            <KpiCard key={spec.slug} spec={spec} />
          ))}
        </div>

        <EquityCard summary={summary} />
        <TradeLedger summary={summary} />
      </div>
    </section>
  );
}

export default PerformanceView;
