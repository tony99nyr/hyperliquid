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
 *
 * Redis fast path (2026-11, Vercel Hobby Active-CPU cap): with IAMROSSI_STANCE_REDIS_URL
 * set, the reader GETs the producer's cache key straight from its Redis (a user that may
 * only GET that one key). The iamrossi NAS cron keeps the key warm, so a tick makes no
 * call to the iamrossi Vercel route. A miss or any Redis error falls back to the HTTP
 * route, which recomputes and rewrites the key. Both paths go through the same parse,
 * clean-up and age gate.
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
/** The producer's cache key (iamrossi stance-cache.ts, KV_KEYS.TRADING_STANCE_CACHE). */
export const STANCE_REDIS_KEY = 'trading:stance:cache';
const REDIS_TIMEOUT_MS = 3_000;
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

  // A Redis body that fails the parse or the age gate also falls back to HTTP.
  const snapshot =
    parseStanceBody(await readStanceFromRedis(env.IAMROSSI_STANCE_REDIS_URL), now) ??
    parseStanceBody(await fetchStanceOverHttp(baseUrl, token), now);
  if (snapshot) cache = { snapshot, atMs: now };
  return snapshot;
}

/**
 * GET the producer's cache key. Returns the parsed JSON body, or null on a miss, a
 * missing/invalid URL or any error (the caller then uses the HTTP route). One short-lived
 * connection per read: the cockpit reads at most once per 2-min module-cache window.
 */
let warnedPlainRedis = false;

async function readStanceFromRedis(url: string | undefined): Promise<unknown | null> {
  // TLS only: the stance feeds the flip guard (disarm authority), so a plain-text
  // connection would let an on-path attacker change it. A redis:// URL uses HTTPS instead.
  if (!url) return null;
  if (!url.startsWith('rediss://')) {
    if (!warnedPlainRedis) {
      warnedPlainRedis = true;
      console.warn('[trend-stance] IAMROSSI_STANCE_REDIS_URL is not rediss://: ignored, using HTTP');
    }
    return null;
  }
  let client: { destroy: () => void } | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const { createClient } = await import('redis');
    const c = createClient({ url, socket: { connectTimeout: REDIS_TIMEOUT_MS, reconnectStrategy: false } });
    c.on('error', () => {}); // a dropped socket must not crash the tick; the read below fails instead
    client = c;
    const raw = await Promise.race([
      c.connect().then(() => c.get(STANCE_REDIS_KEY)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('stance redis timeout')), REDIS_TIMEOUT_MS);
      }),
    ]);
    return typeof raw === 'string' && raw.length > 0 ? (JSON.parse(raw) as unknown) : null;
  } catch {
    return null; // fail over to HTTP
  } finally {
    clearTimeout(timer);
    try {
      client?.destroy();
    } catch {
      /* already closed */
    }
  }
}

async function fetchStanceOverHttp(baseUrl: string, token: string): Promise<unknown | null> {
  try {
    const url = `${baseUrl.replace(/\/$/, '')}/api/trading/stance`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      cache: 'no-store',
    });
    if (!res.ok) return null;
    return (await res.json()) as unknown;
  } catch {
    return null; // fail-open toward iamrossi, fail-closed toward drafting
  }
}

/**
 * Validate a stance body from either path. Null on a malformed or stale body.
 *
 * Staleness gate: the producer stamps generatedAt at COMPUTATION time (its Redis
 * payload cache writes it once and serves it for up to 60 min, busted post-trade and
 * on the 8h beat), so this measures real snapshot age. The 9h gate fires only on a
 * frozen proxy/replayed payload. It still can't see a paused producer whose upstream
 * candle store went stale (a candle-age field is the remaining gap). A missing/garbage
 * generatedAt is treated as unreadable (fail-closed).
 */
function parseStanceBody(raw: unknown, now: number): TrendStanceSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const body = raw as { ok?: boolean; generatedAt?: number; stances?: unknown[] };
  if (body.ok !== true || !Array.isArray(body.stances)) return null;
  const generatedAtMs = Number(body.generatedAt);
  if (!Number.isFinite(generatedAtMs)) return null;
  if (now - generatedAtMs > MAX_STANCE_AGE_MS) return null;
  const stances = body.stances.map(sanitizeStance).filter((s): s is TrendStance => s !== null);
  if (stances.length === 0) return null;
  return { generatedAtMs, fetchedAtMs: now, stances };
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
