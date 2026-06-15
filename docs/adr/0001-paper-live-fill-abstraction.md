# ADR-0001 — The seamless paper ↔ live fill abstraction

Status: Accepted (Phase 0)

## Context

This is a human + Claude collaborative trading cockpit for Hyperliquid. The hard
requirement from the plan: **paper-trade for weeks, then flip to live by changing
ONE environment variable and nothing else.** Auto-copy-trading was rejected by
prior research (it inherits leaders' tails); the human is the stop the leaders
lack. We must be able to run paper sessions that are economically faithful, then
flip to live with zero code diff so the paper trial actually validates the live
system.

The failure mode to avoid: paper-vs-live `if` branches sprinkled across position
tracking, P&L, the UI, and analytics. That makes the paper trial worthless
(you're testing different code than you'll run live) and is a rich source of bugs.

## Decision

There is exactly ONE place in the codebase that branches on the trading mode:
`src/lib/trading/fill-source.ts::executeIntent`.

```
executeIntent(intent)
  ├─ TRADING_MODE === 'live' ? liveFill(intent) : paperFill(intent)   ← the ONLY branch
  ├─ persistFill(fill)            ← identical both modes
  └─ applyFillToPosition(fill)    ← identical both modes
```

Both `paperFill` and `liveFill` return the **same `CanonicalFill` shape**
(`src/types/fill.ts`). Downstream — position tracking, P&L (`pnl-business-logic.ts`,
PURE), persistence, UI — consumes only `CanonicalFill` and **cannot tell paper
from live**. `CanonicalFill.source` is recorded for audit but **MUST NEVER be
branched on** downstream.

- **paperFill** (Phase 1): fetch a FRESH `l2Book` (REST), run the pure
  `matchIntentAgainstBook()`, model fees from HL's schedule, `source: 'paper'`.
- **liveFill** (Phase 3): sign + submit an HL exchange order, map the
  confirmation to the same `CanonicalFill`, `source: 'live'`, populate
  `hlOrderId` / `hlRaw`.

`TRADING_MODE` is read in exactly one module (`src/lib/env/mode.ts`) and resolves
**fail-safe**: anything other than the literal string `live` is `paper`.

## Test that pins it down

`tests/lib/trading/mode-agnosticism.test.ts`: a paper-source fill and a
live-source fill with identical px/sz/coin/side fold to **identical** position +
P&L outcomes. The only differing fields are `source` and the live-only HL
metadata. If anyone adds a `fill.source ===` branch to the position/P&L path,
the two outcomes diverge and this test fails.

## Consequences

- Flip to live = set `TRADING_MODE=live` in the Vercel env. Git shows only the
  env change (verifiable in Phase 3).
- Paper P&L must use a FRESH book each fill or it drifts from reality (ADR-0003).
- The riskiest new I/O (HL EIP-712 signing) is isolated in
  `hyperliquid-exchange-service.ts` (Phase 3) behind the live branch.
