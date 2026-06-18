# Wallet Selection & Rating — Spec (v0.1.0)

A decision-support tool (NOT an autonomous copier) to discover perp-trading wallets, score them on
**tail-discipline** criteria, grade them A–F across categories, and surface them in a UI for manual
follow/no-follow selection. Built on the lessons of the June 2026 copy-trading studies.

## The core thesis (why this config looks the way it does)

Every copy-trading study this cycle reached the same wall: **selecting on the visible track record
(win rate, realized P&L) selects the time-bombs IN**, because a no-stop averaging-down martingale
manufactures a near-perfect record by warehousing its losses as *unrealized* adverse positions. The
two-wallet Jupiter Perps study made it concrete — both wallets showed ~90–99% win rates and tiny
realized losses, yet one was sitting on a live −$33k / 54-add stack.

So this config **inverts the usual screen**: it selects on the things that *bound the tail*
(add depth, collateral-multiple cap, stop usage, liquidation distance, live-stack guard) and treats
**win rate as a red flag when extreme**, not a goal. The aim is to keep the disciplined-shallow
operators and auto-reject the deep-unbounded ones — i.e. operationalize "decide where we're willing
to take risk."

## Config sections (`configs/wallet-selection-vX.Y.Z.json`)

- `eligibility` — hard data cutoffs to be scorable (min cycles, activity, coverage). Not a grade.
- `riskDiscipline` — **PRIMARY**. Tail-bounding metrics, each with A/B/C/D thresholds + a `hardReject`.
- `performance` — **SECONDARY**. Profit factor, return on collateral, and a **bounded** win rate
  (`floor` to be real, `suspiciousAbove` to penalize martingale-grade win rates).
- `ratingRubric` — per-category weights + the A–F mapping; `copyabilityAtScale` (reserve needed to
  copy at ×N); and `autoDisqualifiers` (any TRUE ⇒ overall F regardless of category scores).
- `overall` — weighted average → letter + 0–10; `uiHints` — columns/badges for the browser UI.

Versioned via `manifest.json` (`active` points to the live file), same pattern as the trading configs.
Bump the version + changelog on every tweak; keep old versions for reproducibility.

## Validation against the known wallets (sanity check for any config change)

A correct config must produce:
- **Wallet 2** (`2EBVjX…`, 54-add / $71k live stack) → **AUTO-DISQUALIFIED** (open-position guard,
  collateral multiple, no stops + deep stack).
- **Wallet 1** (`6nKEtv…`, shallow but 14 adds / 61× multiple / 98.7% win, no stops) → **C/D, flagged**
  (`DEEP_AVERAGING`, `NO_STOPS`, `EXTREME_WIN_RATE`) — profitable-looking but not "follow at scale."

If a config edit grades either wallet more generously than that, it has loosened the tail screen — the
exact failure mode this tool exists to prevent.

## Pipeline (phases beyond this config)

1. **config** ✅ (this) — versioned selection/rating rubric.
2. **ingest** — discover wallets on a venue + pull each one's full cycle history (the data-access
   bottleneck; see below). Reuses the cycle-assembly + Borsh decoder from `scripts/analysis/friend-wallets/`.
3. **rate** — apply the active config → per-wallet category grades, badges, disqualifiers, JSON output.
4. **UI** — a `/tools/…` page to browse, sort, filter, and shortlist traders for manual selection.

## The honest constraint: data access

Discovery + full-history reconstruction over **public** Solana RPC throttles hard (we could not pull
even one wallet's full history in the study). A real "search and compare across the platform" tool
needs either a paid RPC/indexer (e.g. Helius), the friend's UI/data source (not yet shared), or an
accepted sampled-coverage mode. This gates phase 2 and should be decided before building the ingester.
