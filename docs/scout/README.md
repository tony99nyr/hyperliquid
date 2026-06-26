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

## What the scout trades today (decision model)

The honest current baseline — so the roadmap refactors from reality, not the
runbook's aspiration. All values from `data/rubric/rubric-v0.1.0.json`.

- **Universe:** ETH, BTC, SOL, HYPE only.
- **Edge hypothesis (directional):** Claude reasons over the deterministic
  per-coin×side **rubric** score = `regimeMultiplier × (0.45·leaders +
  0.20·carry + 0.35·micro)`:
  - **regime** — multiplier (floor 0.15), multi-TF trend (1d/8h/1h/15m weighted
    0.4/0.3/0.2/0.1), "confirmed" at ≥0.6 confidence.
  - **leaders (45%)** — net signed consensus of the top-10 tracked leaders'
    positions, freshness-decayed (τ=12h), dirty books ×0.4.
  - **carry (20%)** — funding APR on the side, saturates at ±15%.
  - **micro (35%)** — L2 imbalance within ±0.1% of mark, spread-penalized.
- **Kill-gates (any → NO-EDGE):** depth < $50k, reward:risk < 1.5, vol-contraction
  (ATR & BB both < 25th pctile = chop), room-too-tight.
- **Badges:** ≥70 GO (may act), 55–70 WATCH, < 55 or gated NO-EDGE (stand down);
  margin < 12 between sides → NO-EDGE.
- **Wake triggers (free daemon):** rubric NO-EDGE→GO crossing, score jump ≥15,
  price ≥0.6%/cycle or ≥1% vs a 4h anchor, and risk events (health < 35 or −15,
  within 0.4% of stop).
- **Levels / horizon:** entry ±0.25·ATR, **stop 1.5·ATR, target 3.0·ATR** (1h
  ATR) → multi-hour-to-intraday holds. Sized by `--risk`/`--stop-frac`.
- **Cost model in the track record:** 4.5 bps taker/leg + 5 bps slippage/leg
  (10 bps round-trip) + **signed** hourly funding over the hold.
- **Known weaknesses (the roadmap targets these):** the leader pillar is
  45%-weighted yet stale/lagged; funding is modeled static (no mean-reversion);
  the leaders/carry/micro pillars were never backtested (DATA-BLOCKED in
  `BACKTEST_FINDINGS.md`); the regime detector is unvalidated on HL perps; there
  is no thesis-invalidation exit. **Net: a directional bet on liquid majors —
  the lowest-edge corner — on signals our own backtests rate weak/unproven.**

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
- **Account circuit breaker.** Every cycle `scout:cycle` checks the scout's
  equity against a daily-loss / drawdown halt (`circuit-breaker`, migration
  0012). On a trip it sets `blockNewEntries` and `scout:trade` refuses new opens
  (exits still allowed); the breaker recommends but never auto-fires a flatten.
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
