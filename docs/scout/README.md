# Autonomous Paper Scout — runbook

The scout is an **autonomous, paper-only** opportunity finder + position manager
that runs on the home PC against your Claude **subscription** (no API key). It
exists to answer one question cheaply: **can Claude find enough trading edge to be
worth running?** — measured on a pre-registered bar before any real money.

## Architecture (the inverted loop + cheap-model cascade)

1. **Deterministic daemon (FREE, no model)** — `pnpm scout:watch` polls the latest
   rubric scores, fresh marks, and open paper positions every ~60s and appends
   *material triggers* to a JSONL file. Zero tokens. This is the fast layer.
2. **Cheap model = the scout (Sonnet)** — a Claude Code session running the
   `scout` skill, woken by a Monitor on the trigger file. It vets triggers and
   makes the clear paper calls. Cheap against the subscription allowance.
3. **Opus — rare escalation** — the scout spawns an Opus subagent only for
   ambiguous, high-stakes calls. Opus is otherwise your Tier-1 manual session +
   the weekly review.

## Launch (home PC, both run continuously)

```bash
# 0) one-time: TRADING_MODE must be paper (it's the default; do NOT set live)
#    optional: export SCOUT_TRIGGER_FILE=/path/to/trigger.jsonl

# 1) the FREE deterministic trigger daemon (its own terminal / tmux pane)
pnpm scout:watch

# 2) the scout session (a Claude Code session on SONNET), then tell it:
#    "run the scout"  → it invokes the `scout` skill and self-paces.
```

The scout drives itself via scheduled wake-ups + a Monitor on the trigger file.
It runs `pnpm scout:cycle` each wake to gather the snapshot, decides per
`.claude/skills/scout/SKILL.md`, and only on a setup that clears the bar runs
`pnpm scout:trade` (paper).

## Safety model

- **No real money, ever, from the scout.** `pnpm scout:trade` is hard-guarded by
  `assertScoutPaperMode` — it throws in live mode. Real trades go through the
  human approval popup (Tier-1), never the autonomous path.
- **Open paper positions are covered by these layers:** (a) the scout reviews
  every open position on every wake (risk before opportunity); (b) the crash-safe
  `pnpm watch` daemon monitors + writes health/alerts even if the scout session
  dies; (c) the manual Safe-Exit button; (d) **optionally** the deterministic
  auto-exit Layer-1 (`risk-exit-service.ts`, ADR-0007). That layer is
  mode-agnostic, so pointing a cron at `/api/cron/auto-exit` with
  `AUTO_EXIT_ENABLED=true` while the scout's session is the active one gives a
  real auto-close-when-scout-is-down floor for PAPER positions too (harmless
  rehearsal of the live path). With it off, a dead scout session leaves a paper
  position to the watch alerts + your manual Safe-Exit.

## Pre-registered success / kill bar (decide BEFORE looking at results)

Metric = **paper net P&L including modeled funding + slippage** (the paper fill
only models taker fee; `paper-funding-business-logic` adds funding-while-holding +
a ~5bps/leg latency penalty so the number isn't optimistic).

- **Checkpoint 1 (~2 weeks):** net-positive and not just churning fees
  (~9bps round-trip)? If it is clearly bleeding → **KILL.** (Same discipline that
  rejected the funding / copy-trading lanes.)
- **Graduation to live (~90 days):** net ≥ **~$1,000/mo-equivalent**, max
  drawdown **< 15%**, funding modeled. Only then consider the Phase-2 live seam
  (two gates: `TRADING_MODE=live` + a per-coin allowlist + human approval per trade).

$400/mo (electricity + subscription) is *breakeven* — the ~$1k/mo target is the
margin that survives the estimated 40–70% paper→real edge haircut.

## The learning loop

- Every paper trade writes a `hypotheses` row (the thesis); closing it resolves
  the hypothesis with the outcome. That + `fills`/`pnl` is the track record.
- Each cycle the scout reads its recent track record + `docs/scout/playbook.md`
  and applies the playbook's rules.
- `pnpm scout:review` (the `scout-review` skill, weekly / on-demand, Opus) scores
  the record and **curates the playbook** — the deliberate, non-recency-biased
  update step.
