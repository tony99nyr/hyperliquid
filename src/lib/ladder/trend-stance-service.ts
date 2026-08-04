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
 * only changes on the 8h cron beat (or when that system trades), and the 2-min
 * TTL is kept deliberately TIGHT for the flip guard's disarm latency, not for
 * cost: since 2026-08 the producer serves a Redis-cached payload (its
 * stance-cache.ts, busted post-trade and on the cron beat), so each fetch here
 * is cheap for it — do not widen this TTL to "save" the producer.
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
/** A snapshot older than one 8h signal beat + grace is a FROZEN endpoint, not a
 *  stance — treat as unreadable (draft nothing; the flip guard can't verify). */
const MAX_STANCE_AGE_MS = 9 * 60 * 60 * 1000;

let cache: { snapshot: TrendStanceSnapshot; atMs: number } | null = null;

export function isTrendStanceConfigured(): boolean {
  const env = validateEnv();
  // Token length is enforced HERE (route contract: min 16), not in the zod schema —
  // a too-short optional var must degrade to "unconfigured", never throw inside
  // validateEnv() and take unrelated routes (incl. the fire path) down with it.
  return Boolean(env.IAMROSSI_STANCE_URL && (env.IAMROSSI_STANCE_TOKEN?.length ?? 0) >= 16);
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
    // Charset-whitelisted: regime reaches Discord messages + the analysis log, and
    // a compromised feed must not smuggle markdown/newlines through it.
    regime: String(raw.regime ?? 'unknown').toLowerCase().replace(/[^a-z_-]/g, '').slice(0, 24) || 'unknown',
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
  const baseUrl = env.IAMROSSI_STANCE_URL;
  const token = env.IAMROSSI_STANCE_TOKEN;
  if (!baseUrl || !token || token.length < 16) return null; // same bar as isTrendStanceConfigured
  if (cache && now - cache.atMs < CACHE_TTL_MS) return cache.snapshot;

  try {
    const url = `${baseUrl.replace(/\/$/, '')}/api/trading/stance`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { ok?: boolean; generatedAt?: number; stances?: unknown[] };
    if (body.ok !== true || !Array.isArray(body.stances)) return null;
    // Staleness gate — since 2026-08 the producer stamps generatedAt at
    // COMPUTATION time (its Redis payload cache writes it once and serves it
    // for up to 15 min, busted post-trade and on the 8h beat), so this now
    // measures real snapshot age instead of response time. In practice the
    // producer's setEx TTL bounds age at ~15 min, so this 9h gate only fires
    // on a frozen proxy/replayed payload. It still can't see a paused producer
    // whose upstream candle store went stale — the recompute would stamp fresh
    // over stale candles (a candle-age field is the remaining gap).
    // A missing/garbage generatedAt is treated as unreadable (fail-closed).
    const generatedAtMs = Number(body.generatedAt);
    if (!Number.isFinite(generatedAtMs)) return null;
    if (now - generatedAtMs > MAX_STANCE_AGE_MS) return null;
    const stances = body.stances.map(sanitizeStance).filter((s): s is TrendStance => s !== null);
    if (stances.length === 0) return null;
    const snapshot: TrendStanceSnapshot = { generatedAtMs, fetchedAtMs: now, stances };
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
