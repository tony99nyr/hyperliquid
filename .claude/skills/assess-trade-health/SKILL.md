---
name: assess-trade-health
description: >-
  Run the multi-timeframe health engine on the open Hyperliquid position and
  advise hold / trim / exit. Use when the user says "how's the trade", "check the
  position", "assess health", "should I hold", "is my position ok", or wants a
  status read on a live position. ADVISORY ONLY — it writes a health snapshot and
  recommends, but takes no action.
---

# assess-trade-health (advisory)

Single purpose: score the health of the open position and recommend hold / trim /
exit. **This skill never trades.**

## What it computes

Runs the composed health engine across 1d / 8h / 1h / 15m: a 0–100 health score,
P(continuation), P(adverse), and discrete alerts (bearish-divergence-1h,
stop-within-1-ATR, regime-flip-8h, decline-detected). Writes a `health_snapshots`
row so the cockpit HealthPanel live-renders it, then maps the result to a
discrete hold/trim/exit recommendation via the PURE recommender.

## Protocol

1. Confirm the active session id, the coin, the position side (long/short), the
   entry price, and (if set) the current stop price.
2. Run: `pnpm skill:assess-health --session <id> --coin <COIN> --side long --entry <px> [--stop <px>]`.
3. The script fetches candles (read-only), composes health, persists the
   snapshot, and prints score / probabilities / alerts / per-TF reads and the
   recommendation.
4. Relay the snapshot and the recommendation to the user.
5. If the recommendation is trim or exit, suggest running `advise-exit` — and
   remind the user they will confirm explicitly before anything executes.

## Guardrails

- Advisory only — no `executeIntent`, no orders. A recommendation to "exit" is a
  suggestion, not an action.
- Acting on an exit is `advise-exit`'s job, gated by explicit user confirmation.
