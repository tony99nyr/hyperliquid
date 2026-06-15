---
name: advise-exit
description: >-
  Recommend a full or partial exit of the open Hyperliquid position with a
  health-engine rationale, and — after explicit user confirmation — execute a
  reduce-only order and resolve the thesis. Use when the user says "should I
  exit", "close the trade", "take profit", "cut it", "trim the position", "get
  me out", or acts on an exit recommendation. ACTION skill — it ALWAYS surfaces
  the proposed reduce-only order + rationale and REQUIRES an explicit "yes"
  before it places anything. It never auto-fires.
---

# advise-exit (ACTION — user confirms)

Single purpose: recommend an exit and, only on explicit confirmation, execute a
reduce-only order and resolve the hypothesis. **Nothing executes without the
user's explicit confirmation.**

## The hard principle

This skill loads the real open position, runs the health engine, builds a
recommended exit (full or partial) and the **reduce-only** `TradeIntent` that
closes that fraction, shows it, and only calls `executeIntent` after the user
confirms. Mode is transparent (paper now / live later). It NEVER places an order
on its own. A reduce-only intent can only shrink the position — never open or
flip.

## Protocol

1. Confirm the active session id, the coin, the entry price, (optionally) the
   stop, and the hypothesis id to resolve.
2. Run WITHOUT `--confirm` first to see the recommendation:
   `pnpm skill:advise-exit --session <id> --coin <COIN> --entry <px> --hypothesis <id> [--stop <px>]`
3. The script loads the position, runs health, and prints the exit
   recommendation (full / partial / none), the reduce-only order it would place,
   the health score / P(adverse) / alerts, and the live mode. If the
   recommendation is "none", it holds and stops.
4. Relay the recommendation to the user and ask for explicit confirmation.
5. ONLY on an explicit "yes", re-run with `--confirm yes` (or answer the
   interactive prompt with `yes`). The script then executes the reduce-only
   order, resolves the hypothesis (confirmed if the closed leg booked a gain,
   invalidated otherwise — full exits only), and writes an `analysis_log` row.
6. If a runner remains after a partial, suggest re-running `assess-trade-health`.

## Guardrails

- NEVER pass `--confirm yes` unless the user explicitly approved the exact exit
  you showed them.
- The exit intent is ALWAYS reduce-only.
- A partial exit leaves the hypothesis open; only a full exit resolves it.
