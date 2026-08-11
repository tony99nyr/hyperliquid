/**
 * scout-watch service — the I/O half of the FREE deterministic trigger daemon.
 * Assembles the latest deterministic reads (rubric scores, fresh marks, open
 * paper positions + their health) and runs the PURE `detectScoutTriggers` against
 * carried state. Emits triggers to a JSONL file the (cheap-model) scout session
 * watches with a Monitor — so a model is only ever invoked when something
 * material happened (the inverted loop). NEVER trades; NEVER imports the fill path.
 *
 * The pure comparison logic + dedup live in `scout-trigger-business-logic.ts`;
 * this file is the thin Supabase/HL bridge + the trigger-file sink.
 */

import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getServiceRoleClient } from '@/lib/cockpit/supabase-server';
import { appendTriggers } from './scout-trigger-sink';
import { fetchAllMids } from '@/lib/hyperliquid/hyperliquid-info-service';
import { listActiveSessions } from '@/lib/cockpit/session-service';
import {
  detectScoutTriggers,
  reversionTriggersFromHits,
  emptyScoutState,
  DEFAULT_SCOUT_TRIGGER_CONFIG,
  type ScoutLeaderActionRead,
  type ScoutRubricRead,
  type ScoutMarketRead,
  type ScoutPositionRead,
  type ScoutState,
  type ScoutTrigger,
  type ScoutTriggerConfig,
} from './scout-trigger-business-logic';
import { scanReversionExtremes } from './reversion-scan-service';

// Trigger persistence lives behind the ScoutTriggerSink seam (scout-trigger-sink.ts):
// supabase `scout_triggers` primary (any-box visibility + consumer cursor), JSONL fallback.
export { scoutTriggerFilePath } from './scout-trigger-sink';

/** Persisted trigger-state file — survives a daemon restart so a restart doesn't
 * re-baseline blind (and miss a breakout that happens during the first cycle). */
export function scoutStateFilePath(): string {
  return process.env.SCOUT_STATE_FILE ?? join(homedir(), '.hl-cockpit-scout-state.json');
}

/** Load carried trigger state from disk; empty (fresh baseline) if absent/corrupt. */
export function loadScoutState(path = scoutStateFilePath()): ScoutState {
  try {
    if (!existsSync(path)) return emptyScoutState();
    const s = JSON.parse(readFileSync(path, 'utf8')) as Partial<ScoutState>;
    return {
      lastOpportunity: s.lastOpportunity ?? {},
      lastBadge: s.lastBadge ?? {},
      lastMark: s.lastMark ?? {},
      lastHealth: s.lastHealth ?? {},
      driftAnchorPx: s.driftAnchorPx ?? {},
      driftAnchorAt: s.driftAnchorAt ?? {},
      lastLeaderActionMs: s.lastLeaderActionMs ?? 0,
      // Reversion sub-cadence state — persisted so a daemon restart doesn't re-emit a
      // still-cooling stretch or immediately re-scan.
      lastReversionEmit: s.lastReversionEmit ?? {},
      lastReversionScanAt: s.lastReversionScanAt ?? 0,
    };
  } catch {
    return emptyScoutState();
  }
}

/** Persist carried trigger state (best-effort; a write failure must not kill the loop).
 * Atomic (temp + rename) so a crash mid-write can't leave a half-written file. */
export function saveScoutState(state: ScoutState, path = scoutStateFilePath()): void {
  try {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(state), 'utf8');
    renameSync(tmp, path);
  } catch {
    /* best-effort */
  }
}

interface RawRubricRow {
  coin: string;
  side: string;
  opportunity: number;
  badge: string;
  computed_at: string;
}

/**
 * PURE: collapse rubric_scores rows (newest-first) to the single newest read per
 * coin×side. Exported for unit testing. Input MUST be ordered computed_at desc.
 */
export function pickNewestRubricReads(rows: RawRubricRow[]): ScoutRubricRead[] {
  const seen = new Set<string>();
  const out: ScoutRubricRead[] = [];
  for (const r of rows) {
    const side = r.side === 'short' ? 'short' : 'long';
    const key = `${r.coin.toUpperCase()}:${side}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const badge = r.badge === 'GO' || r.badge === 'WATCH' ? r.badge : 'NO-EDGE';
    out.push({ coin: r.coin.toUpperCase(), side, opportunity: Number(r.opportunity) || 0, badge });
  }
  return out;
}

/** Rubric scans older than this are STALE — the scout must not act on them. */
export const RUBRIC_STALE_MS = 20 * 60 * 1000;

/**
 * PURE freshness gate: decide whether the feed is too degraded to trade on.
 * `rubricNewestMs === 0` means no recent scan at all. Empty marks ⇒ HL unreachable.
 */
export function assessFeedDegradation(
  rubricNewestMs: number,
  marksCount: number,
  now: number,
): { degraded: boolean; reason: string | null; rubricAgeMs: number } {
  const rubricAgeMs = rubricNewestMs > 0 ? now - rubricNewestMs : Number.POSITIVE_INFINITY;
  const rubricStale = rubricNewestMs === 0 || rubricAgeMs > RUBRIC_STALE_MS;
  const marksEmpty = marksCount === 0;
  const degraded = rubricStale || marksEmpty;
  const reason = !degraded
    ? null
    : [
        rubricStale ? `rubric stale (${rubricNewestMs === 0 ? 'none' : Math.round(rubricAgeMs / 60000) + 'm'})` : null,
        marksEmpty ? 'marks empty' : null,
      ]
        .filter(Boolean)
        .join(' + ');
  return { degraded, reason, rubricAgeMs };
}

/** Read the newest rubric read per coin×side from the last ~2h of scans + the freshest scan age. */
async function readLatestRubric(
  client: SupabaseClient,
  now = Date.now(),
): Promise<{ reads: ScoutRubricRead[]; newestMs: number }> {
  const since = new Date(now - 2 * 60 * 60 * 1000).toISOString();
  const { data, error } = await client
    .from('rubric_scores')
    .select('coin, side, opportunity, badge, computed_at')
    .gte('computed_at', since)
    .order('computed_at', { ascending: false })
    .limit(400);
  if (error) throw new Error(`scout-watch: rubric read failed: ${error.message}`);
  const rows = (data ?? []) as RawRubricRow[];
  const newestMs = rows.length > 0 ? new Date(rows[0].computed_at).getTime() : 0;
  return { reads: pickNewestRubricReads(rows), newestMs: Number.isFinite(newestMs) ? newestMs : 0 };
}

/** One open paper position row from the batched cross-session read. */
interface OpenPaperPositionRow {
  sessionId: string;
  coin: string;
  side: 'long' | 'short';
  avgEntryPx: number;
  stopPx: number | null;
  targetPx: number | null;
}

/** Coerce a stop/target column value to a positive finite price, else null. */
function toAdvisoryPx(value: unknown): number | null {
  const px = Number(value);
  return Number.isFinite(px) && px > 0 ? px : null;
}

/**
 * Batched read of every OPEN position (with its advisory stop_px/target_px)
 * across many paper sessions in ONE query. Replaces the per-session
 * loadOpenPositions + readAdvisoryStops + readAdvisoryTargets triple in the
 * 60s trigger tick (egress fix, Aug 2026). `sz > 0` filters server-side so
 * flat rows never leave the database. Throws on a hard read error — the caller
 * treats that as "no positions this tick" (best-effort, never kills the cycle).
 */
async function readOpenPaperPositions(
  client: SupabaseClient,
  sessionIds: string[],
): Promise<OpenPaperPositionRow[]> {
  if (sessionIds.length === 0) return [];
  const { data, error } = await client
    .from('positions')
    .select('session_id, coin, side, sz, avg_entry_px, stop_px, target_px')
    .in('session_id', sessionIds)
    .gt('sz', 0);
  if (error) throw new Error(`scout-watch: open-positions read failed: ${error.message}`);
  const out: OpenPaperPositionRow[] = [];
  for (const r of (data ?? []) as Array<{
    session_id: string;
    coin: string;
    side: string;
    sz: unknown;
    avg_entry_px: unknown;
    stop_px: unknown;
    target_px: unknown;
  }>) {
    if (r.side !== 'long' && r.side !== 'short') continue;
    const sz = Number(r.sz);
    if (!Number.isFinite(sz) || sz <= 0) continue;
    out.push({
      sessionId: r.session_id,
      coin: r.coin,
      side: r.side,
      avgEntryPx: Number(r.avg_entry_px) || 0,
      stopPx: toAdvisoryPx(r.stop_px),
      targetPx: toAdvisoryPx(r.target_px),
    });
  }
  return out;
}

/**
 * Persist / clear the advisory stop for a (session, coin) position. Called by the
 * scout paper path only (entry sets, full close clears). Best-effort by design —
 * the fill is already committed; a failed stop write must not fail the trade.
 */
export async function setAdvisoryStop(
  sessionId: string,
  coin: string,
  stopPx: number | null,
  client: SupabaseClient = getServiceRoleClient(),
): Promise<boolean> {
  const value = stopPx != null && Number.isFinite(stopPx) && stopPx > 0 ? stopPx : null;
  const { error } = await client
    .from('positions')
    .update({ stop_px: value })
    .eq('session_id', sessionId)
    .eq('coin', coin.trim().toUpperCase());
  return !error;
}

/**
 * Persist / clear the advisory TARGET for a (session, coin) position — mirrors
 * setAdvisoryStop. Called by the scout paper path (reversion entry sets it from the
 * scan's target; full close clears it). Best-effort — the fill is already committed.
 */
export async function setAdvisoryTarget(
  sessionId: string,
  coin: string,
  targetPx: number | null,
  client: SupabaseClient = getServiceRoleClient(),
): Promise<boolean> {
  const value = targetPx != null && Number.isFinite(targetPx) && targetPx > 0 ? targetPx : null;
  const { error } = await client
    .from('positions')
    .update({ target_px: value })
    .eq('session_id', sessionId)
    .eq('coin', coin.trim().toUpperCase());
  return !error;
}

/**
 * Recent leader actions from the trader-watch feed (bounded window — the pure
 * detector's timestamp cursor does the exact dedup). Best-effort: [] on failure.
 */
async function readRecentLeaderActions(client: SupabaseClient, now: number): Promise<ScoutLeaderActionRead[]> {
  const since = new Date(now - 6 * 60 * 60 * 1000).toISOString();
  // NEWEST-first + kind-filtered in SQL: under reduce/close churn an ascending read
  // would spend the row budget on the oldest noise and starve fresh opens/flips
  // (review finding). The detector re-sorts ascending and cursor-dedups.
  const { data, error } = await client
    .from('leader_actions')
    .select('id, leader_address, coin, kind, new_side, notional_usd, size_delta, entry_px, detected_at')
    .gte('detected_at', since)
    .in('kind', ['open', 'flip', 'add'])
    .order('detected_at', { ascending: false })
    .limit(200);
  if (error || !data) return [];
  return (data as Array<Record<string, unknown>>).map((r) => ({
    id: (r.id as string | number) ?? '',
    leaderAddress: String(r.leader_address ?? ''),
    coin: String(r.coin ?? ''),
    kind: String(r.kind ?? ''),
    newSide: r.new_side == null ? null : String(r.new_side),
    notionalUsd: Number(r.notional_usd) || 0,
    sizeDelta: Number(r.size_delta) || 0,
    entryPx: r.entry_px == null ? null : Number(r.entry_px),
    detectedAtMs: new Date(String(r.detected_at)).getTime(),
  }));
}

/** Latest open-position health score per (session, coin), best-effort (null when absent). */
async function readLatestHealth(client: SupabaseClient, sessionId: string, coin: string): Promise<number | null> {
  const { data, error } = await client
    .from('health_snapshots')
    .select('score')
    .eq('session_id', sessionId)
    .eq('coin', coin)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  const score = Number((data as { score: unknown }).score);
  return Number.isFinite(score) ? score : null;
}

export interface ScoutInputs {
  rubric: ScoutRubricRead[];
  marks: ScoutMarketRead[];
  positions: ScoutPositionRead[];
  /** Recent rated-leader actions (trader-watch feed; cursor-deduped by the detector). */
  leaderActions: ScoutLeaderActionRead[];
  now: number;
  /** True when the feed can't be trusted (stale rubric or empty marks) → STAND DOWN. */
  degraded: boolean;
  degradedReason: string | null;
  /** Age (ms) of the freshest rubric scan, for display. */
  rubricAgeMs: number;
}

/** Gather all inputs for the pure detector. Fail-soft per source + a freshness gate. */
export async function gatherScoutInputs(now: number): Promise<ScoutInputs> {
  const client = getServiceRoleClient();
  const [rubricRes, mids, sessions, leaderActions] = await Promise.all([
    readLatestRubric(client, now).catch(() => ({ reads: [] as ScoutRubricRead[], newestMs: 0 })),
    fetchAllMids().catch(() => ({}) as Record<string, number>),
    listActiveSessions().catch(() => []),
    readRecentLeaderActions(client, now).catch(() => [] as ScoutLeaderActionRead[]),
  ]);
  const rubric = rubricRes.reads;

  // Marks only for coins the rubric covers (the scan universe).
  const coins = Array.from(new Set(rubric.map((r) => r.coin)));
  const marks: ScoutMarketRead[] = coins
    .map((c) => ({ coin: c, markPx: Number(mids[c]) }))
    .filter((m) => Number.isFinite(m.markPx) && m.markPx > 0);
  const markByCoin = new Map(marks.map((m) => [m.coin, m.markPx]));

  // Open paper positions across active PAPER sessions ONLY, with best-effort health +
  // the advisory stop (positions.stop_px, migration 0033) for the near-stop trigger.
  // HARD LANE BOUNDARY (Jul 14 incident): listActiveSessions returns LIVE sessions
  // too, and an unfiltered scout once "managed" a live ladder position — its paper
  // close flattened the live ledger row. The scout must only ever SEE its own lane.
  const paperSessions = sessions.filter((sess) => sess.mode === 'paper');
  const positions: ScoutPositionRead[] = [];
  // ONE batched query for open positions + advisory stop/target across ALL paper
  // sessions (egress fix, Aug 2026): the previous per-session triple
  // (loadOpenPositions + readAdvisoryStops + readAdvisoryTargets) was 3 PostgREST
  // round-trips per active paper session per 60s tick — with dozens of stale
  // sessions, a major term in the Supabase fair-use overage. Best-effort: a read
  // failure yields no positions this tick, never kills the cycle.
  const open = await readOpenPaperPositions(client, paperSessions.map((s) => s.id)).catch(
    () => [] as OpenPaperPositionRow[],
  );
  for (const p of open) {
    const coin = p.coin.toUpperCase();
    const markPx = markByCoin.get(coin) ?? p.avgEntryPx;
    const healthScore = await readLatestHealth(client, p.sessionId, p.coin).catch(() => null);
    positions.push({
      coin,
      sessionId: p.sessionId, // so the headless model can close by (session, coin)
      side: p.side,
      healthScore,
      unrealizedPnlUsd: 0, // not needed for triggers; the cycle computes it fresh
      stopPx: p.stopPx,
      targetPx: p.targetPx,
      markPx,
    });
  }

  // Freshness gate: don't act on a stale rubric (scan down) or empty marks (HL
  // unreachable). The cycle/daemon stand down rather than trade on bad data.
  const { degraded, reason: degradedReason, rubricAgeMs } = assessFeedDegradation(rubricRes.newestMs, marks.length, now);

  return { rubric, marks, positions, leaderActions, now, degraded, degradedReason, rubricAgeMs };
}

/** Upsert a liveness heartbeat so the cockpit can show "scout last tick Nm ago"
 * and a hung/dead daemon (crash, OAuth expiry) is detectable. Best-effort. */
export async function writeScoutHeartbeat(
  status: string,
  detail: string,
  source = 'scout-watch',
  now: number = Date.now(),
): Promise<void> {
  try {
    await getServiceRoleClient()
      .from('scout_heartbeat')
      .upsert({ source, last_tick_at: new Date(now).toISOString(), status, detail }, { onConflict: 'source' });
  } catch {
    /* best-effort liveness */
  }
}

/** Append triggers to the sink (table primary, JSONL fallback — see scout-trigger-sink). */
export async function appendScoutTriggers(triggers: ScoutTrigger[]): Promise<'supabase' | 'jsonl' | 'none'> {
  return appendTriggers(triggers);
}

/**
 * Run one trigger cycle: gather → detect → append. Returns the next state (carry
 * it into the next call) + the triggers fired. NEVER trades.
 */
/** Hard wall-time cap on the reversion candle-scan so a slow/hostile HL can't stall the
 *  60s trigger tick past this (up to 6 coins × 2 sequential fetches × the candle-service
 *  8s timeout would otherwise be ~90s). On timeout the scan is treated as a failure. */
const REVERSION_SCAN_TIMEOUT_MS = 20_000;

export async function runScoutWatchCycle(
  prev: ScoutState,
  cfg?: ScoutTriggerConfig,
  now: number = Date.now(),
): Promise<{
  triggers: ScoutTrigger[];
  state: ScoutState;
  degraded: boolean;
  degradedReason: string | null;
  sink: 'supabase' | 'jsonl' | 'none';
  /** Coverage of the reversion scan this cycle (absent when the scan didn't run). */
  reversionCoverage?: { requested: number; scanned: number; skipped: number };
}> {
  const input = await gatherScoutInputs(now);
  // STAND DOWN on a degraded feed: don't emit (and thus don't wake the model to
  // trade) on stale rubric or empty marks. Still advance state so the next good
  // cycle compares against the latest values, not a pre-outage baseline.
  if (input.degraded) {
    const { state } = detectScoutTriggers(input, prev, cfg);
    // LEVEL detectors correctly advance during an outage (next good cycle re-reads
    // the level). The leader-action EVENT cursor must NOT — advancing it here would
    // permanently swallow every whale action seen during the degraded window
    // (review finding). Hold it at the pre-outage cursor so recovery re-emits.
    state.lastLeaderActionMs = prev.lastLeaderActionMs ?? 0;
    return { triggers: [], state, degraded: true, degradedReason: input.degradedReason, sink: 'none' };
  }
  const { triggers, state } = detectScoutTriggers(input, prev, cfg);

  // Reversion-extreme scan on a SUB-CADENCE. The 60s detector above is cheap table/mark
  // reads; this fetches candles (15m + 4h) per coin, so it runs at most every
  // reversionScanIntervalMs and is FULLY fail-soft — a candle blip must never break the
  // trigger tick. Emitting these as triggers (vs only inside the model's cycle) captures
  // a stretch AT PRINT TIME and feeds the reversion-extreme forward-test telemetry.
  const cfgEff = cfg ?? DEFAULT_SCOUT_TRIGGER_CONFIG;
  let allTriggers = triggers;
  let nextState = state;
  let reversionCoverage: { requested: number; scanned: number; skipped: number } | undefined;
  const scanDue = cfgEff.reversionScanIntervalMs > 0 && now - (state.lastReversionScanAt ?? 0) >= cfgEff.reversionScanIntervalMs;
  if (scanDue) {
    try {
      const coins = input.marks.map((m) => m.coin).slice(0, 6);
      // Wall-time bound (REVERSION_SCAN_TIMEOUT_MS): a timeout resolves to a zero-scan
      // result so a slow HL can't stall the tick — treated exactly like a scan failure.
      const scan = await Promise.race([
        scanReversionExtremes(coins, now),
        new Promise<Awaited<ReturnType<typeof scanReversionExtremes>>>((resolve) =>
          setTimeout(() => resolve({ hits: [], regimeByCoin: {}, coverage: { requested: coins.length, scanned: 0, skipped: coins.length } }), REVERSION_SCAN_TIMEOUT_MS),
        ),
      ]);
      const { triggers: revTriggers, state: revState } = reversionTriggersFromHits(scan.hits, state, now, cfgEff);
      allTriggers = revTriggers.length > 0 ? [...triggers, ...revTriggers] : triggers;
      nextState = revState;
      reversionCoverage = scan.coverage;
    } catch {
      // Advance the scan clock even on failure so a persistent fetch error can't hot-loop
      // the candle pull every 60s tick — the next window retries.
      nextState = { ...state, lastReversionScanAt: now };
    }
  }

  // The adapter that took the write matters operationally: 'jsonl' means Supabase was
  // unreachable and these triggers are INVISIBLE to a table-reading consumer on another
  // box; 'none' means both sinks failed. The daemon surfaces this in its heartbeat.
  const sink = await appendScoutTriggers(allTriggers);
  return { triggers: allTriggers, state: nextState, degraded: false, degradedReason: null, sink, reversionCoverage };
}
