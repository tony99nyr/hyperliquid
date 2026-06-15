# ADR-0003 — Data-completeness gate + honest paper fills

Status: Accepted (Phase 0)

## Context

Two related integrity risks the research arc surfaced:

1. **Thin-data wallets graded clean (the $16M-live-martingale lesson).** A leader
   with page-capped or thin fill history can look like a clean grade-A trader
   when in fact there isn't enough data to judge — and following one down a
   martingale to liquidation is exactly the tail this project exists to avoid.

2. **Paper fills that drift from reality.** If the paper source matches against a
   stale order book (or models slippage too generously), paper P&L stops
   tracking real prices and the multi-week paper trial validates nothing.

## Decision

### Data-completeness gate

`analyze-traders` (Phase 1) MUST enforce an `INSUFFICIENT_HISTORY` gate:
page-capped / thin-data wallets can NEVER be graded a clean A. The gate is
enforced in BOTH the grading skill AND the scoring path, and is covered by a
regression test. The vendored `rated-wallets` dataset already carries risk
`flags` (e.g. `DISQUALIFIED`, `THIN_ALT_TRADER`, `NO_STOPS`) that the
copy-monitor analytics surface as alerts — the gate builds on that.

### Honest paper fills

`paperFill` (Phase 1) MUST:

- Fetch a **FRESH** `l2Book` snapshot per fill (never a cached/old book).
- Compute fill px/sz by walking the real book via the PURE
  `matchIntentAgainstBook()` — partial-fill on a thin book, respect limit price.
- Model fees from HL's **published maker/taker schedule** (documented when the
  fee model lands), not an optimistic constant.

The book-walk and the position/P&L math are pure and fixture-tested; only the
book fetch is I/O.

## Consequences

- The cockpit cannot present a thin wallet as safe — the human always sees the
  insufficiency.
- Paper P&L tracks real executable prices, so the paper trial is a real proxy
  for live (scored like a backtest with honest fills + a logged decision journal).
- Phase 2 hardens the gate against real wallet data and tunes the fee/slippage
  model against observed live fills.
