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
| Leader positioning + actions | trader-watch feed | Rubric leaders pillar · leader guard · flow reviews · **scout `leader-action` trigger + leader-follow paper lane** ★new · scout snapshot context ★new |
| Multi-TF regime + divergences | candles + vendored strategy | analyze-market · health engine · thesis pillar |
| **Time series of ALL of the above** ★ | `market_snapshots` (~20min cadence, **180d retention** — was 60d) | The free history pros pay for; backtest fuel. ⚠ taker_flow is a POINT sample of the last-N-trades window (width varies per coin), not an interval aggregate; NULL = not measured, never 0 |

## Tier 1 — next signal builds (HL-native, in order)

1. **Funding/OI momentum triggers** — **first backtest run 2026-07-13 (18d series): NOTHING
   cleared the pre-registered bar** (≥25bps@4h or ≥50bps@24h net of 9bps, same sign
   BTC+ETH, n≥20/coin, |t|≥1.5) — every candidate failed on sample size. Two flagged
   for the re-run (~Aug 1, when the series is 5-6 weeks deep):
   - *funding-extreme 4h contrarian*: ≥95th-pctile funding → fwd 4h −40bps BTC (t=−2.1,
     n=12) / −39bps ETH (t=−2.2, n=25), vs ~flat baselines. Sign-consistent.
   - *OI-spike trend-CONFIRMATION 24h*: OI z≥2 with price trending → +120/+172/+198/+257bps
     across BTC/ETH/HYPE/SOL (n=4-11 each). The original divergence variant was BTC-only.
   Caveats held: one regime (range→breakdown), overlapping events thinned crudely,
   8 signal×horizon cells → multiple-comparison risk. NO trigger wired — the rule worked.
2. **CVD divergence trigger** — taker_flow persistently opposing price (absorption) is
   the tape's squeeze tell. Same gate: record first (done — recording since 2026-07-13),
   trigger after backtest (~2 weeks of series needed).
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
