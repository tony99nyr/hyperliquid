---
name: open-position
description: >-
  Construct and (after explicit user confirmation) execute a new Hyperliquid
  position for a user-chosen setup, then record the thesis. Use when the user
  says "open a position", "go long/short", "enter ETH", "buy/sell <coin>", "take
  this setup", or otherwise decides to enter a trade. ACTION skill — it ALWAYS
  surfaces the proposed entry/size/stop + rationale and REQUIRES an explicit
  "yes" from the user before it places anything. It never auto-fires.
---

# open-position (ACTION — user confirms)

Single purpose: turn a user-chosen setup into a confirmed trade. Risk-based
sizing, an explicit stop, a recorded thesis. **Nothing executes without the
user's explicit confirmation.**

## The hard principle

This skill proposes, then waits. It builds the `TradeIntent` (size chosen so
hitting the stop loses ~`riskUsd`), shows the full rationale, and only calls
`executeIntent` after the user confirms. Mode is transparent: paper now, live
later (the same intent, the same path — flip is one env var). It NEVER places an
order on its own.

## Protocol

1. Gather the setup with the user: coin, side (buy/sell), intended entry price,
   dollar risk budget, stop distance (as a fraction, e.g. 0.05 = 5%), an optional
   limit price, and the **thesis** (what they're betting on — it becomes the
   tracked hypothesis).
2. Run WITHOUT `--confirm` first to see the proposal:
   `pnpm skill:open-position --session <id> --coin <COIN> --side buy --entry <px> --risk <usd> --stop-frac <frac> --thesis "<thesis>" [--limit <px>]`
   (omit `--session` and the script opens a new session in the current mode.)
3. The script prints the PROPOSAL: size, stop, notional, dollar risk, rationale,
   and the live trading mode. If it prints WARNINGS it refuses to execute — fix
   the inputs.
4. Relay the proposal to the user verbatim and ask for explicit confirmation.
5. ONLY on an explicit "yes", re-run with `--confirm yes` (or answer the
   interactive prompt with `yes`). The script then calls `executeIntent`, records
   the hypothesis, and writes an `analysis_log` row.
6. Hand off to `assess-trade-health` to begin monitoring.

## Guardrails

- NEVER pass `--confirm yes` unless the user explicitly approved the exact
  proposal you showed them.
- If the proposal has warnings, do not execute — re-propose.
- The opening intent is never reduce-only.
