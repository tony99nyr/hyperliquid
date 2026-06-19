# Live Auto-Exit (Layer 1) — design + safety contract

An **autonomous, exit-only safety net** for live positions left unattended: it can
**close** a position (reduce-only) when a hard risk condition is met, so you can
leave trades on overnight without watching them. This is a **deliberate, scoped
exception** to the cockpit's founding no-auto-fire rule.

> **Status:** designed (this doc). Build order below. NOT enabled until built,
> tested, polish-looped, and explicitly turned on via the kill-switch env.

---

## The one hard invariant: EXIT-ONLY

The auto-exit can **only reduce/close** an existing position. It can **never open,
add, or flip.** Opening exposure autonomously is out of scope, forever. The only
autonomous action is `reduceOnly: true` to flatten risk. (This is what makes the
exception acceptable: the worst it can do is take you *out* of the market.)

## Triggers (close when ANY fires)

Per open position, each watch cycle:

1. **Liquidation proximity** — liq price is within `LIQ_PROXIMITY_PCT` (e.g. 2.5%)
   of the mark. The most important overnight guard for leveraged positions: exit
   *before* HL liquidates you (which costs more than a clean close).
2. **Loss threshold** — position unrealized P&L is worse than `MAX_LOSS_USD` (a $
   floor) **or** `MAX_LOSS_PCT` of margin. A stop-loss you don't have to babysit.
3. **Unhealthy / too risky** — the health engine's score is below
   `MIN_HEALTH_SCORE` (e.g. 20) **or** a hard adverse signal fires (e.g.
   `regime-flip-8h` against the position with high P(adverse)). This is the
   "market turned, capital-preservation" call — the codification of "deem it too
   risky to continue." (Uses the **per-coin** health from #14.)

All thresholds live in a versioned config (manifest pattern), tunable per coin.

## Architecture — NAS detects, Vercel executes

The agent key (`HL_AGENT_PRIVATE_KEY`) lives **only on Vercel** and must stay
there. So detection and execution are split:

```
 NAS watch daemon (~18s, already running)        Vercel (has the agent key)
 ────────────────────────────────────────       ─────────────────────────────────
 per position: mark + liq + P&L + health    →    POST /api/cockpit/risk-exit (authed)
 run PURE shouldAutoExit(thresholds)               → re-verify the condition server-side
 if exit → call the Vercel endpoint                → reduce-only CLOSE via executeIntent
                                                    → log + notify
 + Vercel Cron (every few min) as a BACKUP detector → same endpoint (covers NAS downtime)
```

- **NAS = primary detector** (frequent, already computes all the inputs). It holds
  only the **admin secret** to call the endpoint — never the trading key.
- **Vercel = executor.** The endpoint **re-evaluates** the condition itself (never
  trusts the caller's "please exit") before signing — defense in depth.
- **Vercel Cron = backup detector** so a NAS outage doesn't leave positions
  unguarded (dual-scheduler, like the iamrossi risk-monitor).

## Safety mechanisms

- **Kill-switch:** `AUTO_EXIT_ENABLED` env (default OFF). Auto-exit does nothing
  unless explicitly on — and the endpoint refuses when off.
- **Exit-only enforced server-side:** the endpoint builds only a `reduceOnly`
  close for an *existing* position; it cannot construct an opening intent.
- **Re-verify before firing:** the Vercel endpoint recomputes liq/loss/health from
  fresh data; a stale or spoofed NAS trigger can't fire a close on its own.
- **Idempotency / no double-close:** a per-(session,coin) cooldown + the existing
  reduce-only flatten (closing an already-flat position is a no-op) prevent
  repeated fires.
- **Bounded by mode:** only acts when `TRADING_MODE=live`; never in paper.
- **Notifications:** every auto-exit writes the analysis log + a notification
  (Discord/email) with the trigger + the fill, so you see what happened.
- **Human override:** you can always close/Safe-Exit manually; the auto-exit is a
  floor, not a substitute.

## What it does NOT do

- Never opens / adds / flips (exit-only).
- No discretionary LLM reasoning in the loop — Layer 1 is deterministic thresholds
  (the health engine *is* the market read). Live Claude judgment is **Layer 2**
  (a separate, bigger build; see the autonomous-risk-manager vision).
- No position sizing decisions — it only flattens.

## Build order (each step: validate / lint / test, then polish-loop the whole)

1. **PURE `auto-exit-business-logic.ts`** — `shouldAutoExit({ liqDistancePct,
   pnlUsd, pnlPctOfMargin, healthScore, alerts, side }, thresholds) →
   { exit: boolean, reason: string | null }`. Fully unit-tested (each trigger +
   none + boundaries).
2. **Config** — versioned thresholds (`data/auto-exit/` manifest), per-coin.
3. **`/api/cockpit/risk-exit` route** — admin/cron-authed + same-origin; re-verify
   the condition from fresh data; kill-switch gate; reduce-only close via
   `executeIntent`; cooldown; log + notify. (Reuses the safe-exit close path.)
4. **NAS detector** — extend the watch loop (or a sibling) to call the endpoint on
   a trigger. Keep the watch daemon's no-direct-trade property (it calls HTTP,
   doesn't import the fill path).
5. **Vercel Cron backup** — `vercel.ts` cron hitting the same endpoint.
6. **Critical review** before enabling; then flip `AUTO_EXIT_ENABLED` on.

## Config knobs (initial defaults — tune)

| Knob | Default | Meaning |
|---|---|---|
| `AUTO_EXIT_ENABLED` | `false` | master kill-switch |
| `LIQ_PROXIMITY_PCT` | `2.5%` | close if liq within this of mark |
| `MAX_LOSS_USD` | (per your size) | close if uPnL below this |
| `MAX_LOSS_PCT` | `50%` of margin | close if uPnL below this % of margin |
| `MIN_HEALTH_SCORE` | `20` | close if health below this |
| `COOLDOWN_S` | `120` | min seconds between auto-exits per coin |
