# Repo Health / DRY Audit — June 2026

A 3-agent sweep (DRY/reusable-functions, missing-test-cases, repo-healthiness) run
alongside the Layer-1 auto-exit polish-loop. **Overall grade: A−** — genuinely
healthy, safety-conscious codebase. Auto-exit-specific findings were fixed in the
polish round (commit f245a39); the **repo-wide** items below are captured here as
prioritized followups (none are blockers).

## Already fixed (polish round)
- `verifyCronBearer` extracted into `auth.ts` (killed the route→route import).
- Cron `CRON_SECRET` fallback; lock-release-on-all-paths; HL-authoritative close
  sizing; epsilon partial test; cron candidate cap.
- Doc path drift in `LIVE_AUTO_EXIT.md`.
- +57 tests (routes, scan, live-clearinghouse, partial/no-fill, bearer).

## DRY / reusable functions (repo-wide followups)

| # | Finding | Sites | Suggested fix | Risk/Effort |
|---|---|---|---|---|
| 1 | **Duplicate `num()` / number-coercion** (highest dup count) | `candle-service-business-logic.ts:40`, `hl-ws-reducer.ts:48`, `hl-rest-fallback.ts:32`, `hyperliquid-info-service.ts:163/168`, `cockpit-rows-business-logic.ts:207`, `rated-wallets-rows-business-logic.ts:78` | One `src/lib/util/number-coerce.ts` (`num`/`numOrNull`/`isFiniteNum`) | low / low |
| 2 | **Two canonical mark-price sources** (correctness, not just tidiness) | `risk-exit-service.ts` (`fetchAllMids[coin]`) vs `watch-service.ts` (`fetchMarkPrice`, 15m close + staleness) | one `getMark(coin, now)` both call (prefer the stale-aware candle path) | med / med |
| 3 | **reduce-only close composition duplicated** | `safe-exit/route.ts:107-135` + `risk-exit-service.ts` | extract `executeReduceOnlyClose(position, …)` core | med / med |
| 4 | **`severity:'danger'` alert pattern** | `risk-exit-service.ts` (`alert()`) + `safe-exit/route.ts:141` | `writeDangerAlert(sessionId, source, msg)` in analysis-log-service | low / low |
| 5 | **Route preamble repeated 8×** (auth→same-origin→rate-limit) | every cockpit route | `withCockpitAuth(handler, {rateKey, perMin})` wrapper (risk-exit's dual path is the exception) | med / med |
| 6 | **HL endpoint/network resolution** (testnet-blind hard-codes) | `candle-service.ts:25`, `hl-rest-fallback.ts:15`, `hl-ws-client.ts:20` vs `hlInfoUrlFor` | `hl-endpoints.ts` keyed off `HL_NETWORK` | low-med / med |
| 7 | **Scattered `process.env` reads** (bypass `validateEnv`) | `supabase-*.ts`, `performance-service.ts`, `hyperliquid-exchange-service.ts` | fold into env schema / getters | low / low-med |

**Top 3 to do:** #1 (pure win), #2 (auto-exit + its watcher should never disagree on
the mark), #3+#4 (keep the two exit paths in lockstep).

## Missing test cases (repo-wide, outside auto-exit)
- **`submitOrder` (`hyperliquid-exchange-service.ts`)** — the money-signing site:
  add `res.ok===false → throws` (a rejected order must surface, never be a silent
  no-fill) and malformed-key regex throw.
- **`nextNonce` monotonicity** — two calls same-ms → strictly increasing (a
  backwards/dup nonce = HL rejects = silently failed exit).
- **`buildMarketReduceOnlyClose` fraction clamp** — `fraction > 1` → full close;
  `fraction ≤ 0` → null.
- **`isSameOrigin`** — confirm direct coverage (it's the only CSRF guard on the
  admin auto-exit path).

## Repo healthiness
- **`risk-reward-validator.ts` (822 lines)** — over the 600-line rule (pure, so
  safe). Split along TYPES/scoring/threshold seams.
- **`market-regime-detector-helpers.ts` (706)** / `-cached.ts` (680) — already a
  split; lower-urgency second pass (`-cached` has 9 `!` clusters).
- **`!` clusters** in `volume-indicators.ts` (16) / `recovery-detector.ts` (14) —
  these feed the health engine the auto-exit trusts; replace with bounds guards.
- **Type safety:** 0 real `any`, 0 `@ts-ignore`, 1 boundary double-cast
  (`hyperliquid-exchange-service.ts:136`, the HL action payload before signing —
  acceptable SDK boundary).
- **Migrations** 0001–0008 sequential + idempotent; `vercel.json` valid.
