# ADR-0007 — Risk layers: auto-exit + circuit-breaker (no-auto-fire preserved)

Status: Accepted (Phase 5)

## Context

The cockpit's founding rule is **no auto-fire** — a human approves every order.
But two risk gaps that rule leaves open:

1. **A leveraged position left unattended overnight** can drift toward
   liquidation while no one is watching. The manual Safe-Exit button only helps
   if a human is present.
2. **A correlated cluster move** can quietly flatten the whole book — per-trade
   stops protect single positions but nothing protects the *account*.

Closing these without breaking no-auto-fire requires drawing the exception
extremely narrowly, and keeping the account brake advisory.

## Decision

Two independent risk layers, each structurally constrained.

### Auto-exit (Layer 1) — a scoped, structurally EXIT-ONLY exception

An autonomous safety net that can **close** (reduce-only) an unattended position
on a hard risk trigger. The one hard invariant: it can **only reduce/close —
never open, add, or flip.** Enforced structurally:

- The intent is built ONLY by `buildMarketReduceOnlyClose(position, …)` (the
  same pure fn the Safe-Exit button uses), which derives the opposite side from
  the **live** position and hard-codes `reduceOnly: true`. The caller supplies
  only a `(sessionId, coin)` candidate — never a side, size, or "open." Worst
  case is "flattened out of the market."
- **Detect anywhere, execute in ONE place**: `src/lib/auto-exit/**` is
  execution-free (detection + config + lock only, pinned by a static no-execute
  test); `risk-exit-service.ts::performRiskExit` is the single exit-only firing
  site. It **re-verifies** the trigger from fresh data server-side before signing
  (never trusts the caller), then rides the same `executeIntent` seam as every
  trade (so it's mode-agnostic — ADR-0001).
- **Triggers**: liquidation-proximity (loss side only), loss threshold
  (USD / %-of-margin / margin eroded), unhealthy (health score / hard adverse
  alert). Fail-safe on bad data: a non-finite critical input skips that trigger
  and raises a danger alert rather than silently disabling all of them.
- **Concurrency**: an atomic per-`(session,coin)` lock (`auto_exit_locks`,
  partial unique index → exactly one active lock). An unknown-outcome fire
  (the order may have filled before the response was lost) HOLDS the lock until
  expiry so a blind retry can't double-close.
- **Shipped DISABLED** behind `AUTO_EXIT_ENABLED` (default off). Detail +
  enable checklist in `docs/LIVE_AUTO_EXIT.md`. Honest limit: a ~5-min cron +
  HTTP hop + IOC cannot beat a fast cascade — it's a *gradual-drift* backstop,
  not a liquidation preventer.

### Circuit-breaker — account brake that GATES, never fires

`src/lib/risk/circuit-breaker-business-logic.ts` (PURE) evaluates account equity
(paper: starting + realized + unrealized; live: clearinghouse value) against two
thresholds:

- **Daily loss** ≥ `maxDailyLossPct` (default 5% of day-start equity) → block
  new entries until the next UTC day.
- **Drawdown from peak** ≥ `maxDrawdownPct` (default 15%) → block new entries +
  **recommend** a flatten.

Crucially it **never auto-fires a trade** — it sets `blockNewEntries` (the entry
path respects it) and *recommends* a flatten (executed by the existing exit
machinery / human). `rollCircuitBreakerState` lifts the peak and re-anchors
day-start equity at the first reading of a new UTC day. Deterministic,
fixture-tested; the service persists state.

## Consequences

- No-auto-fire is preserved end-to-end: the circuit-breaker only *gates and
  recommends*; the auto-exit is the single narrow, opt-in, structurally
  exit-only exception, and even it can only ever flatten — never take on risk.
- Both layers are deterministic-threshold only (no LLM in the loop); the health
  engine is the market read. Discretionary live judgment is a separate, larger
  Layer-2 build.
- Because auto-exit rides the same seam, enabling it in paper is a harmless
  rehearsal of the exact live path (ADR-0001).
