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

import { appendFileSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getServiceRoleClient } from '@/lib/cockpit/supabase-server';
import { fetchAllMids } from '@/lib/hyperliquid/hyperliquid-info-service';
import { listActiveSessions } from '@/lib/cockpit/session-service';
import { loadOpenPositions } from '@/lib/cockpit/fill-persistence-service';
import {
  detectScoutTriggers,
  emptyScoutState,
  type ScoutRubricRead,
  type ScoutMarketRead,
  type ScoutPositionRead,
  type ScoutState,
  type ScoutTrigger,
  type ScoutTriggerConfig,
} from './scout-trigger-business-logic';

/** Default trigger sink — overridable via SCOUT_TRIGGER_FILE (e.g. on the home PC). */
export function scoutTriggerFilePath(): string {
  return process.env.SCOUT_TRIGGER_FILE ?? join(homedir(), '.hl-cockpit-scout-trigger.jsonl');
}

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
    };
  } catch {
    return emptyScoutState();
  }
}

/** Persist carried trigger state (best-effort; a write failure must not kill the loop). */
export function saveScoutState(state: ScoutState, path = scoutStateFilePath()): void {
  try {
    writeFileSync(path, JSON.stringify(state), 'utf8');
  } catch {
    /* best-effort */
  }
}

/** Keep the JSONL sink bounded: rotate to the last N lines once it grows past a cap. */
const TRIGGER_FILE_MAX_BYTES = 512 * 1024;
const TRIGGER_FILE_KEEP_LINES = 500;
function rotateTriggerFileIfLarge(path: string): void {
  try {
    if (!existsSync(path) || statSync(path).size <= TRIGGER_FILE_MAX_BYTES) return;
    const kept = readFileSync(path, 'utf8').trim().split('\n').slice(-TRIGGER_FILE_KEEP_LINES);
    writeFileSync(path, kept.join('\n') + '\n', 'utf8');
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
  const [rubricRes, mids, sessions] = await Promise.all([
    readLatestRubric(client, now).catch(() => ({ reads: [] as ScoutRubricRead[], newestMs: 0 })),
    fetchAllMids().catch(() => ({}) as Record<string, number>),
    listActiveSessions().catch(() => []),
  ]);
  const rubric = rubricRes.reads;

  // Marks only for coins the rubric covers (the scan universe).
  const coins = Array.from(new Set(rubric.map((r) => r.coin)));
  const marks: ScoutMarketRead[] = coins
    .map((c) => ({ coin: c, markPx: Number(mids[c]) }))
    .filter((m) => Number.isFinite(m.markPx) && m.markPx > 0);
  const markByCoin = new Map(marks.map((m) => [m.coin, m.markPx]));

  // Open paper positions across active sessions, with best-effort health.
  const positions: ScoutPositionRead[] = [];
  for (const s of sessions) {
    const open = await loadOpenPositions(s.id).catch(() => []);
    for (const p of open) {
      if (p.side === 'flat') continue;
      const coin = p.coin.toUpperCase();
      const markPx = markByCoin.get(coin) ?? p.avgEntryPx;
      const healthScore = await readLatestHealth(client, s.id, p.coin).catch(() => null);
      positions.push({
        coin,
        side: p.side,
        healthScore,
        unrealizedPnlUsd: 0, // not needed for triggers; the cycle computes it fresh
        stopPx: null, // no persisted stop in v1 → near-stop trigger inert (watch daemon + paper auto-exit cover risk)
        markPx,
      });
    }
  }

  // Freshness gate: don't act on a stale rubric (scan down) or empty marks (HL
  // unreachable). The cycle/daemon stand down rather than trade on bad data.
  const { degraded, reason: degradedReason, rubricAgeMs } = assessFeedDegradation(rubricRes.newestMs, marks.length, now);

  return { rubric, marks, positions, now, degraded, degradedReason, rubricAgeMs };
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

/** Append triggers as JSONL to the sink the scout session's Monitor watches. */
export function appendScoutTriggers(triggers: ScoutTrigger[], filePath = scoutTriggerFilePath()): void {
  if (triggers.length === 0) return;
  const lines = triggers.map((t) => JSON.stringify(t)).join('\n') + '\n';
  appendFileSync(filePath, lines, 'utf8');
  rotateTriggerFileIfLarge(filePath);
}

/**
 * Run one trigger cycle: gather → detect → append. Returns the next state (carry
 * it into the next call) + the triggers fired. NEVER trades.
 */
export async function runScoutWatchCycle(
  prev: ScoutState,
  cfg?: ScoutTriggerConfig,
  now: number = Date.now(),
  filePath = scoutTriggerFilePath(),
): Promise<{ triggers: ScoutTrigger[]; state: ScoutState; degraded: boolean; degradedReason: string | null }> {
  const input = await gatherScoutInputs(now);
  // STAND DOWN on a degraded feed: don't emit (and thus don't wake the model to
  // trade) on stale rubric or empty marks. Still advance state so the next good
  // cycle compares against the latest values, not a pre-outage baseline.
  if (input.degraded) {
    const { state } = detectScoutTriggers(input, prev, cfg);
    return { triggers: [], state, degraded: true, degradedReason: input.degradedReason };
  }
  const { triggers, state } = detectScoutTriggers(input, prev, cfg);
  appendScoutTriggers(triggers, filePath);
  return { triggers, state, degraded: false, degradedReason: null };
}
