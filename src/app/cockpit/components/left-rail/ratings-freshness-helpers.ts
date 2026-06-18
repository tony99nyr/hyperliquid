/**
 * PURE helpers for the Top-Traders rail "ratings freshness" indicator.
 *
 * The rail rows come from `data/backups/wallet-rating/rated-wallets.json`, which
 * the weekly re-rank pipeline (iamrossi `weekly-rerank.sh`) regenerates and
 * publishes. These helpers turn the dataset's `generatedAt` into a small, honest
 * "when were these ratings built / are they stale" surface.
 *
 * DETERMINISTIC BY DESIGN (no hydration mismatch): `formatRatingsDate` formats
 * straight from the ISO date's UTC Y-M-D with a fixed month table — it never
 * touches the runtime timezone/locale or `Date.now()`, so the server-rendered and
 * client-hydrated text always match. Staleness (the only "now"-dependent part) is
 * computed SERVER-SIDE via `buildRatingsFreshness` in the force-dynamic cockpit
 * page and passed to the rail as a plain prop — so the client render stays pure
 * (no `Date.now()`/effect in the component).
 */

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

/** Weekly cadence → ratings older than this many days mean a run was missed. */
export const RATINGS_STALE_DAYS = 10;

const DAY_MS = 86_400_000;

/**
 * The rail's freshness prop, built ONCE on the server (the cockpit page is
 * `force-dynamic`, so it re-renders per request and knows "now"). Computing
 * staleness server-side keeps the client render pure — no `Date.now()` in the
 * component, so no SSR/hydration mismatch and no setState-in-effect.
 */
export interface RatingsFreshness {
  /** ISO timestamp the dataset was generated (null if unknown). */
  generatedAt: string | null;
  /** Whether the ratings are overdue relative to the weekly cadence. */
  stale: boolean;
}

/**
 * Build the freshness prop from the dataset `generatedAt` + the current time.
 * `now` defaults to `Date.now()` HERE (a plain function, not a component) so the
 * RSC caller invokes it without an impure `Date.now()` in its render body; tests
 * pass `now` explicitly for determinism.
 */
export function buildRatingsFreshness(
  generatedAt: string | null | undefined,
  now: number = Date.now(),
): RatingsFreshness {
  return { generatedAt: generatedAt ?? null, stale: isRatingsStale(generatedAt, now) };
}

/**
 * Format the ratings `generatedAt` as a stable absolute date, e.g. "Jun 15 2026".
 * Parses the leading `YYYY-MM-DD` of the ISO string directly (UTC), so it is
 * timezone/locale-independent and safe to render during SSR. Returns "unknown"
 * for null/missing/unparseable input.
 */
export function formatRatingsDate(generatedAt: string | null | undefined): string {
  if (!generatedAt) return 'unknown';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(generatedAt);
  if (!m) return 'unknown';
  const year = m[1];
  const monthIdx = Number(m[2]) - 1;
  const day = Number(m[3]);
  if (monthIdx < 0 || monthIdx > 11 || day < 1 || day > 31) return 'unknown';
  return `${MONTHS[monthIdx]} ${day} ${year}`;
}

/**
 * True when the ratings are older than `maxDays` (default `RATINGS_STALE_DAYS`)
 * relative to `now` (epoch ms). Null/missing/unparseable `generatedAt` counts as
 * stale (we can't prove freshness). `now` is injected so this stays pure/testable;
 * production callers go through `buildRatingsFreshness` server-side (never SSR-render
 * `Date.now()` in the component).
 */
export function isRatingsStale(
  generatedAt: string | null | undefined,
  now: number,
  maxDays: number = RATINGS_STALE_DAYS,
): boolean {
  if (!generatedAt) return true;
  const t = Date.parse(generatedAt);
  if (!Number.isFinite(t)) return true;
  return now - t > maxDays * DAY_MS;
}
