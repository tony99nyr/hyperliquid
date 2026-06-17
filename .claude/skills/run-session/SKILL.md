---
name: run-session
description: >-
  Run a full active-loop trading session for a PICKED setup: open the session,
  analyze the market, propose an entry for the user's approval, and — only on
  approval — execute it, auto-start continuous monitoring, and arm the always-on
  Safe-Exit button. Then keep the position under management on a scheduled
  cadence, proposing an exit for the user's approval when warranted. Use when the
  user says "run a session", "trade this setup", "take ETH and manage it", "run
  the loop", "you watch it and tell me when to get out", or otherwise hands you a
  pick to run end-to-end. The ONLY manual touches are PICK and APPROVE — analyze,
  assess, refresh and advise are never user-invoked. It NEVER auto-fires: every
  entry and exit is gated on an explicit approval, and the Safe-Exit button is
  always available even if you (Claude) die.
---

# run-session (the active-loop capstone — PICK + APPROVE are the only manual touches)

This skill ties the cockpit together into ONE evolving terminal session. The
human PICKS a setup; you run everything else; the human's only other action is to
APPROVE (entry, then exit) in the cockpit popup — or hit the always-available
Safe-Exit button. **Nothing ever executes without an explicit approval.**

## The hard principles (never violate)

- **NO-AUTO-FIRE.** A trade fires ONLY when an approval popup is approved, or the
  user clicks Safe-Exit. The entry chain calls `executeIntent` strictly *after*
  `requireApproval` returns true; a reject/timeout aborts with nothing executed
  and no monitor started.
- **WATCH-ONLY monitor.** Monitoring is the non-agent `pnpm watch` daemon. It
  observes + writes health/pnl/alerts; it can NEVER place a trade (statically
  pinned). It survives you dying.
- **Safe-Exit always armed.** Each cycle you re-arm a fresh, smart reduce-only
  exit plan (`refresh-exit`). If you go offline, the panic button uses the last
  fresh plan, else a mechanical market reduce-only close. The user is never
  trapped.
- **Paper ↔ live seam untouched.** Execution flows through the one mode-branching
  seam. Mode is transparent (paper now / live later); you do not special-case it.

## Division of labor (READ THIS)

The work splits into two halves on purpose:

| Half | Who runs it | What |
| --- | --- | --- |
| **Deterministic entry chain** | the **script** (`pnpm skill:run-session`) | open session → analyze-market → build entry proposal → `requireApproval` (entry popup) → on approval `executeIntent` → start the watch daemon → arm the first Safe-Exit plan → print "session live, monitoring started". |
| **Ongoing judgment + wake cadence** | **you, Claude, at runtime** (this playbook) | between cycles you SLEEP via a scheduled wake-up, then each cycle re-assess health, re-arm Safe-Exit, and decide whether to propose an exit for approval. |

A script cannot run scheduled wake-ups or exercise trading judgment — so the
script does ONLY the deterministic entry chain and then HANDS OFF to you. The
cadence + the exit decision are yours, guided by this file. Do not try to fake a
loop inside the script.

## Step 1 — the deterministic entry chain (script)

Run with the user's pick:

```
pnpm skill:run-session --coin ETH [--side buy|sell] [--leader 0x..] \
  --risk <usd> --stop-frac <fraction> --thesis "…" [--limit <px>]
```

- `--side` is optional: omit it to take the direction from the multi-timeframe
  market read (a *neutral* read with no explicit side ABORTS — you must pick a
  direction; never guess).
- The script opens the session, logs the market read, builds the risk-based entry
  proposal, and raises the **entry approval popup**. Relay the proposal to the
  user; it executes ONLY when they approve. On approval it fills the entry, spawns
  the watch daemon (monitoring comes up the moment the trade executes — no manual
  `pnpm watch`), and arms the first Safe-Exit plan.
- If the user does not approve, the session stays open with no position and
  nothing fires.

## Step 2 — the ongoing management loop (you, on a cadence)

Once the script prints "session LIVE — monitoring started", YOU manage the
position until it closes. The watch daemon is already writing health/pnl/alerts
to the cockpit continuously; your job is the periodic JUDGMENT layer on top.

**The cadence.** Use scheduled wake-ups to sleep between cycles (e.g. every
10–20 minutes for an intraday hold; tighten to ~5 minutes near a stop/decision
level, loosen when calm). You decide the interval from volatility + how close the
position is to its stop or thesis target. Between wake-ups, do nothing — let the
non-agent daemon watch.

**Each wake-up cycle, run (NONE of these are user-invoked):**

1. `pnpm skill:refresh-exit --session <id> --coin <COIN> [--stop <px>]` — re-arm
   the smart Safe-Exit plan against the live position + book + health (MARKET when
   adverse/thin, LIMIT at the favorable side when calm + deep). This keeps the
   panic button fresh.
2. Read the latest health (refresh-exit persists a health snapshot; or run
   `pnpm skill:assess-health` for the full hold/trim/exit recommendation).
3. Decide: **hold** (sleep again), or **an exit is warranted**.

**When an exit is warranted**, build the exit proposal and gate it on approval —
do NOT auto-close:

```
pnpm skill:advise-exit --session <id> --coin <COIN> --entry <px> --hypothesis <id> [--stop <px>] [--force]
```

This raises the **exit approval popup** (a reduce-only order). On approval it
executes the reduce-only exit and resolves the thesis; on a full close, close the
session (`status → closed`) and stop the cadence. Use `--force` only when the
user has decided to leave but the engine reads HOLD — it still requires approval.

## Guardrails

- The ONLY manual touches are **PICK** (the initial setup) and **APPROVE** (entry,
  then exit). `analyze-market`, `assess-health`, and `refresh-exit` are yours to
  run automatically; never ask the user to invoke them.
- Re-arm Safe-Exit (`refresh-exit`) EVERY cycle so the dead-man's switch never
  goes stale while you hold.
- Never pass `--confirm yes` (or programmatically approve) unless the user
  explicitly approved the exact order you showed them.
- Every exit intent is reduce-only — it can only shrink/close, never open or flip.
- If monitoring failed to auto-start (the script warns), tell the user to run
  `pnpm watch` so the position is covered, then continue your cadence.

## What lives where

- `scripts/run-session.ts` — thin I/O; wires the real deps into the chain.
- `src/lib/cockpit/run-session-service.ts` — the dependency-injected entry-chain
  orchestration (open → analyze → approve → execute → monitor → arm), with the
  no-auto-fire ordering pinned by tests.
- `scripts/refresh-exit.ts` + `src/lib/trading/safe-exit-plan-business-logic.ts`
  — the smart Safe-Exit refresh you call each cycle.
- The manual skills (`open-position`, `advise-exit`, `analyze-market`,
  `assess-health`) still work standalone; run-session COMPOSES them, it does not
  replace them.
