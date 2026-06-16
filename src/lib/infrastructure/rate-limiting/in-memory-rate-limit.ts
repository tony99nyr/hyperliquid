/**
 * In-memory fixed-window rate limiter (PURE-ish: state + clock injectable).
 *
 * Guards the admin-PIN login route against online brute force (a numeric PIN is
 * otherwise guessable in seconds). Keyed on a client identifier (IP). Best-effort
 * only — process-local, resets on cold start — which is acceptable for a
 * single-operator cockpit; a Supabase-backed counter can replace it later.
 *
 * The window logic is exported PURE (`evaluateAttempt`) so it is fixture-testable
 * with an injected clock and no global state.
 */
const DEFAULT_MAX_ATTEMPTS = 8;
const DEFAULT_WINDOW_MS = 5 * 60_000; // 5 minutes

export interface RateLimitEntry {
  count: number;
  /** Epoch ms the current window started. */
  windowStart: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  /** Attempts remaining in the window after this one (0 when blocked). */
  remaining: number;
  /** The (possibly reset) entry to store back. */
  next: RateLimitEntry;
}

/**
 * PURE window evaluation: given the prior entry (or undefined), the current
 * clock, and limits, decide whether this attempt is allowed and return the entry
 * to persist. A window older than `windowMs` resets the count.
 */
export function evaluateAttempt(
  prior: RateLimitEntry | undefined,
  now: number,
  maxAttempts: number = DEFAULT_MAX_ATTEMPTS,
  windowMs: number = DEFAULT_WINDOW_MS,
): RateLimitDecision {
  const fresh = !prior || now - prior.windowStart >= windowMs;
  const windowStart = fresh ? now : prior!.windowStart;
  const priorCount = fresh ? 0 : prior!.count;

  if (priorCount >= maxAttempts) {
    return { allowed: false, remaining: 0, next: { count: priorCount, windowStart } };
  }
  const count = priorCount + 1;
  return {
    allowed: true,
    remaining: Math.max(0, maxAttempts - count),
    next: { count, windowStart },
  };
}

const store = new Map<string, RateLimitEntry>();

/**
 * Record + check an attempt for `key`. Returns the decision and persists the
 * updated window. Call once per login attempt; `allowed: false` means blocked.
 */
export function checkRateLimit(
  key: string,
  maxAttempts: number = DEFAULT_MAX_ATTEMPTS,
  windowMs: number = DEFAULT_WINDOW_MS,
): RateLimitDecision {
  const decision = evaluateAttempt(store.get(key), Date.now(), maxAttempts, windowMs);
  store.set(key, decision.next);
  return decision;
}

/** Clear a key's window (call on a successful login so a valid user isn't penalized). */
export function clearRateLimit(key: string): void {
  store.delete(key);
}

/** Test hook: wipe all windows. */
export function _resetRateLimits(): void {
  store.clear();
}
