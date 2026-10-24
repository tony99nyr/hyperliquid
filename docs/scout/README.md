# Autonomous Paper Scout — runbook

> **Status:** paper-only and running. History: the consumer was dead from ~Jun 24 to the
> 2026-07-03 repair (Supabase sink + headless consumer; see ADR-0005 addendum), and since
> Jul 17 the consumer runs embedded in `scout:watch`. `scout:review` has run regularly since
> 2026-07-28 (11 rows in `scout_reviews` by 2026-10-19), now inside the `desk-retro` skill.

The scout is an **autonomous, paper-only** opportunity finder + position manager
that runs on the office box against your Claude **subscription** (no API key). It
exists to answer one question cheaply: **can Claude find enough trading edge to be
worth running?** It is measured on pre-registered bars before any real money.

This README is the canonical home for the scout architecture. ADR-0005 is the
decision record.

## Architecture (one supervised process + cheap-model cascade)

1. **Deterministic producer (FREE, no model).** `pnpm scout:watch` polls the latest
   rubric scores, fresh marks, and open paper positions (every 120s by default) and
   writes *material triggers* to the Supabase `scout_triggers` table (any-box
   visibility, `consumed_at` cursor; JSONL is the offline fallback). Zero tokens.
2. **Embedded consumer (Sonnet, headless).** Every `SCOUT_CONSUMER_INTERVAL_MIN`
   (default 30; a shorter floor when an act-class trigger is pending) `scout:watch`
   spawns `scripts/scout-headless.sh`: `scout:cycle --json` → `claude -p` (Sonnet) →
   `scout:trade --from-json`, strict-validated by `parseScoutDecision`. Liveness is the
   `scout_heartbeat` row `source='scout-cycle'`. **Run ONE consumer only:** do not add a
   separate `scout-headless.sh` cron next to the daemon, because two consumers can both
   open on the same directive.
3. **Opus: rare escalation + the weekly review.** The interactive `scout` skill session
   still works for a manual run, but it is not the main path.

Supervision and the paper-mode pins: `services/scout-watch/README.md`.

## Lanes

Every scout open must carry a lane on `REGISTERED_LANES`, and a lane on `KILLED_LANES`
is refused (`src/lib/scout/scout-execution-guard.ts`; that file is the truth).
At 2026-10-24:

- **Registered:** `htf-trend`, `compression-straddle` (its KILL is pending the Monday
  retro), `breakdown-short` / `reclaim-long` (rubric crossing), and the passive
  benchmarks `vault` (HLP) and `carry`.
- **Killed:** `directional`, `reversion`, `trend-follow`, `leader-follow`.

`pnpm scout:lanes` (on the NAS tick) persists per-lane scorecards to `lane_scorecards`;
the cockpit Scout tab reads them. Env knobs for the benchmarks:
`SCOUT_{VAULT,CARRY}_{LOOKBACK_DAYS,NOTIONAL_USD,BAR_USD}`.

## What the directional lane traded (historical: the lane is KILLED)

Kept as the record of the original decision model. All values from
`data/rubric/rubric-v0.1.0.json`.

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

## Launch

Start `scout:watch` under its supervisor (`services/scout-watch/README.md`). It runs the
producer, the embedded consumer and the prod-cron poker. Paper mode is pinned by the
start script and the systemd unit, not by `.env.local`.

The optional `SCOUT_HTF_DETERMINISTIC=true` switch moves `htf-trend` entries to
the daemon. It defaults off. The daemon scans completed daily candles every 15
minutes and calls the existing paper-only `scout:trade` executor. The headless
model cannot open this lane while the switch is on. Set
`SCOUT_HTF_VETO_ENABLED=true` to ask the model for a veto before each entry.
The veto needs a concrete reason, which the daemon logs in `scout_decisions`.
The `hypotheses.rule_version` field separates daemon entries from earlier
model entries. Apply migration 0051 before enabling the switch.

For a manual session instead, open a Claude Code session on Sonnet and say "run the
scout" (the `scout` skill). Do not leave a manual session running beside the embedded
consumer.

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
  dies; (c) the manual Safe-Exit button; (d) the scout's own exit enforcement in
  `scout:watch`. The auto-exit Layer-1 (ADR-0007) does NOT cover paper: it scans
  LIVE sessions only.

## Pre-registered bars (decide BEFORE looking at results)

The numbers live in one place each; do not restate them here:

- **Per-lane kill / graduation bars** (these decide each lane's verdict):
  `data/scout/lane-bars-*.json`, with the rationale in `docs/scout/PREREGISTRATION_*.md`.
- **Account-level aggregate bar** (monthly net and drawdown ceiling):
  `src/lib/scout/scout-review-business-logic.ts`. It scores the whole book; it does not
  override a lane verdict.

Metric = **paper net P&L including modeled funding + slippage**. Graduating to live is
never automatic: it needs the bar AND the separate live gates (ADR-0005).

## The learning loop

- Every paper trade writes a `hypotheses` row (the thesis); closing it resolves
  the hypothesis with the outcome. That + `fills`/`pnl` is the track record.
- Each cycle the scout reads its recent track record + `docs/scout/playbook.md`
  and applies the playbook's rules.
- The `scout-review` skill (weekly inside `desk-retro`, or on demand; Opus) scores
  the record and **curates the playbook** — the deliberate, non-recency-biased
  update step.
