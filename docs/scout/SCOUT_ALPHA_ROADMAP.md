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
  **vault allocation was the only copy signal that persisted (IC +0.223)**. *(The
  IC −0.50 / +0.223 figures are from the iamrossi `PERP_FOLLOW_STUDY_V2` and are
  second-hand here — verify against its primary outputs before betting on them.)*
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

### Lane A — HLP / vault allocation (passive; build first)
The simplest *strategy* (no directional call, no setup detector, no exit guards) and
the most durable edge — it corroborates our own +0.223 vault finding. Note: "simplest
strategy" ≠ "no work" — it needs a **new vault data layer** (see Infrastructure gaps).
We build it first because the *trading logic* is trivial and the risk is low, not
because it's zero-code.
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
  alignment. **Liquidity:** operator vaults can lock capital / charge redemption —
  prefer liquid vaults and bound the lock-up tail in the bar (don't allocate paper
  capital you couldn't redeem inside the measurement window).
- **Build (all NEW — there is no vault schema or ingester today):**
  - **Migration:** `vault_snapshots` (vault_address, name, kind `hlp|operator`,
    nav_usd, pnl_24h_usd, max_drawdown_pct, age_days, leader_stake_pct, fetched_at)
    + a derived `vault_evaluations` read.
  - **Ingester** (`pnpm vault-watch`, modeled on `trader-watch`): poll HL's info
    `vaultDetails`, hourly; write `vault_snapshots`. **Start HLP-only** (the anchor,
    no leader-key risk); the operator-vault shortlist is operator-maintained and added
    later. Reuse trader-watch's retry/backoff + heartbeat; fail-soft.
  - **Scout read:** `scout:cycle` surfaces the vault NAV series; a paper "allocation"
    is a virtual position whose P&L tracks NAV change (NOT a perp fill — see §
    Infrastructure gaps for the scorecard change this needs).
  - Execution is deterministic (allocate/redeem against NAV) — no setup detector or
    exit guards — but the data layer + the unrealized-NAV scorecard path are net-new.
- **Bar:** beats hold-USDC net of fees by a pre-registered margin (operator sets the
  $/mo; suggest a LOWER bar than the directional $1000 since it's passive), measured
  on **allocated-capital drawdown** < 15%, over ≥60d, and **fails immediately if a
  held vault takes permanent bad debt** (the POPCAT failure mode).

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
- **Build:** the scout already reads `fundingHourly`/OI (reused). NEW (see
  Infrastructure gaps): a 2-leg/paired-perp position model, a **funding-carry setup
  detector** (extreme + stable funding, both legs liquid), the spread-scoring path,
  and the **funding-threshold exit trigger + ADL model**. v1 hedge is cross/paired
  perp (no spot fill exists). Paper P&L already models signed funding
  (`paper-funding-business-logic`).
- **Bar:** net-positive by a pre-registered $/mo margin (operator sets it; suggest
  LOWER than Lane A given the leverage/ADL tail), after fees+slippage+the funding it
  actually earns, over ≥45d spanning **≥1 funding-regime flip (positive→negative)**,
  with **zero uncovered-ADL events** (an ADL that left a leg naked = lane fails).

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
- **Bar:** must clear an **absolute** net-of-cost $/mo floor (not merely "less
  negative than Lane A") **AND** beat Lane A's realized Sharpe over the same window in
  our backtest, ≥90d, before any paper capital. A relative-only bar can graduate a
  losing lane — require the absolute floor first.

### Retire — directional single-name momentum on majors
The current scout lane. Demote it to a *context signal* (regime as a risk overlay /
sit-out filter, as `BACKTEST_FINDINGS` already concluded), not a P&L engine.

## 3b. Infrastructure gaps — what is NEW vs actually reused (read before estimating)

The machinery in §6 is reused, but each lane needs **new infra the single-perp scout
doesn't have today**. Honest accounting (verified against the code):

- **Pre-work #0 — multi-lane isolation (blocks everything):** today there's one scout
  book (`title='scout'`, single-perp positions). **Decided approach:** add a nullable
  `lane` text tag to `fills`/`positions` (+ surface it on the scout session), NOT
  one-session-per-lane (keeps the single paper book + one circuit-breaker account).
  This is a **small migration + a `scout:cycle`/`scout:trade --lane` refactor + a
  per-lane `buildScorecard` config** — not just a decision. The **circuit breaker
  stays account-wide** (total-equity halt; a failed lane must not block the others'
  verdicts). Bonus: Lane B's "2-leg" need is then just **two lane-tagged single-leg
  positions bound as one unit** — no new `Position` type required.
- **Lane A — vault data layer (entirely new):** no vault schema/ingester exists
  (`0010_scout_observability.sql` has only `market_snapshots` + heartbeat). Needs the
  migration + `vault-watch` ingester above, **and** a scorecard that scores an
  **unrealized NAV track** — `buildScorecard` today only folds *realized* round-trip
  P&L (`scout-review-business-logic.ts`). Add `unrealizedPnlUsd` to `ScorecardInput`.
- **Lane B — delta-neutral needs a 2-leg model (new):** the `Position` type is
  **single-leg** (`side: long|short|flat`, one coin — `src/types/position.ts`), and the
  paper fill is **perp-only** (`fill-source-paper.ts` walks a perp L2 book; there is no
  HL **spot** fill model). So:
  - **v1 hedge = cross-perp or paired-perp** (e.g. long the funding-earning perp,
    short a correlated perp), NOT long-spot/short-perp. Spot-leg is a *future*
    refinement, not assumed.
  - Needs a 2-leg construct (or two lane-tagged positions treated as one unit) and a
    scorecard that scores the **spread**, not each leg's direction.
  - The **negative-funding-exit and ADL guards are prose today** — no funding-threshold
    trigger exists in `scout-trigger-business-logic.ts`, and ADL/naked-long is not
    modeled in paper. Both are net-new and are the gating risk work for Lane B.
- **Lane C** — needs the cross-sectional re-backtest harness extension (already gated
  on that; no surprise).

**Sequencing implication:** Lane A's *trading* is trivial but its *data layer* is new;
Lane B *reuses* the funding feed (`market_snapshots.funding_hourly` already streams)
but needs the 2-leg model + exit guards. Neither is "free reuse." We still build A
first (lowest strategy risk, no guards to get wrong), but Pre-work #0 (lane isolation)
+ the unrealized-NAV scorecard are the true first tasks.

## 4. Open research tasks (the deep-research couldn't resolve these — they're now *our* backtests)
1. **Live HL funding yields** — the one current-yield claim was *refuted*; instrument
   live funding measurement before sizing Lane B. (We already log `market_snapshots`.)
2. **HLP realized return/drawdown time series** — no quantified history survived
   verification; pull on-chain NAV ourselves for Lane A.
3. **Market-making-lite feasibility on HL** — maker economics, fee tiers, adverse
   selection for passive quotes. Unknown; study before attempting (or just use HLP).
4. **Liquidation/flow accessibility** from public HL liquidation/OI feeds — is there
   a tradable, capacity-real signal without speed? Unresolved.
5. **(DEFERRED — only if we resurrect a pillar-driven lane)** the leaders/carry/micro
   pillars are still DATA-BLOCKED; `market_snapshots` now has months of history, so
   they *could* finally be backtested. But this roadmap **retires** the directional
   pillar lane, so this is parked unless a future lane wants to read them.

## 5. Sequencing (stop → rebuild → relaunch)
1. **Stop** the current directional scout (keep the daemon/scorecard/guards).
2. **Pre-work #0 — multi-lane architecture** (blocks all lanes, §3b): the lane
   isolation decision + the `unrealizedPnlUsd` extension to `ScorecardInput`. Do this
   before any lane, or Lane A's first NAV track has nowhere to land.
3. **Lane A** (vault allocation) — **do not open the Lane A PR until Pre-work #0
   ships** (the NAV track has nowhere to land otherwise). Then build the
   `vault_snapshots` migration + `vault-watch` ingester (HLP-only first) + the trivial
   allocation logic. Lowest *strategy* risk, ship first.
4. **Lane B** (funding carry) — the 2-leg/paired-perp model + setup detector +
   funding-exit trigger + ADL model. The guards are the gating work.
5. **Re-backtest a CTREND-style cross-sectional signal** on the tradable HL subset
   with realistic costs; build **Lane C** only if it clears its absolute+relative bar
   in-harness. (Pillar validation is deferred — §4 task 5.)
6. **Relaunch** the scout as a multi-lane paper operator: each lane its own
   lane-tagged book + pre-registered bar; `scout-review` emits **one scorecard per
   lane** (plus per-lane playbook sections); the weakest lanes get killed on the
   scorecard, not on vibes.

## 6. Reuse vs new (be honest about the line)
**Reused as-is:** the trigger daemon, `scout:cycle` snapshot shape, the
`buildScorecard` kill/graduate *framework* (gates + verdict), the paper fill +
signed-funding cost model, the hypothesis track record, the circuit breaker
(account-wide), and `market_snapshots` (funding/OI already streaming).

**New (per §3b — do not under-estimate):** multi-lane isolation (lane tag +
`--lane`); the vault data layer (`vault_snapshots` migration + `vault-watch`
ingester) for A; a 2-leg/paired-perp position model + spread scoring + funding-exit
trigger + ADL model for B; an **unrealized-NAV** path in `ScorecardInput` (today it
folds realized round-trips only); per-lane scorecard config. The refactor reuses the
*engine*, but the **data model and the books are materially extended** — it is not a
drop-in re-point.

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
