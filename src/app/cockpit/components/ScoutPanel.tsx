'use client';

/**
 * ScoutPanel — the autonomous paper scout's track record at a glance. Shows the
 * scout's CURRENT OPEN POSITIONS (coin/side/size·lev/entry/uPnL) + its recent
 * theses (what it decided) with win/loss outcomes + a summary, so you can see on
 * your phone what the scout is holding and whether it's finding edge — the
 * legibility half of "is this worth running?". Reads `hypotheses` + the scout
 * session's `positions`/`pnl` (realtime, zero client HL calls). Read-only: the
 * scout trades itself. The full $/bar scorecard is `pnpm scout:review`.
 */

import { useEffect, useState } from 'react';
import { css } from '@styled-system/css';
import { ResponsiveContainer, AreaChart, Area, YAxis } from 'recharts';
import { useScoutHypotheses } from '@/hooks/useScoutHypotheses';
import { useScoutHeartbeat } from '@/hooks/useScoutHeartbeat';
import { useScoutSessionIds } from '@/hooks/useScoutSessionIds';
import { useScoutPerformance, type ScoutLanes } from '@/hooks/useScoutPerformance';
import { usePositionPnl } from '@/hooks/usePositionPnl';
import type { PositionRow, PnlSnapshot } from '@/hooks/realtime-row-mappers';
import type { PerformanceSummary } from '@/lib/cockpit/performance-service';
import type { LaneCard } from '@/types/scout';
import type { Hypothesis } from '@/types/cockpit';
import { panelSurface, GH, ZONE_COLORS, fmtUsd, fmtPx } from './panel-styles';
import { userPositionDisplay } from './position-panel-helpers';
import { uPnlPct } from './open-positions-helpers';
import { scoutStats, statusMeta } from './scout-panel-helpers';

/** A daemon silent longer than this is presumed dead/hung (crash, OAuth expiry). */
const HEARTBEAT_STALE_MS = 5 * 60 * 1000;

export interface ScoutPanelProps {
  /** Test/RSC seed: render fixed theses instead of subscribing. */
  hypsOverride?: Hypothesis[];
  /** Test/RSC seed: render fixed open positions instead of subscribing. */
  positionsOverride?: { positions: PositionRow[]; latestPnlByCoin: Record<string, PnlSnapshot> };
  /** Test/RSC seed: render this scout track record instead of fetching. */
  perfOverride?: PerformanceSummary | null;
  /** Test/RSC seed: render this per-lane breakdown instead of fetching. */
  lanesOverride?: ScoutLanes | null;
}

export default function ScoutPanel({ hypsOverride, positionsOverride, perfOverride, lanesOverride }: ScoutPanelProps) {
  const controlled = hypsOverride !== undefined;
  const live = useScoutHypotheses({ enabled: !controlled });
  const hyps = hypsOverride ?? live.rows;
  const stats = scoutStats(hyps);

  // The scout's REAL trading track record (net paper P&L + win rate + a 30d
  // cumulative-P&L curve), folded server-side from the scout's own fills. This is
  // "how it's done over time" — distinct from the thesis outcomes below.
  const perfState = useScoutPerformance({ enabled: perfOverride === undefined && !controlled });
  const perf = perfOverride !== undefined ? perfOverride : perfState.summary;
  const k = perf?.kpis;
  const tradeWinPct = k && k.closedCount > 0 ? `${k.winRatePct.toFixed(0)}%` : '—';
  const curve = perf?.equity ?? [];

  // Per-lane breakdown (directional + vault/carry BENCHMARKS), persisted by the
  // nas-watch tick into lane_scorecards and served by the scout-performance route.
  const lanesData = lanesOverride !== undefined ? lanesOverride : perfState.lanes;
  const laneCards = lanesData?.lanes ?? [];

  // The scout's OWN open positions: the active scout session (latestId) → its
  // folded positions + latest pnl snapshots. Read-only (the scout trades itself);
  // legibility only. Seeded via positionsOverride in tests/RSC.
  const { latestId } = useScoutSessionIds(!controlled);
  const livePos = usePositionPnl(positionsOverride || controlled ? null : latestId);
  const positions = positionsOverride ? positionsOverride.positions : livePos.positions;
  const pnlByCoin = positionsOverride ? positionsOverride.latestPnlByCoin : livePos.latestPnlByCoin;
  const openPos = positions.filter((p) => p.side !== 'flat');
  const totalUpnl = openPos.reduce((s, p) => s + (userPositionDisplay(p, pnlByCoin[p.coin]).unrealizedPnlUsd ?? 0), 0);
  // Distinguish "still loading" from "genuinely empty" so the feed doesn't flash a
  // false "no theses yet" before the snapshot resolves. Overrides are always ready.
  const loading = hypsOverride === undefined && !live.loaded;
  const error = hypsOverride === undefined ? live.error : null;
  const subscribed = hypsOverride !== undefined || live.subscribed;

  // Daemon liveness: "watch tick Nm ago", red when silent past the stale window.
  const heartbeat = useScoutHeartbeat({ enabled: hypsOverride === undefined });
  const lastTickMs = (heartbeat.rows.find((r) => r.source === 'scout-watch') ?? heartbeat.rows[0])?.lastTickMs ?? 0;
  // CONSUMER liveness (source 'scout-cycle'): the half that actually DECIDES. It died
  // unnoticed for 8 days behind a healthy producer row — render it separately so a dead
  // consumer is a visible stale age, never silence.
  const consumerTickMs = heartbeat.rows.find((r) => r.source === 'scout-cycle')?.lastTickMs ?? 0;
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    if (hypsOverride !== undefined) return; // controlled (tests) — don't tick
    const id = setInterval(() => setClock(Date.now()), 30_000);
    return () => clearInterval(id);
  }, [hypsOverride]);
  const tickAgeMs = lastTickMs > 0 ? clock - lastTickMs : null;
  const tickStale = tickAgeMs != null && tickAgeMs > HEARTBEAT_STALE_MS;
  const tickLabel =
    tickAgeMs == null ? 'watch: —' : `watch: ${tickAgeMs < 60_000 ? `${Math.round(tickAgeMs / 1000)}s` : `${Math.round(tickAgeMs / 60_000)}m`} ago`;
  const consumerAgeMs = consumerTickMs > 0 ? clock - consumerTickMs : null;
  // The consumer runs on a ~30min cron — its stale window is hours, not minutes.
  const consumerStale = consumerAgeMs != null && consumerAgeMs > 2 * 3_600_000;
  const consumerLabel =
    consumerAgeMs == null ? 'cycle: —' : `cycle: ${consumerAgeMs < 3_600_000 ? `${Math.round(consumerAgeMs / 60_000)}m` : `${(consumerAgeMs / 3_600_000).toFixed(1)}h`} ago`;

  return (
    <section
      data-testid="scout-panel"
      className={css({ ...panelSurface, padding: '12px', display: 'flex', flexDirection: 'column', gap: '10px' })}
    >
      <header className={css({ display: 'flex', justifyContent: 'space-between', alignItems: 'center' })}>
        <h3 className={css({ fontFamily: 'label', fontSize: 'sm', fontWeight: 'bold', color: 'github.textBright', textTransform: 'uppercase', letterSpacing: '0.06em' })}>
          Scout
        </h3>
        <span className={css({ display: 'inline-flex', alignItems: 'center', gap: '5px', fontFamily: 'mono', fontSize: '9px', color: 'github.textMuted' })}>
          <span className={css({ width: '6px', height: '6px', borderRadius: '50%' })} style={{ background: subscribed ? ZONE_COLORS.ok : GH.textMuted }} />
          <span data-testid="scout-heartbeat" style={{ color: tickStale ? ZONE_COLORS.danger : undefined }}>{tickLabel}</span>
          {' · '}
          <span data-testid="scout-consumer-heartbeat" style={{ color: consumerStale ? ZONE_COLORS.danger : undefined }}>{consumerLabel}</span>
          {' · paper'}
        </span>
      </header>

      {/* REAL track record — net paper P&L + trades + win rate + a 30d curve */}
      <div data-testid="scout-track-record" className={css({ display: 'flex', flexDirection: 'column', gap: '7px' })}>
        <div className={css({ display: 'flex', alignItems: 'baseline', gap: '12px', fontFamily: 'mono' })}>
          <div className={css({ display: 'flex', flexDirection: 'column' })}>
            <span className={css({ fontFamily: 'label', fontSize: '8.5px', fontWeight: 'bold', letterSpacing: '0.07em', textTransform: 'uppercase', color: 'cockpit.faint' })}>Net P&amp;L (paper)</span>
            <span data-testid="scout-net-pnl" style={{ color: k == null ? GH.textMuted : k.netPnlUsd >= 0 ? ZONE_COLORS.ok : ZONE_COLORS.danger, fontFeatureSettings: '"tnum"' }} className={css({ fontSize: '17px', fontWeight: 'semibold' })}>
              {k == null ? '—' : fmtUsd(k.netPnlUsd)}
            </span>
          </div>
          <div className={css({ flex: 1 })} />
          <div className={css({ display: 'flex', gap: '12px', fontSize: '11px' })}>
            <span className={css({ color: 'github.textMuted' })}>trades <span style={{ color: GH.textBright }}>{k?.closedCount ?? '—'}</span></span>
            <span className={css({ color: 'github.textMuted' })}>
              <span style={{ color: ZONE_COLORS.ok }}>{k?.winCount ?? 0}W</span>
              {' / '}
              <span style={{ color: ZONE_COLORS.danger }}>{k?.lossCount ?? 0}L</span>
            </span>
            <span className={css({ color: 'github.textMuted' })}>win <span style={{ color: GH.textBright }}>{tradeWinPct}</span></span>
          </div>
        </div>
        {curve.length > 1 && (() => {
          // Color the curve by the net result so a losing scout doesn't read as a
          // healthy green line (honest legibility).
          const down = (k?.netPnlUsd ?? 0) < 0;
          const stroke = down ? '#f24d5e' : '#19c98a';
          const fillRgb = down ? '242,77,94' : '25,201,138';
          return (
            <div data-testid="scout-sparkline" data-down={down} style={{ height: 40 }}>
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={curve} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
                  <defs>
                    <linearGradient id="scout-spark-fill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={`rgba(${fillRgb},0.30)`} />
                      <stop offset="100%" stopColor={`rgba(${fillRgb},0)`} />
                    </linearGradient>
                  </defs>
                  <YAxis hide domain={['dataMin', 'dataMax']} />
                  <Area type="monotone" dataKey="equity" stroke={stroke} strokeWidth={1.4} fill="url(#scout-spark-fill)" isAnimationActive={false} dot={false} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          );
        })()}
      </div>

      {/* per-lane breakdown — directional (traded) vs vault/carry (benchmarks) */}
      {laneCards.length > 0 && (
        <div data-testid="scout-lanes" className={css({ display: 'flex', flexDirection: 'column', gap: '5px', borderTop: '1px solid token(colors.github.borderSubtle)', paddingTop: '9px' })}>
          <div className={css({ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' })}>
            <span className={css({ fontFamily: 'label', fontSize: '9px', fontWeight: 'bold', letterSpacing: '0.06em', textTransform: 'uppercase', color: 'github.textMuted' })}>
              Lanes <span style={{ color: GH.textBright }}>· {laneCards.length}</span>
            </span>
            <span className={css({ fontFamily: 'mono', fontSize: '9px', color: 'cockpit.faint' })}>traded + benchmarks</span>
          </div>
          {laneCards.map((l) => <ScoutLaneRow key={l.lane} lane={l} />)}
        </div>
      )}

      {/* open positions the scout is holding right now */}
      <div data-testid="scout-positions" className={css({ display: 'flex', flexDirection: 'column', gap: '6px', borderTop: '1px solid token(colors.github.borderSubtle)', paddingTop: '9px' })}>
        <div className={css({ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' })}>
          <span className={css({ fontFamily: 'label', fontSize: '9px', fontWeight: 'bold', letterSpacing: '0.06em', textTransform: 'uppercase', color: 'github.textMuted' })}>
            Open positions <span data-testid="scout-pos-count" style={{ color: GH.textBright }}>· {openPos.length}</span>
          </span>
          {openPos.length > 0 && (
            <span data-testid="scout-pos-total" style={{ color: totalUpnl > 0 ? ZONE_COLORS.ok : totalUpnl < 0 ? ZONE_COLORS.danger : GH.textMuted, fontFeatureSettings: '"tnum"' }} className={css({ fontFamily: 'mono', fontSize: '11px', fontWeight: 'medium' })}>
              {fmtUsd(totalUpnl)}
            </span>
          )}
        </div>
        {openPos.length === 0 ? (
          <span data-testid="scout-pos-flat" className={css({ fontFamily: 'mono', fontSize: '10px', color: 'github.textMuted' })}>
            flat — no open positions
          </span>
        ) : (
          openPos.map((p) => <ScoutPositionRow key={p.coin} pos={p} pnl={pnlByCoin[p.coin]} />)
        )}
      </div>

      {/* recent theses feed — the scout's reasoning (distinct from trade P&L above) */}
      <div className={css({ display: 'flex', flexDirection: 'column', gap: '5px', borderTop: '1px solid token(colors.github.borderSubtle)', paddingTop: '9px' })}>
        <div className={css({ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' })}>
          <span className={css({ fontFamily: 'label', fontSize: '9px', fontWeight: 'bold', letterSpacing: '0.06em', textTransform: 'uppercase', color: 'github.textMuted' })}>
            Theses <span style={{ color: GH.textBright }}>· {hyps.length}</span>
          </span>
          <span className={css({ fontFamily: 'mono', fontSize: '9px', color: 'cockpit.faint' })}>{stats.open} open</span>
        </div>
        {error ? (
          <span data-testid="scout-error" className={css({ fontFamily: 'mono', fontSize: '10px', color: 'zone.warn' })}>
            scout feed unavailable
          </span>
        ) : loading ? (
          <span data-testid="scout-loading" className={css({ fontFamily: 'mono', fontSize: '10px', color: 'github.textMuted' })}>
            reading…
          </span>
        ) : hyps.length === 0 ? (
          <span data-testid="scout-empty" className={css({ fontFamily: 'mono', fontSize: '10px', color: 'github.textMuted' })}>
            no theses yet — the scout logs each paper trade here
          </span>
        ) : (
          hyps.slice(0, 8).map((h) => {
            const m = statusMeta(h.status);
            return (
              <div key={h.id} data-testid="scout-thesis" className={css({ display: 'flex', alignItems: 'baseline', gap: '8px', fontFamily: 'mono', fontSize: '10px' })}>
                <span style={{ color: m.color }} className={css({ fontFamily: 'label', fontSize: '9px', fontWeight: 'bold', letterSpacing: '0.04em', width: '34px', flexShrink: 0 })}>{m.label}</span>
                <span title={h.statement} className={css({ color: 'github.textMuted', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' })}>{h.statement}</span>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}

/** One compact, read-only row for a scored lane: name · net$ · run-rate · label ·
 *  verdict. 'directional' is the traded lane; vault/carry are passive benchmarks. */
function ScoutLaneRow({ lane }: { lane: LaneCard }) {
  const verdictColor = lane.verdict === 'graduate' ? ZONE_COLORS.ok : lane.verdict === 'kill' ? ZONE_COLORS.danger : GH.textMuted;
  const netColor = lane.netUsd > 0 ? ZONE_COLORS.ok : lane.netUsd < 0 ? ZONE_COLORS.danger : GH.textMuted;
  const coin = typeof lane.detail?.coin === 'string' ? lane.detail.coin : '';
  const name = lane.lane === 'vault:HLP' ? 'vault·HLP' : lane.lane === 'carry' ? `carry${coin ? `·${coin}` : ''}` : lane.lane;
  return (
    <div data-testid="scout-lane-row" data-lane={lane.lane} className={css({ display: 'flex', alignItems: 'baseline', gap: '8px', fontFamily: 'mono', fontSize: '10px' })}>
      <span className={css({ color: 'github.textBright', fontWeight: 'semibold', width: '74px', flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' })}>{name}</span>
      <span data-testid="scout-lane-net" style={{ color: netColor, fontFeatureSettings: '"tnum"', width: '58px', flexShrink: 0 }}>{fmtUsd(lane.netUsd)}</span>
      <span className={css({ color: 'github.textMuted', flexShrink: 0 })} style={{ fontFeatureSettings: '"tnum"' }}>{fmtUsd(lane.monthlyRunRateUsd)}/mo</span>
      <span title={lane.label} className={css({ color: 'cockpit.faint', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' })}>{lane.label}</span>
      <span style={{ color: verdictColor }} className={css({ fontFamily: 'label', fontSize: '8.5px', fontWeight: 'bold', letterSpacing: '0.04em', flexShrink: 0 })}>{lane.verdict.toUpperCase()}</span>
    </div>
  );
}

/** One compact, read-only row for an open scout position: side · size·lev ·
 *  entry · uPnL. Mirrors the OpenPositionsPanel display fields (no actions). */
function ScoutPositionRow({ pos, pnl }: { pos: PositionRow; pnl: PnlSnapshot | undefined }) {
  const d = userPositionDisplay(pos, pnl);
  const sideColor = d.side === 'long' ? ZONE_COLORS.ok : ZONE_COLORS.danger;
  const pct = uPnlPct(d.side, d.entryPx, d.markPx);
  const upnl = d.unrealizedPnlUsd;
  const upnlColor = upnl == null ? GH.textMuted : upnl >= 0 ? ZONE_COLORS.ok : ZONE_COLORS.danger;
  return (
    <div data-testid="scout-position-row" data-coin={pos.coin} className={css({ display: 'flex', alignItems: 'baseline', gap: '8px', fontFamily: 'mono', fontSize: '10px' })}>
      <span className={css({ color: 'github.textBright', fontWeight: 'semibold', width: '38px', flexShrink: 0 })}>{pos.coin}</span>
      <span data-testid="scout-pos-side" style={{ color: sideColor }} className={css({ fontFamily: 'label', fontSize: '9px', fontWeight: 'bold', letterSpacing: '0.04em', width: '34px', flexShrink: 0 })}>
        {d.side.toUpperCase()}
      </span>
      <span className={css({ color: 'github.textMuted', flexShrink: 0 })}>
        {pos.sz.toLocaleString('en-US', { maximumFractionDigits: 4 })}{d.leverage != null ? ` · ${d.leverage}×` : ''}
      </span>
      <span className={css({ color: 'cockpit.faint', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' })}>@ {fmtPx(d.entryPx)}</span>
      <span data-testid="scout-pos-upnl" style={{ color: upnlColor, fontFeatureSettings: '"tnum"', flexShrink: 0 }}>
        {upnl == null ? '—' : fmtUsd(upnl)}{pct == null ? '' : ` (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)`}
      </span>
    </div>
  );
}
