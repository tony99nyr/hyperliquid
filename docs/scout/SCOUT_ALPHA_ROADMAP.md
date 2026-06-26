# Scout Alpha Roadmap — stop, rebuild, relaunch

> **Status: PROPOSED.** Pairs with `docs/scout/README.md` (current decision model)
> and `docs/scout/BACKTEST_FINDINGS.md` (why the directional core is weak). The
> external evidence below comes from a verified deep-research pass (18 confirmed /
> 7 adversarially-refuted claims); **time-sensitive numbers must be re-measured
> live — see Caveats.** The decision: **stop the current directional scout,
> rebuild it around durable+accessible edges, relaunch each as a pre-registered
> paper lane.**

---

## 1. The verdict (why we're refactoring)

Two independent bodies of evidence now agree the scout is pointed at the wrong edge:

- **Our own backtests** (`BACKTEST_FINDINGS.md`): the regime/trend core is weak,
  lumpy, one-regime (~+$68/mo on $1k, "encouraging, not proven"); the
  leaders/carry/micro pillars were never validated (DATA-BLOCKED); and the
  perp-follow study found leader-copy persistence is *negative* (IC −0.50), while
  **vault allocation was the only copy signal that persisted (IC +0.223)**.
- **External research** (deep-research, this pass): directional momentum on liquid
  majors sits at the **weak/unproven end** of the edge spectrum; what survives
  review as durable+accessible for a small Hyperliquid operator is **(a) funding/
  basis carry** and **(b) HLP-style passive vault allocation**, with cross-sectional
  factors usable only as a cost-aware, vol-managed overlay.

The scout's *machinery* (free deterministic triggers, honest cost-modeled
scorecard, hypothesis track record, paper-only guard, circuit breaker) is good and
**we keep all of it**. We repoint it from "guess ETH's direction" to edges that
actually pay.

## 2. The edge spectrum (grounded)

| Edge | Durable? | Accessible to us? | Evidence |
|---|---|---|---|
| **Funding / basis carry** (delta-neutral: harvest funding) | Yes, while funding positive; capacity-limited | **Yes — top pick** | Pro bread-and-butter (Liquibit's largest 2025 strategy = cross-exchange funding arb; HLP leans net-short to harvest funding). NY Fed documents the mechanism *and* the failure taxonomy |
| **HLP / vault allocation** (deposit, share MM+liquidation+fee PnL) | Yes — battle-tested | **Yes — trivially** | Community-owned, pro-rata; survived Oct-2025 $10B force-close, zero *permanent* bad debt, 100% uptime. Aligns with our own vault-persistence finding (+0.223) |
| **Cross-sectional momentum/carry** (rank universe, long/short) | Decaying, regime-dependent | **Mostly no** for a majors book | Edge concentrates in uninvestable micro-caps; cost-fragile (125bps round-trip → top quintile underperforms); infinite-variance tails; literature disagrees |
| **CTREND** (ML trend factor) | Strongest factor candidate | **Maybe — re-backtest first** | Median Sharpe ~1.34 vs ~0.83 plain momentum, survives costs, persists in liquid coins — BUT in-sample, 3,000+ coin universe, not third-party replicated |
| **Market-making-lite** (passive spread capture) | Unknown for slow players | **Open question** | No evidence it works without low latency; the *accessible* version is "let HLP do it" |
| **Liquidation-cascade fading** | Unknown | **Open question** | Not corroborated as accessible without speed/data |
| **Directional momentum on majors** ← *current scout* | **Weak/unproven** | Yes but ~no edge | Our backtest + external review both rate it lowest |

## 3. The plan — three lanes, cheapest-and-most-durable first

Build in this order; each is a **separate paper book** with its own pre-registered
bar (reuse `buildScorecard`). Run them in parallel once built; let the scorecard,
not conviction, decide which survives.

### Lane A — HLP / vault allocation (passive; build first, lowest effort)
The highest-Sharpe, lowest-effort, most-durable option, and it corroborates our own
+0.223 vault finding.
- **Mechanics:** paper-allocate the scout's book across HLP and a shortlist of
  vetted operator vaults; track NAV/PnL over time vs just holding USDC and vs the
  scout's own trading.
- **Edge / capacity:** HLP earns from market-making + liquidations + a fee share +
  funding (net-short lean). Capacity is large. *Returns must be measured* — secondary
  sources cite ~10–12% APR / Sharpe >4 in 2025 but **those figures did NOT survive
  adversarial verification** (Caveats); instrument on-chain NAV directly.
- **Risks:** not riskless — HLP took **~$5M bad debt in the Nov-2025 POPCAT attack**
  (a different event from the Oct crash it survived). Operator vaults add leader-key
  and strategy risk; prefer skin-in-the-game (≥5% leader stake) + profit-share
  alignment.
- **Build:** a `vaults` ingester (HLP + candidate operator vaults: NAV, drawdown,
  age, leader stake) → a `vault_evaluations` table → the scout reads it and can
  "allocate" in paper. Mostly read-only; near-zero execution risk.
- **Bar:** beats hold-USDC after fees, max drawdown < 15%, over ≥60d.

### Lane B — Delta-neutral funding carry (the pro bread-and-butter)
The edge the research most strongly endorses *and* the one most prone to silent
blow-up — so the guards are the feature.
- **Mechanics:** when funding on a coin is meaningfully positive (longs pay),
  hold the funding-earning side and hedge the directional exposure (perp-vs-spot,
  or a paired/【cross-coin】hedge within HL). Harvest funding per hour; the price
  leg is hedged, so the P&L is the carry minus costs.
- **Edge / capacity:** funding = staking/borrow yield + perp funding; real but
  **time-varying and capacity-limited**. The carry is only an edge while funding
  stays positive and stable.
- **Mandatory guards (these ARE the strategy — from the documented failure taxonomy):**
  - **Negative-funding exit:** flip to net cost when funding turns negative (e.g.
    −5% funding vs 3.5% yield = −1.5%/yr) → close, don't ride.
  - **ADL awareness:** auto-deleveraging can force-close the short hedge and leave
    you **naked-long** — the Oct-2025 mechanism. Model it; cap leverage; never
    assume the hedge is permanent.
  - **Counterparty / margin / (if staked collateral) slashing** risk — keep margin
    buffers; don't run the hedge at max leverage.
- **Build:** the scout already reads `fundingHourly`/OI. Add a **funding-carry
  setup detector** (extreme + stable funding, both legs liquid), a delta-neutral
  position constructor, and the negative-funding/ADL guards. Paper P&L already
  models signed funding (`paper-funding-business-logic`).
- **Bar:** net-positive after fees+slippage+the funding it actually earns, across a
  funding-regime change, over ≥45d.

### Lane C — Cost-aware, vol-managed cross-sectional overlay (only if it survives a re-backtest)
Lowest priority; the research says naive cross-sectional is a trap, but two
transferable lessons survive: **vol-scaling helps** (Sharpe 1.12→1.42) and **CTREND**
is the one factor that reportedly survives costs in liquid coins.
- **Mechanics:** rank the tradable HL universe by a CTREND-style trend signal (NOT
  raw momentum), trade the spread with **trimming** (drop single-coin short-leg
  blowups) + **vol-targeting**. Relative, beta-neutral.
- **Gate before building:** re-backtest on the *tradable HL subset* with realistic
  maker/taker + funding + slippage. The academic Sharpes are in-sample, gross, and
  computed over 3,000+ uninvestable coins — **expect materially lower net edge.** If
  it doesn't clear the bar in our own harness, **don't build it.**
- **Bar:** beats Lane A net-of-cost in our backtest before any paper capital.

### Retire — directional single-name momentum on majors
The current scout lane. Demote it to a *context signal* (regime as a risk overlay /
sit-out filter, as `BACKTEST_FINDINGS` already concluded), not a P&L engine.

## 4. Open research tasks (the deep-research couldn't resolve these — they're now *our* backtests)
1. **Live HL funding yields** — the one current-yield claim was *refuted*; instrument
   live funding measurement before sizing Lane B. (We already log `market_snapshots`.)
2. **HLP realized return/drawdown time series** — no quantified history survived
   verification; pull on-chain NAV ourselves for Lane A.
3. **Market-making-lite feasibility on HL** — maker economics, fee tiers, adverse
   selection for passive quotes. Unknown; study before attempting (or just use HLP).
4. **Liquidation/flow accessibility** from public HL liquidation/OI feeds — is there
   a tradable, capacity-real signal without speed? Unresolved.
5. **Validate the existing pillars** — leaders/carry/micro are still DATA-BLOCKED in
   our own backtest; `market_snapshots` should now have months of history. Backtest
   them before any pillar-driven lane trusts them.

## 5. Sequencing (stop → rebuild → relaunch)
1. **Stop** the current directional scout (keep the daemon/scorecard/guards).
2. **Instrument** the missing data: live funding/OI history (have it), HLP+vault NAV
   ingester, tradable-universe candle/funding panel.
3. **Lane A** (vault allocation) — cheapest, mostly read-only, ship first.
4. **Lane B** (funding carry) — build the detector + delta-neutral constructor +
   the negative-funding/ADL guards.
5. **Re-backtest** the pillars + a CTREND-style signal; build **Lane C** only if it
   clears its bar in-harness.
6. **Relaunch** the scout as a multi-lane paper operator: each lane its own book +
   pre-registered bar; `scout-review` curates per-lane; the weakest lanes get killed
   on the scorecard, not on vibes.

## 6. What we reuse (no rebuild)
Trigger daemon, `scout:cycle` snapshot, `buildScorecard` + the kill/graduation bar,
paper fill + signed-funding cost model, hypothesis track record, circuit breaker,
`market_snapshots`, the rubric scan harness (re-pointed). The refactor is **new
setup detectors + a vault ingester + per-lane books**, not a new engine.

## 7. Caveats (read before trusting any number here)
- **Funding yields are time-varying** — the specific 2026 yield claim was **refuted
  (0-3)**; measure live, never trust a cited level.
- **HLP "zero bad debt" is Oct-2025-crash-specific** — it took **~$5M in the Nov-2025
  POPCAT attack**. Vaults are low-risk, not no-risk.
- **Academic factor results are in-sample, gross-of-cost, broad-universe** (3,000+
  coins incl. uninvestable micro-caps). Net edge on the HL majors subset will be
  **materially lower** — re-backtest before believing.
- **Refuted narratives** (do not rely on): a specific momentum in/out-of-sample decay
  figure, a "−255% momentum crash", "reversal dominates momentum", and "funding is
  structurally positive therefore the carry is durable."
- **Source mix:** funding-mechanism / factor / HLP-ownership claims rest on PRIMARY
  sources (NY Fed, peer-reviewed journals, HL docs); the Oct-2025 crash narrative and
  risk taxonomy lean on multiply-corroborated SECONDARY sources.

## 8. Key sources
- NY Fed, *Synthetic Stablecoins and Financial Stability* (2026) — carry mechanism +
  failure math. [primary]
- Hyperliquid docs, *Protocol Vaults / HLP* — HLP revenue + community ownership. [primary]
- *Inside the $19B Flash Crash* (insights4vc) — Oct-2025 ADL / HLP resilience. [secondary, corroborated]
- Fieberg et al., *A Trend Factor for the Cross-Section of Crypto Returns*, JFQA 2024 —
  CTREND. [primary]
- Hou/Fieberg et al., IRFA 2024; Starkiller Capital; FMPM 2025 — cross-sectional
  cost-fragility, micro-cap dependence, tail risk, vol-scaling uplift. [primary]
- The Hedge Fund Journal, *Liquibit* — a systematic fund whose largest 2025 strategy
  is cross-exchange funding-rate arbitrage. [secondary]
