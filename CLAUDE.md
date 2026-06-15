# HL Cockpit — Agent Guidelines

A **human + Claude collaborative trading cockpit for Hyperliquid**. The human
runs Claude skills to analyze HL traders + multi-timeframe candles, picks a setup,
and Claude manages trade health — **the human confirms every action.** A
phone-accessible web cockpit live-renders the work via Supabase realtime.
**Paper-first for weeks, then flip to live with ONE env var.** Standalone repo,
own Vercel deploy. Lives deliberately OUTSIDE the iamrossi autonomous system.

Read `docs/CONTEXT.md` for the domain language and `docs/adr/` for the locked
decisions before making architectural changes.

## Stack

Next.js 16 (App Router + RSC) · Panda CSS · TypeScript strict · Vitest ·
Supabase (Postgres + realtime) · recharts. Package manager: **pnpm**.

## Build & Validation

- **Validate (full)**: `pnpm validate` — type-check + tests + lint + build. **Run before every commit.**
- `pnpm type:check` · `pnpm test` · `pnpm test:lib` · `pnpm test:ui` · `pnpm lint` · `pnpm build`

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
src/types/{fill,position,cockpit,trading-core}.ts   # CanonicalFill, TradeIntent, Position, cockpit rows
src/lib/env/{mode,env}.ts                            # the ONE mode switch + zod env
src/lib/trading/                                     # the seam (fill-source, pnl, position-tracker)
src/lib/hyperliquid/                                 # HL info service (vendored) + orderbook-match (pure)
src/lib/strategy/                                    # VENDORED pure functions (regime/indicators/risk/validation)
src/lib/cockpit/{supabase-server,supabase-browser}.ts
src/lib/infrastructure/{auth,logging,config}/        # vendored admin-PIN + stubs
supabase/migrations/0001_init.sql                    # 8 tables + RLS + realtime publication
data/backups/wallet-rating/rated-wallets.json        # vendored dataset
docs/{CONTEXT.md, CODE_ORGANIZATION.md, adr/}
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
- **Phase 3**: implement `fill-source-live.ts` + `hyperliquid-exchange-service.ts`,
  flip `TRADING_MODE=live`. No other code changes.

## Skills (Phase 1d)

Each skill: one `.claude/skills/<name>/SKILL.md` (frontmatter + protocol) + one
`scripts/<name>.ts` thin entrypoint + (where it has decision logic) a tested
`src/lib/skills/<name>-business-logic.ts`. **The user decides and confirms every
ACTION.** Advisory skills (analyze-*, assess-*) never trade; action skills
(open-position, advise-exit) require an explicit `yes` (or `--confirm yes`) before
`executeIntent` — they never auto-fire. `analyze-traders` enforces the
**INSUFFICIENT_HISTORY gate**: a thin/page-capped wallet is capped at B and can
never be a clean A (the 0x418aa6 $16M-martingale lesson), pinned by tests.
