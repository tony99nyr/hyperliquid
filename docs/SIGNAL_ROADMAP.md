# Signal Roadmap — data sources for tighter theses (2026-07-13)

What the desk ingests today, what's planned, and the validation gate every new signal
must pass. Companion to [LADDER_DESK_PLAYBOOK.md](./LADDER_DESK_PLAYBOOK.md) (how to
trade) and the expectancy ledger (whether it paid).

## The rule that governs this roadmap

**A signal earns permanence by improving ledger expectancy, not by sounding smart.**
New inputs land as *recorded columns* and *advisory context* first; they graduate into
pillar weights / trigger kinds only when the accumulated series backtests positive or
the ledger shows the setups they gate outperform. The do-not-build list is as binding
as the build list.

## Live today (after this change)

| Signal | Source | Where it acts |
|---|---|---|
| Funding, OI, premium, mark | `metaAndAssetCtxs` | Rubric carry pillar · review-ladder funding math + OI context · scout cycle |
| **Taker-flow (CVD-style)** ★new | `recentTrades` tape | Rubric **micro pillar** (30% blend with book imbalance) + recorded |
| Book imbalance + spread | `l2Book` REST | Rubric micro pillar (70%) + **now recorded** ★ |
| **AF buyback gauge** ★new | Assistance Fund spot balance (`0xfefe…fefe`) | Recorded on HYPE rows — balance delta = fee-funded buy run-rate (our research: procyclical, NOT a floor — now measurable) |
| Leader positioning + actions | trader-watch feed | Rubric leaders pillar · leader guard · flow reviews |
| Multi-TF regime + divergences | candles + vendored strategy | analyze-market · health engine · thesis pillar |
| **Time series of ALL of the above** ★ | `market_snapshots` (~20min cadence, **180d retention** — was 60d) | The free history pros pay for; backtest fuel |

## Tier 1 — next signal builds (HL-native, in order)

1. **Funding/OI momentum triggers** — the series now accumulates; once ~2-4 weeks deep,
   add scout trigger kinds: funding-extreme (percentile vs own history, not absolute),
   OI-spike + price-divergence (squeeze fuel gauge — the BTC June setup, mechanized).
   Gate: backtest on the recorded series before arming anything.
2. **CVD divergence trigger** — taker_flow persistently opposing price (absorption) is
   the tape's squeeze tell. Same gate: record first (done), trigger after backtest.
3. **Enable the `funding` rung trigger kind** — exists in the schema, rejected at arm
   today. Unlock once (1) has calibrated what "extreme" means per coin.
4. **Depth-at-distance in stop hygiene v2** — size stops beyond thin-book zones, not
   just wick pools/round numbers (l2Book already fetched).

## Tier 2 — on-chain (HyperEVM), in order

1. **AF buyback rate alerting** — recorded now; add a scout trigger / review context
   when the daily buy-rate z-score moves (structural bid strengthening/fading under a
   HYPE position).
2. **Bridge flows** (Arbitrum USDC bridge) — venue risk-on/off gauge; big outflows
   precede de-risking. Needs an RPC/explorer poller on the NAS.
3. **Vest/unlock actualization** — watch the vesting addresses actually MOVE tokens
   instead of trusting tracker estimates (settles the $10M-vs-$635M class of dispute
   from the Jul-6 unlock research).

## Deliberately NOT building (binding until the ledger says otherwise)

- **Social/news sentiment** (X/Farcaster/Fear&Greed): positioning already measures
  belief with money; these feeds are noisy, laggy, and at this account size the effort
  is pure distraction. Catalyst *calendars* stay agent-driven (the scheduled
  deep-research sweep pattern), not scraped feeds.
- **Cross-venue microstructure** (Binance/CME basis): real edge at size; irrelevant at
  a sub-$1k book. Revisit after the first SIZE-UP verdict.
- **Any new pillar weight without a backtest** — advisory/recorded first, always.

## Where signals plug in (the seams)

`rubric_scores` pillars (deterministic screen) → `scout_triggers` kinds (wake-ups) →
review-ladder pillars (per-trade consent) → `market_snapshots` (history/backtests) →
the expectancy ledger (the judge). Every new signal must name its seam before it's built.
