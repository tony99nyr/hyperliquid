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

import { appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getServiceRoleClient } from '@/lib/cockpit/supabase-server';
import { fetchAllMids } from '@/lib/hyperliquid/hyperliquid-info-service';
import { listActiveSessions } from '@/lib/cockpit/session-service';
import { loadOpenPositions } from '@/lib/cockpit/fill-persistence-service';
import {
  detectScoutTriggers,
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

/** Read the newest rubric read per coin×side from the last ~2h of scans. */
async function readLatestRubric(client: SupabaseClient, now = Date.now()): Promise<ScoutRubricRead[]> {
  const since = new Date(now - 2 * 60 * 60 * 1000).toISOString();
  const { data, error } = await client
    .from('rubric_scores')
    .select('coin, side, opportunity, badge, computed_at')
    .gte('computed_at', since)
    .order('computed_at', { ascending: false })
    .limit(400);
  if (error) throw new Error(`scout-watch: rubric read failed: ${error.message}`);
  return pickNewestRubricReads((data ?? []) as RawRubricRow[]);
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

/** Gather all inputs for the pure detector. Fail-soft per source. */
export async function gatherScoutInputs(now: number): Promise<{
  rubric: ScoutRubricRead[];
  marks: ScoutMarketRead[];
  positions: ScoutPositionRead[];
  now: number;
}> {
  const client = getServiceRoleClient();
  const [rubric, mids, sessions] = await Promise.all([
    readLatestRubric(client, now),
    fetchAllMids().catch(() => ({}) as Record<string, number>),
    listActiveSessions().catch(() => []),
  ]);

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

  return { rubric, marks, positions, now };
}

/** Append triggers as JSONL to the sink the scout session's Monitor watches. */
export function appendScoutTriggers(triggers: ScoutTrigger[], filePath = scoutTriggerFilePath()): void {
  if (triggers.length === 0) return;
  const lines = triggers.map((t) => JSON.stringify(t)).join('\n') + '\n';
  appendFileSync(filePath, lines, 'utf8');
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
): Promise<{ triggers: ScoutTrigger[]; state: ScoutState }> {
  const input = await gatherScoutInputs(now);
  const { triggers, state } = detectScoutTriggers(input, prev, cfg);
  appendScoutTriggers(triggers, filePath);
  return { triggers, state };
}
