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

## Learned rules (curated by scout-review — append below)

<!-- scout-review appends/edits dated, evidence-backed rules here, e.g.:
- 2026-07-01: negative-funding shorts into a flush lost 4/5 (avg -$X). Require
  confirmed 8h+1d bearish regime before shorting against funding. -->

_(none yet — the track record is empty)_
