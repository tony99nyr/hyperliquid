# HL Cockpit — Agent Guidelines

A **human + Claude collaborative trading cockpit for Hyperliquid**. The human
runs Claude skills to analyze HL traders + multi-timeframe candles, picks a setup,
and Claude manages trade health — **the human confirms every action.** A
phone-accessible web cockpit live-renders the work via Supabase realtime.
Standalone repo, own Vercel deploy. Lives deliberately OUTSIDE the iamrossi
autonomous system.

> ## ⚠ STATUS — LIVE (updated 2026-06-29)
> **`TRADING_MODE=live`** (local `.env.local` AND production), `HL_NETWORK=mainnet` —
> real orders fire. **Armed Ladders are live + autonomous:** `LADDER_LIVE_ENABLED` and
> `LADDER_AUTOFIRE_ENABLED` are **ON in production**, and the watcher has already fired
> real money (first live ladder fire 2026-06-29). This is NOT paper trading.
>
> - **The only thing still paper** is the **scout** (a separate subsystem, hard-guarded
>   `assertScoutPaperMode`). "Paper-only" claims elsewhere in these docs refer to the
>   scout, or are stale pre-go-live history — trust this banner.
> - **Ladders fire on the PRODUCTION Vercel deployment**, not your local box. A ladder's
>   **`mode` field decides paper vs live**, and the firing deployment must match it. So:
>   create a real ladder with **`mode: 'live'`** — a `mode: 'paper'` ladder will NOT fire
>   on the live production watcher (mode-mismatch skip) and no paper watcher is running,
>   so it would just sit there. `LADDER_LIVE_ENABLED`/`LADDER_AUTOFIRE_ENABLED` are not in
>   local `.env.local`; they gate *production* firing. See
>   [LADDER_OPERATOR_RUNBOOK.md](docs/LADDER_OPERATOR_RUNBOOK.md).

Read `docs/CONTEXT.md` for the domain language and `docs/adr/` for the locked
decisions before making architectural changes.

## Stack

Next.js 16 (App Router + RSC) · Panda CSS · TypeScript strict · Vitest ·
Supabase (Postgres + realtime) · recharts + lightweight-charts · viem +
`@nktkas/hyperliquid` (live signing). Package manager: **pnpm**.

## Build & Validation

- **Validate (full)**: `pnpm validate` — type-check + tests + lint + build. **Run before every commit.**
- `pnpm type:check` · `pnpm test` · `pnpm test:lib` · `pnpm test:ui` · `pnpm lint` · `pnpm build`

### Client-side smoke — REQUIRED before pushing UI changes

`pnpm validate` does NOT load `/cockpit` in a real browser, so it can miss
uncaught client-side React crashes (e.g. the realtime "cannot add
'postgres_changes' callbacks … after subscribe()" crash that once shipped).
Before pushing any change touching the cockpit client, hooks, or realtime:

- **`pnpm smoke`** — builds + starts the app, authenticates with `ADMIN_PIN`,
  loads `/cockpit` in headless Chrome (Playwright), and FAILS on any uncaught
  page error or `console.error`. SKIPs (exit 0) where no browser is installed.
- The always-on guard is `tests/ui/realtime-resubscribe.test.tsx` (runs in
  `pnpm test`): it mounts `CockpitClient` + the realtime hook under the
  **enforcing** Supabase realtime mock (`tests/mocks/supabase-realtime.mock.ts`),
  which throws on `.on()`-after-`.subscribe()` and reuses same-topic channels —
  reproducing the browser crash class in jsdom. Keep that mock strict.
- `pnpm smoke:data` — the separate backend/data smoke (real Supabase + HL).

## The crux — seamless paper ↔ live (ADR-0001)

The hard requirement: flip paper→live by changing `TRADING_MODE` and nothing
else. Enforced by ONE rule:

- `src/lib/trading/fill-source.ts::executeIntent` is the **only** place that
  branches on mode. `paperFill` and `liveFill` both return a `CanonicalFill`
  (`src/types/fill.ts`); everything downstream (position tracker, P&L, UI)
  consumes only that and **must never branch on `fill.source`** (audit-only).
- `TRADING_MODE` is read in exactly one module: `src/lib/env/mode.ts` (fail-safe
  to `paper`).
- `src/lib/trading/pnl-business-logic.ts` is PURE: `applyFill`, `unrealizedPnl`,
  `avgEntry` — identical math regardless of source.
- The guarantee is pinned by `tests/lib/trading/mode-agnosticism.test.ts`: a
  paper fill and a live fill of identical economics fold to identical
  position/P&L. **Never weaken this test.**

## Two realtime transports (ADR-0002)

- **Market data** (price/book/trades): HL websocket → browser directly. Never stored.
- **Cockpit state**: Claude writes Supabase rows (server **service-role**) →
  realtime → browser (**anon**, RLS select-only). Service-role key is
  **server-only** — never import `supabase-server.ts` from a client component.

## Engineering conventions

- **Small single-purpose files, < 600 lines** (eslint `max-lines` enforces it;
  a few vendored strategy files are exempted). Split **pure `*-business-logic.ts`
  from I/O** — pure logic is fixture-tested with no mocks.
- **Unit-test every pure module.** Vendored modules arrive with their tests.
- **TypeScript strict, no `any`.**
- **Single-purpose Claude skills** (Phase 1): one `.claude/skills/*/SKILL.md` +
  one `scripts/*.ts` entry each.
- **Versioned-JSON config manifests** (Phase 1): `data/<area>/manifest.json` + `v*.json`.
- Harden later via `/polish-loop` + `/improve-codebase-architecture`.

## Layout

```
src/types/{fill,position,cockpit,trading-core,market}.ts  # CanonicalFill, TradeIntent, Position, cockpit rows
src/lib/env/{mode,env}.ts                            # the ONE mode switch + zod env
src/lib/trading/                                     # the seam (fill-source[-paper|-live], pnl, position-tracker,
                                                     #   safe-exit[-plan], leverage, risk-exit, paper fee/funding)
src/lib/hyperliquid/                                 # HL info/exchange service (vendored) + orderbook-match,
                                                     #   order/candle business-logic, rated-wallets, top-traders
src/lib/strategy/                                    # VENDORED pure functions (regime/indicators/risk/validation)
src/lib/health/                                      # multi-TF health engine (score + P(cont)/P(adverse) + alerts)
src/lib/rubric/                                      # deterministic opportunity scoring (pillars + kill-gates) — ADR-0006
src/lib/scout/                                       # autonomous PAPER scout (guard, trigger, cycle, review) — ADR-0005
src/lib/auto-exit/ + src/lib/risk/                   # Layer-1 auto-exit + account circuit-breaker — ADR-0007
src/lib/ladder/                                      # Armed Ladders — autonomous multi-rung exec (LIVE) ⚠ read src/lib/ladder/CLAUDE.md
src/lib/trader-watch/ + src/lib/watch/               # leader-position feed daemon + crash-safe position watcher
src/lib/backtest/                                    # PURE regime-core replay + significance (scripts/backtest*.ts)
src/lib/ws/                                          # HL websocket client + reducer + REST fallback (market data)
src/hooks/                                           # realtime hooks (useRealtime{Channel,Table} + resubscribe guard)
src/app/cockpit/{page,CockpitClient}.tsx + components/  # PIN-gated cockpit shell + panels (4 tabs)
src/lib/cockpit/{supabase-server,supabase-browser}.ts
src/lib/infrastructure/{auth,logging,config}/        # vendored admin-PIN + stubs
supabase/migrations/0001_init.sql … 0024_*.sql       # migrations (RLS + realtime publication; idempotent; 0023 = ladders)
data/{backups/wallet-rating/rated-wallets.json,auto-exit/}  # vendored dataset + versioned auto-exit thresholds
docs/{CONTEXT.md, CODE_ORGANIZATION.md, adr/, scout/, LIVE_*.md,
      ARMED_LADDER_ARCHITECTURE.md, LADDER_OPERATOR_RUNBOOK.md,
      LADDER_DESK_PLAYBOOK.md}  # ladder: design + operator runbook + desk sizing methodology
```

## Vendored from iamrossi

`src/lib/strategy/**` (indicators, confidence-calculator, market-regime-detector
+ cached/helpers/regime/confidence split, divergence/price-decline/recovery
detectors, regime-region-calculator, atr-stop-loss, risk-reward-validator —
entry point `validateSignal`), `src/lib/hyperliquid/{hyperliquid-info-service,
copy-monitor-analytics,rated-wallets-service}.ts` + `rated-wallets.json`,
`src/lib/infrastructure/auth/auth.ts` (PIN gate; Redis-session paths stripped),
`MiniChart.tsx`, and all their tests. Heavy iamrossi deps (Redis/Turso/viem)
were stripped/stubbed; the pure logic stands alone. See the Phase 0 report and
the comments at the top of each vendored stub module.

## Phase status

- **Phase 0 (DONE)**: scaffold, vendor, crux fill abstraction + mode-agnosticism
  test + pnl + orderbook-match, Supabase migration. Validate green.
- **Phase 1 (DONE)**: candle-service, paper fill source, cockpit Supabase writers,
  health engine, HL WS client, cockpit UI, **and the 6 single-purpose skills**
  (analyze-traders / analyze-market-timeframes / open-position /
  assess-trade-health / advise-exit / report-context-budget) — each a
  `.claude/skills/*/SKILL.md` + a thin `scripts/*.ts` entrypoint over a tested
  `src/lib/skills/*-business-logic.ts`. The two ACTION skills (open-position,
  advise-exit) surface the proposed order + rationale and require EXPLICIT user
  confirmation before `executeIntent`; advisory skills never act. Skill scripts
  run via `pnpm skill:*` (tsx, `tsconfig.scripts.json` stubs `server-only`).
  Validate green. The remaining gate to USE it is the live-readiness checklist
  (Supabase migration applied + env keys provisioned).
- **Phase 2 (DONE)**: the non-agent watch daemon (`pnpm watch`, `src/lib/watch/**`)
  — WATCH-ONLY, polls active sessions' open positions, writes health/pnl/alerts,
  survives Claude dying. No-trade guarantee pinned statically.
- **Phase 3 — active-loop capstone (DONE)**: session orchestration so the user's
  ONLY manual touches are PICK + APPROVE.
  - `pnpm skill:run-session` (`scripts/run-session.ts` +
    `src/lib/cockpit/run-session-service.ts`, dependency-injected) runs the
    **deterministic entry chain**: openSession → analyze-market → entry proposal →
    `requireApproval` (entry popup) → on approval `executeIntent` → start the watch
    daemon → arm the first Safe-Exit plan. The **wake cadence + exit judgment** are
    Claude's at runtime, documented in `.claude/skills/run-session/SKILL.md` (a
    script can't run scheduled wake-ups — don't fake it).
  - **Auto-monitor on fill**: `ensureWatchDaemon` (`src/lib/cockpit/watch-spawn.ts`)
    detached-spawns `pnpm watch` the moment a trade executes (from open-position
    AND run-session), guarded against double-spawn by a tmp lockfile pid-liveness
    check + a `pgrep scripts/watch.ts` fallback.
  - **Smart Safe-Exit refresh**: `buildBestExitPlan`
    (`src/lib/trading/safe-exit-plan-business-logic.ts`, PURE) chooses MARKET
    reduce-only when health is adverse/urgent OR the book is thin, else a LIMIT
    reduce-only at the favorable top-of-book side (min slippage). `pnpm
    skill:refresh-exit` arms it each cycle so the always-on panic button is backed
    by a fresh, smart plan (not just the mechanical market-close fallback).
  - No-auto-fire (execute only after an approved popup or the Safe-Exit click),
    watch-only, and the paper↔live seam are all preserved + test-pinned.
- **Phase 3b (live fill) — LIVE (was gated, flipped on)**: `fill-source-live.ts` +
  `hyperliquid-exchange-service.ts` (EIP-712 agent-key signing via
  `@nktkas/hyperliquid`) + `hyperliquid-order-business-logic.ts` (pure). **`TRADING_MODE=live`
  is set — real orders fire** (manual approvals + armed-ladder autonomous fires). The
  go-live sequence in `docs/LIVE_EXECUTION_RUNBOOK.md` (two-key model, testnet→mainnet)
  has been completed.
- **Phase 4 — autonomous PAPER scout (DONE)**: a self-driving paper-only
  opportunity finder + manager (`src/lib/scout/**`, `.claude/skills/scout` +
  `scout-review`, `docs/scout/`). The inverted loop: a FREE deterministic daemon
  (`pnpm scout:watch`) writes JSONL triggers → a cheap-model (Sonnet) scout
  session vets them and makes paper calls → rare Opus escalation. Hard-guarded
  PAPER-ONLY by `assertScoutPaperMode` — the boundary travels with the intent
  (`intent.origin === 'scout'` is refused live AT THE SEAM). Learns via
  `docs/scout/playbook.md` + a resolved-hypothesis track record; weekly
  `pnpm scout:review` (Opus) curates the playbook against a pre-registered
  kill/graduation bar. See **ADR-0005**.
- **Phase 5 — deterministic opportunity + risk layers (DONE)**:
  - **Rubric** (`src/lib/rubric/**`, `pnpm rubric`): per-asset×side scoring
    (regime-as-multiplier × leaders/carry/micro pillars, boolean kill-gates,
    portfolio beta cap) → `rubric_scores` → the cockpit OpportunityBoard.
    Advisory only. See **ADR-0006**.
  - **Auto-exit Layer-1** (`src/lib/auto-exit/**` detection + lock,
    `risk-exit-service.ts` the ONE exit-only execution site): a scoped,
    structurally-exit-only autonomous close on hard risk triggers. BUILT, shipped
    DISABLED (`AUTO_EXIT_ENABLED=false`). See `docs/LIVE_AUTO_EXIT.md`.
  - **Circuit-breaker** (`src/lib/risk/**`): account-level daily-loss / drawdown
    halt that BLOCKS new entries + recommends (never auto-fires) a flatten.
    Both risk layers preserve no-auto-fire. See **ADR-0007**.
  - **Trader-watch** (`pnpm trader-watch`): polls top-N rated leaders, diffs
    positions, writes the central `leader_positions`/`leader_actions` feed
    (stops per-leader HL hammering). Watch-only.
- **Phase 6 — perf + cockpit polish (DONE)**: Performance tab (equity = spot
  cash + perp, 30d curve, trade ledger, scout track record), live leverage
  adjustment + HL position reconciliation, URL-param tab/timeframe persistence,
  preview-action flow (`review-previews` skill), realtime egress trims.
- **Backtest/research suite** (`src/lib/backtest/**`, `scripts/backtest*.ts`,
  `scripts/analysis/perp-follow-study/**`): PURE regime-core replay with honest
  friction (fills/slippage/funding) for calibration, OOS, exit-policy, HTF, and
  copy-trade-gating studies. Findings in `docs/scout/BACKTEST_FINDINGS.md`.

## Skills (Phase 1d)

Each skill: one `.claude/skills/<name>/SKILL.md` (frontmatter + protocol) + one
`scripts/<name>.ts` thin entrypoint + (where it has decision logic) a tested
`src/lib/skills/<name>-business-logic.ts`. **The user decides and confirms every
HUMAN-LANE ACTION.** The roster (12):

- **Advisory** (never trade): `analyze-traders`, `analyze-market-timeframes`,
  `assess-trade-health`, `review-previews`, `report-context-budget`,
  `review-ladder` (pro-desk 0/10 RISK + UPSIDE scorecard for open/draft ladders +
  a build rubric; thesis pillar auto-scores from the rubric — never arms),
  `ladder-expectancy` (the outcome LEDGER + weekly per-setup expectancy review:
  KILL / HOLD / SIZE-UP / COLLECT against a pre-registered bar — never trades).
- **Human action** (require an explicit `yes` / `--confirm yes` before
  `executeIntent`; never auto-fire): `open-position`, `advise-exit`.
- **Orchestration**: `run-session` — the PICK→APPROVE active loop (entry popup,
  auto-monitor on fill, armed Safe-Exit); every entry/exit is still gated on an
  explicit approval.
- **Autonomous PAPER lane** (the ONE exception to the popup — auto-executes
  paper fills, hard-guarded against live): `scout`; `scout-review` (weekly,
  Opus, curates the playbook — NEVER trades). See ADR-0005.

`analyze-traders` enforces the **INSUFFICIENT_HISTORY gate**: a thin/page-capped
wallet is capped at B and can never be a clean A (the 0x418aa6 $16M-martingale
lesson), pinned by tests (ADR-0003).
