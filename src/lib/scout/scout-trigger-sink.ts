/**
 * ScoutTriggerSink — the ONE seam for Trigger persistence (C1, scout architecture
 * review 2026-07-03). Everything about where Triggers live — table vs file, format,
 * rotation, the consumer's seen-cursor — is behind append/recent/markConsumed.
 *
 * Two adapters (a REAL seam):
 *   - supabase `scout_triggers` (primary): visible from ANY box (kills the machine-local
 *     split-brain trap), carries `consumed_at` as the consumer cursor.
 *   - JSONL file (fallback): dev/offline; same shape, newline-delimited, size-rotated.
 *
 * Fail-soft on the WRITE side (a sink outage must never kill the Trigger daemon):
 * append tries the table, falls back to the file. The READ side prefers the table and
 * falls back to the file so a fresh checkout with no Supabase still works.
 */

import 'server-only';
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getServiceRoleClient } from '@/lib/cockpit/supabase-server';
import type { ScoutTrigger } from './scout-trigger-business-logic';

/** JSONL fallback sink path — overridable via SCOUT_TRIGGER_FILE (e.g. on the home PC). */
export function scoutTriggerFilePath(): string {
  return process.env.SCOUT_TRIGGER_FILE ?? join(homedir(), '.hl-cockpit-scout-trigger.jsonl');
}

/** A Trigger as the consumer reads it back (id/consumed only exist on the table adapter). */
export interface SinkTrigger extends ScoutTrigger {
  id: string | null;
  consumed: boolean;
}

/* ------------------------------ JSONL adapter ------------------------------ */

const TRIGGER_FILE_MAX_BYTES = 512 * 1024;
const TRIGGER_FILE_KEEP_LINES = 500;

/** Keep the JSONL sink bounded: rotate to the last N lines once it grows past a cap. */
export function rotateTriggerFileIfLarge(path: string): void {
  try {
    if (!existsSync(path) || statSync(path).size <= TRIGGER_FILE_MAX_BYTES) return;
    const kept = readFileSync(path, 'utf8').trim().split('\n').slice(-TRIGGER_FILE_KEEP_LINES);
    writeFileSync(path, kept.join('\n') + '\n', 'utf8');
  } catch {
    /* best-effort */
  }
}

/** Append to the JSONL fallback. Exported for tests; callers use appendTriggers. */
export function appendTriggersJsonl(triggers: ScoutTrigger[], path = scoutTriggerFilePath()): void {
  if (triggers.length === 0) return;
  rotateTriggerFileIfLarge(path);
  appendFileSync(path, triggers.map((t) => JSON.stringify(t)).join('\n') + '\n', 'utf8');
}

/** Tail the JSONL fallback (most recent N), tolerating garbage lines. */
export function recentTriggersJsonl(n: number, path = scoutTriggerFilePath()): SinkTrigger[] {
  try {
    if (!existsSync(path)) return [];
    const lines = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).slice(-n);
    const out: SinkTrigger[] = [];
    for (const l of lines) {
      try {
        const t = JSON.parse(l) as ScoutTrigger;
        if (t && typeof t.kind === 'string' && typeof t.coin === 'string') out.push({ ...t, id: null, consumed: false });
      } catch { /* skip garbage line */ }
    }
    return out;
  } catch {
    return [];
  }
}

/* ------------------------------ table adapter ------------------------------ */

function rowToSinkTrigger(r: Record<string, unknown>): SinkTrigger {
  return {
    id: r.id as string,
    kind: r.kind as SinkTrigger['kind'],
    coin: r.coin as string,
    side: (r.side ?? undefined) as SinkTrigger['side'],
    urgency: (r.urgency as SinkTrigger['urgency']) ?? 'info',
    detail: (r.detail as string) ?? '',
    at: Date.parse(r.at as string),
    consumed: r.consumed_at != null,
  };
}

/**
 * Append Triggers to the sink: table first, JSONL fallback on any error. Never throws —
 * a sink outage must not kill the Trigger daemon. Returns which adapter took the write.
 */
export async function appendTriggers(triggers: ScoutTrigger[]): Promise<'supabase' | 'jsonl' | 'none'> {
  if (triggers.length === 0) return 'none';
  try {
    const { error } = await getServiceRoleClient().from('scout_triggers').insert(
      triggers.map((t) => ({
        kind: t.kind,
        coin: t.coin.toUpperCase(),
        side: t.side ?? null,
        urgency: t.urgency,
        detail: t.detail,
        at: new Date(t.at).toISOString(),
      })),
    );
    if (error) throw new Error(error.message);
    return 'supabase';
  } catch {
    try {
      appendTriggersJsonl(triggers);
      return 'jsonl';
    } catch {
      return 'none';
    }
  }
}

/**
 * The consumer read: UNCONSUMED Triggers first (newest N), falling back to the JSONL
 * tail when the table is unreachable. `unconsumedOnly=false` reads the newest N
 * regardless of cursor (the "context" view).
 */
export async function recentTriggers(n: number, opts: { unconsumedOnly?: boolean } = {}): Promise<SinkTrigger[]> {
  try {
    let q = getServiceRoleClient().from('scout_triggers').select('*').order('at', { ascending: false }).limit(n);
    if (opts.unconsumedOnly ?? true) q = q.is('consumed_at', null);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return (data ?? []).map(rowToSinkTrigger).reverse(); // oldest-first for reading order
  } catch {
    return recentTriggersJsonl(n);
  }
}

/** Stamp the consumer cursor — these Triggers have been seen by a scout cycle and will
 *  not re-surface on the next wake. Best-effort (JSONL adapter has no cursor). */
export async function markTriggersConsumed(ids: Array<string | null>, now = Date.now()): Promise<void> {
  const real = ids.filter((x): x is string => typeof x === 'string' && x.length > 0);
  if (real.length === 0) return;
  try {
    await getServiceRoleClient().from('scout_triggers').update({ consumed_at: new Date(now).toISOString() }).in('id', real);
  } catch {
    /* best-effort — worst case the same triggers re-surface next wake */
  }
}
