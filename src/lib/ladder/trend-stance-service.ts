/**
 * Trend-stance reader (I/O) — the cockpit's half of the cross-system bridge.
 *
 * Polls the iamrossi 8h trend system's READ-ONLY `GET /api/trading/stance`
 * (restored 2026-07-25 after the Base leverage-lane retirement; see
 * docs/handoffs/2026-07-25-hl-trend-ladder-lane-plan.md) and answers ONE
 * question for the trend-alert drafter + flip guard: is that system currently
 * BULLISH AND CONFIDENT on a coin it is actually holding?
 *
 * Contractually FAIL-OPEN toward iamrossi and FAIL-CLOSED toward drafting:
 * unreadable/unconfigured ⇒ null ⇒ no drafts happen (and the flip guard treats
 * null as "cannot verify", never as a flip). Short in-module cache — the stance
 * only changes on the 8h cron beat, so a 2-min TTL is generous.
 */

import 'server-only';
import { validateEnv } from '@/lib/env/env';

/** Mirror of the stance route's AssetStance (sanitized on ingest). */
export interface TrendStance {
  asset: string; // 'eth' | 'btc' from the wire, lowercased
  enabled: boolean;
  /** 'holding' = directionally LONG (that system is long-or-cash, never short). */
  position: 'holding' | 'cash';
  regime: string;
  regimeConfidence: number; // clamped 0..1
}

export interface TrendStanceSnapshot {
  generatedAtMs: number;
  fetchedAtMs: number;
  stances: TrendStance[];
}

/** The exact gate the retired leverage lane used (yield-actions.ts): bullish AND ≥ 0.7. */
export const TREND_BULLISH_CONF_MIN = 0.7;

const FETCH_TIMEOUT_MS = 5_000;
const CACHE_TTL_MS = 2 * 60_000;

let cache: { snapshot: TrendStanceSnapshot; atMs: number } | null = null;

export function isTrendStanceConfigured(): boolean {
  const env = validateEnv();
  return Boolean(env.IAMROSSI_STANCE_URL && env.IAMROSSI_STANCE_TOKEN);
}

/** Test hook — clears the in-module cache. */
export function clearTrendStanceCache(): void {
  cache = null;
}

const clamp01 = (x: unknown): number => {
  const n = Number(x);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
};

/* eslint-disable @typescript-eslint/no-explicit-any */
function sanitizeStance(raw: any): TrendStance | null {
  if (!raw || typeof raw !== 'object') return null;
  const asset = String(raw.asset ?? '').toLowerCase().slice(0, 8);
  if (!asset) return null;
  return {
    asset,
    enabled: raw.enabled === true,
    position: raw.position === 'holding' ? 'holding' : 'cash',
    regime: String(raw.regime ?? 'unknown').slice(0, 24),
    regimeConfidence: clamp01(raw.regimeConfidence),
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Fetch the current stance snapshot. Returns null when unconfigured, on any
 * network/HTTP/parse failure, or on a malformed payload — callers must treat
 * null as "unknown", never as "not bullish" or "flipped".
 */
export async function fetchTrendStance(now: number = Date.now()): Promise<TrendStanceSnapshot | null> {
  const env = validateEnv();
  if (!env.IAMROSSI_STANCE_URL || !env.IAMROSSI_STANCE_TOKEN) return null;
  if (cache && now - cache.atMs < CACHE_TTL_MS) return cache.snapshot;

  try {
    const url = `${env.IAMROSSI_STANCE_URL.replace(/\/$/, '')}/api/trading/stance`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${env.IAMROSSI_STANCE_TOKEN}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { ok?: boolean; generatedAt?: number; stances?: unknown[] };
    if (body.ok !== true || !Array.isArray(body.stances)) return null;
    const stances = body.stances.map(sanitizeStance).filter((s): s is TrendStance => s !== null);
    if (stances.length === 0) return null;
    const snapshot: TrendStanceSnapshot = {
      generatedAtMs: Number.isFinite(Number(body.generatedAt)) ? Number(body.generatedAt) : now,
      fetchedAtMs: now,
      stances,
    };
    cache = { snapshot, atMs: now };
    return snapshot;
  } catch {
    return null; // fail-open toward iamrossi, fail-closed toward drafting
  }
}

/** The stance for one asset (case-insensitive; 'ETH' matches 'eth'), or null. */
export function stanceFor(snapshot: TrendStanceSnapshot | null, asset: string): TrendStance | null {
  if (!snapshot) return null;
  const key = asset.toLowerCase();
  return snapshot.stances.find((s) => s.asset === key) ?? null;
}

/**
 * The drop-in equivalent of the retired leverage-entry gate, PLUS the
 * fully-allocated precondition it also had: the system must be bullish ≥ 0.7
 * AND actually holding the asset (it amplifies an expressed signal — it never
 * front-runs one). `enabled` guards against reading a paused system as a signal.
 */
export function isBullishConfident(stance: TrendStance | null): boolean {
  return (
    stance !== null &&
    stance.enabled &&
    stance.position === 'holding' &&
    stance.regime === 'bullish' &&
    stance.regimeConfidence >= TREND_BULLISH_CONF_MIN
  );
}
