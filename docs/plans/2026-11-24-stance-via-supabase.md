# Plan: the scout reads the iamrossi stance from Supabase

Status: DROPPED (Tony, 2026-11-25). The NAS warm already cut the route cost; see Review below. Do not re-propose without a new cost reason. Repos: tony99nyr/iamrossi (producer) and
tony99nyr/hyperliquid (reader). Both are direct-push repos.

## Goal

The hyperliquid cockpit (flip guard and trend-alert drafter, on Vercel) reads the iamrossi
trend stance from one Supabase row over HTTPS. Today it calls the iamrossi Vercel route
`/api/trading/stance`, which costs iamrossi Active CPU on the Hobby plan. The Redis fast
path that shipped dark today cannot run: the free Redis Cloud plan has no TLS, and Tony
keeps the free plan. This plan replaces that Redis path.

The safety contract does not change:

- Fail closed: no readable stance means no drafts, and the flip guard treats it as
  "cannot verify", never as a flip.
- A trade or another stance-changing event must invalidate the published stance before a
  reader can see the old one for long.
- The HTTP route stays as the fallback.

## Design

### Supabase (hyperliquid migration 0054)

- Table `trend_stance`, one row (`id smallint primary key check (id = 1)`):
  `payload jsonb` (null after a bust), `generated_at timestamptz` (from the payload),
  `published_at timestamptz` (database clock, set by the functions), `bust_seq bigint`.
- Table `trend_stance_secret`, one row: `secret_hash text` (sha256 hex of the publish
  secret). The hash goes in by hand in the SQL editor, never in git.
- RLS on for both tables, with no policies. Only the service role (the cockpit) reads.
- Three `security definer` functions with `set search_path = public`. `execute` is revoked
  from `public` and granted to `anon` only. Each one first checks the secret against
  `trend_stance_secret`, and raises on a mismatch.
  - `stance_begin(p_secret) returns bigint`: the current `bust_seq`.
  - `stance_publish(p_secret, p_seq, p_payload) returns boolean`: writes `payload`,
    `generated_at` and `published_at = now()` only where `bust_seq = p_seq`. It returns
    false when a bust came in between, and the caller then drops its write.
  - `stance_bust(p_secret) returns bigint`: `bust_seq = bust_seq + 1`, `payload = null`,
    `published_at = now()`.

Why a database sequence and not the iamrossi Redis epoch: the check and the write happen
in one statement. Vercel and NAS clocks never meet, and no re-read is needed.

Why `anon` plus a secret and not a key: every Supabase key that can write is equal to the
service role and opens the whole hyperliquid database. The secret opens only these three
functions.

### iamrossi (producer)

- New `src/lib/trading/services/stance-publisher.ts`. It calls the three functions through
  PostgREST (`POST /rest/v1/rpc/...`) with `fetch`, a 2 s timeout, and fail-soft
  behaviour. It is a no-op when its env is not set: `HL_STANCE_SUPABASE_URL`,
  `HL_STANCE_SUPABASE_ANON_KEY` and `HL_STANCE_PUBLISH_SECRET`.
- `bustStanceCache()` (stance-cache.ts) also calls `stance_bust`, after the Redis epoch
  write and DEL. It is still awaited, so every existing bust caller covers Supabase:
  real-trading-service, process-asset, portfolio-snapshot, and the execute, enable,
  trading-state and emergency-stop routes. The 2 s timeout bounds the added latency on
  the trade path.
- `stance-payload-service.ts`: before the compute, it calls `stance_begin` (in parallel
  with the Redis epoch read). After the Redis write and re-check, it calls
  `stance_publish` with that sequence. Both the route and the NAS warm use this service,
  so both publish.
- Env: Vercel production and the NAS cron-runner `.env`. GitHub Actions and the desktop
  need nothing: without the env, the publisher does nothing.

### hyperliquid (reader)

- `trend-stance-service.ts`: replace `readStanceFromRedis` with `readStanceFromSupabase`.
  It uses the service-role client the cockpit already has, with a 3 s timeout. Null
  payload, a row older than `MAX_PUBLISHED_AGE_MS = 40 min` (by `published_at`), or any
  error returns null, and the reader then uses the HTTP route. The same
  `parseStanceBody` (sanitising plus the 9 h `generated_at` gate) runs on both paths.
- Why 40 min: the NAS warm runs every 30 min after risk-monitor. 40 min allows one warm
  plus its compute time and some slack. The limit also bounds the damage of a lost bust
  (below).
- Remove `IAMROSSI_STANCE_REDIS_URL`, the `redis` dependency (if nothing else uses it) and
  the Redis tests. The HTTP fallback after a bust makes the iamrossi route recompute and
  publish, so the next reader gets the row again.

## Failure modes

| Case | Result |
|---|---|
| Supabase down | Reader uses HTTP; producer calls fail soft. Same as today. |
| `stance_bust` lost (timeout, network) | Pre-trade stance can stay readable until the row is 40 min old, or until the next publish. Same class as task p7 for Redis. A bust is usually followed by a warm in the same NAS run, which publishes a new stance anyway. |
| Compute races a bust | `stance_publish` returns false; no stale write. |
| Secret leaks | An attacker can publish a forged stance for up to 40 min, or bust the row (only forces HTTP). Rotate the hash in the SQL editor. The forged payload still goes through `parseStanceBody`. |
| NAS down | No warm. The row ages past 40 min; the reader uses HTTP. Same Vercel cost as before this plan. |

## Steps

1. hyperliquid: migration 0054 plus a SQL contract test in `pnpm test:sql` (publish
   wins, a publish after a bust loses, a wrong secret raises, `anon` cannot read the
   tables).
2. hyperliquid: reader change plus unit tests (fresh row, null payload, stale row, error,
   fallback to HTTP).
3. iamrossi: publisher plus tests (begin/publish sequence, bust call order, no-op without
   env, fail-soft, timeout).
4. /cross-review on both changes, `pnpm validate` in both repos.
5. Tony: apply migration 0054 in the Supabase SQL editor, then insert the secret hash.
   I give him the SQL and the secret (generated locally, never in git).
6. Tony: set the three `HL_STANCE_*` env vars in the iamrossi Vercel production env.
   NAS: add them to the cron-runner `.env` (needs Tony's approval for the NAS change).
7. Push iamrossi first (the publisher is a no-op until the env is set), then hyperliquid.
   `pnpm check:migrations` before the hyperliquid push.
8. Check: after the next NAS warm the row has a payload, `published_at` is fresh, and the
   iamrossi Vercel logs show fewer `/api/trading/stance` calls.

Rollback: remove the three env vars on iamrossi. The row then ages past 40 min, and the
reader uses HTTP.

## Out of scope

- Moving iamrossi's own `REDIS_URL` traffic to a TLS Redis service. A separate decision.
- Task p7 (Redis bust hardening) beyond what the 40 min limit gives.

## Review (2026-11-24, Claude opus and Codex high)

Main findings, to fold in if the plan goes ahead:

- Critical (Codex) / High (Claude): Supabase becomes a second invalidation channel. A lost
  `stance_bust` (Vercel routes start no warm afterwards; a NAS without the env busts
  nothing) leaves a pre-trade stance readable for about 42 min, while the Redis path is
  already correct. Needs bust retry, a Redis "bust pending" flag, a Discord alert, and the
  NAS env set before the Vercel env.
- High: the publish secret is lasting disarm authority (a holder can republish forever),
  not "up to 40 min". Option: ed25519-signed payload, or an HMAC POST to a hyperliquid
  route that writes with the service role.
- High: publish only when the compute cached (`cached === true`) and `stance_begin`
  succeeded; degraded reads look like `cash`.
- High (Codex): `bust_seq` alone does not order two computes from the same seq; add an
  ordered attempt token or a `generated_at >= existing` check.
- Medium: HTTP fallback may serve a stale Redis copy when the DEL failed; seed the row;
  add the SQL test to `test:sql`; revoke execute from `public, anon, authenticated` and
  grant only `anon`; `set search_path = ''`, built-in `sha256()`, secret table in an
  unexposed schema; rollback by SQL (null the row, revoke execute).

Cost check (Vercel request logs, 30 min window, 2026-11-25 02:30 to 03:00 UTC): 3 calls to
`/api/trading/stance`, now mostly Redis-cache hits after the NAS warm.
