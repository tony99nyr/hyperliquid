# Scout Playbook — curated trading heuristics

The scout reads this file at the start of **every** cycle and applies its rules.
The `scout-review` skill curates it from the resolved-hypothesis track record —
add a rule when the data supports it, remove one when it stops paying. Keep it
short and concrete; this is operating memory, not a journal.

> Seeded from this project's hard-won lessons (the rejected capital lanes + the
> rubric's documented chop-bleed weakness). Treat these as priors to be
> confirmed or overturned by the paper track record.

## Stand down by default

- **Chop is a trap.** A tight multi-hour range + low ATR percentile is the
  chop-bleed regime that bled the rubric in backtests (~30 stop-out cycles in the
  April 2026 range). A 0.5% intraday flush inside a range is NOT a setup — skip it.
- **No confluence, no trade.** Want regime + leaders + (carry OR micro) pointing
  the same way. A lone signal is noise.
- **Thin edge loses to fees.** ~9bps round-trip taker. If the realistic move to
  target isn't several × that after funding, pass.

## Funding is a real cost, not a footnote

- A position pays/earns funding every hour it's held. **Don't short into negative
  funding** (shorts pay) without a strong directional thesis — the carry bleeds you.
- A large negative funding rate is a *carry* reason to be biased long (you get
  paid to hold), but never the sole reason — direction still has to be right.

## Sizing + risk

- Size by risk (`--risk` + `--stop-frac`), never raw notional.
- One thesis per position; write it down honestly. If the thesis breaks, exit —
  don't rationalize a round-trip.
- Manage open positions BEFORE hunting new ones (risk before opportunity).

## Reading the advisory context (snapshot `tape` / `leaders` / `percentiles` / `afHypePerDay`)

These are CONTEXT, not signals — none of them alone justifies a trade (the roadmap rule:
signals graduate into gates only after a backtest). How to read them honestly:

- `tape.takerFlow` (−1..+1, notional-weighted aggressor skew) is a POINT sample of the
  last-trades window — `null` means NOT MEASURED, never "0/neutral". Flow opposing price
  (heavy selling into a flat/rising mark) = absorption; note which side is absorbing.
- `tape.bookImbalance` (+ = bid-heavy near mid) goes stale FAST on breakdown days — if a
  thesis leans on the book, re-check it at decision time, not scan time.
- `leaders`: DECOMPOSE before trusting (the 0x418aa6 martingale lesson). `topWalletUsd`
  vs the total tells you one-whale vs consensus; 2 wallets is not a crowd. Whales holding
  a green position is weak signal (holding-when-green is free).
- `percentiles`: funding/OI framed against the coin's OWN recorded series. `null` = the
  series is too thin — say so, don't guess. An OI percentile >90th with price divergence
  is squeeze fuel worth flagging in the thesis; mid-percentile readings mean NOTHING.
- `afHypePerDay` (HYPE only): procyclical fee-funded buyback — context for HYPE carry
  theses, NEVER a floor argument.

## Lane: leader-follow (opened 2026-07-13 — paper, expectancy-gated like every lane)

Wakes: `leader-action` triggers (a RATED whale opened / flipped / added ≥ $1M notional;
reduces/closes never wake). Rules of engagement:

- **Follow conviction, not existence.** An open/flip by a whale with a clean grade is a
  candidate; an add-to-loser is a martingale tell (check `leaders` context: is the add
  above or below their avg entry?). The 0x418aa6 lesson applies IN this lane most of all.
- **Never mirror size or leverage.** Scout floor risk only (`--risk` per the sizing rules),
  `--lane leader-follow` on every entry so the scorecard isolates the lane.
- **The whale's stop is not visible — you still need your own.** Stop-frac per ATR rules;
  no "they're still in it" as a reason to hold a broken thesis.
- **Exit triggers**: the leader closing/flipping the position kills the thesis (check the
  feed before every manage cycle); so does your own stop/health, whichever first.
- **Tag hypotheses with the leader address** so the weekly review can attribute per-wallet
  hit rates — the lane's kill/keep verdict may end up per-LEADER, not per-lane.
- Pre-registered bar: same as every lane (COLLECT until n≥10 closed; kill at ≤−0.05R).

## Lane: steward (opened 2026-07-14 — PROPOSE-ONLY, no ledger)

The scout reads the LIVE book (snapshot `liveBook`, read-only) and may emit
`{action:'propose', ...}` — a Discord page + log, never an execution. Ground rules:
- Propose LADDER language: a specific rung change (stop_move to X, bank N% at Y,
  disarm across the Wed 12:30-16:00 binary window, re-arm the OCO sibling), with the
  2-3 numbers that justify it. See docs/LADDER_BUILDER_GUIDE.md.
- Momentum/stall/tape claims must cite the snapshot fields (tape/percentiles/leaders).
- Never propose loosening a stop, adding to a loser, or removing protection.
- Rate-limit yourself: repeat a proposal only if the evidence STRENGTHENED.

## Learned rules (curated by scout-review — append below)

<!-- scout-review appends/edits dated, evidence-backed rules here, e.g.:
- 2026-07-01: negative-funding shorts into a flush lost 4/5 (avg -$X). Require
  confirmed 8h+1d bearish regime before shorting against funding. -->

_(none yet — the track record is empty)_
