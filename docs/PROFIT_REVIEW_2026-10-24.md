# Profit review and improvement plan (2026-10-24)

Status: **v2.1, revised after three independent reviews** (Codex `gpt-6-sol`,
Codex `gpt-6-astra`, Claude Fable, each with clean context) and a review with
live ladder context (the Ladder Expert session). The three clean reviews
returned "accept with changes". The Ladder Expert returned "accept". Nothing here is implemented. It feeds the next update of
`docs/DESK_PROFITABILITY.md` once the retro accepts it.

## Method

Four read-only reviews ran in parallel on 2026-10-24:

1. A live-ledger reconstruction from HL `userFills` (46 round trips, 2026-06-19 to
   2026-10-24), with MFE/MAE from 15m/1h candles.
2. A scout review from the `hypotheses` ledger, plus an exploratory (NOT
   pre-registered) multi-coin backtest of the frozen htf-trend rule.
3. A catalyst review: the event calendar, event straddles, the runaway and
   reversion drafters, and scout blackouts.
4. A signal-gap audit: the signal families in use vs the families that are missing.

**Evidence status.** The reviewers verified the code mechanics. Item 0
(`pnpm analysis:profit-review`, `scripts/analysis/profit-review/`) now
regenerates the core numbers.

- **Confirmed by item 0:**
  - the lifetime and since-August totals,
  - htf-trend (n=12, +0.66R, -0.08R with the cluster removed),
  - compression-straddle (-$12.34 on 7 closes),
  - the CPI Sep leg (+0.09R slip-aware, +0.72R nominal).
- **Still unverified:** the MFE/MAE, post-stop, event-move and runaway figures.
  The bundle does not port those scripts yet.

## Headline

Since August the win rate is not the problem: 12 trades, 58% wins, payoff 4.2,
+$87 net. Lifetime is -$152, all from June and July churn (34 trades, 21% wins,
mostly manual scalps under 6h). The limits now are:

- measurement defects that drive lane verdicts,
- an htf-trend edge that rests on one cluster,
- catalysts we do not trade at all.

## Findings

### F1. Live book (since 2026-08-01, n=12, all ladder-originated)

| Metric | Value |
|---|---|
| Win rate | 58% |
| Avg win / avg loss | +$15.26 / -$3.90 (payoff 3.9; v2 said 4.2) |
| Expectancy per trade | +$7.28 |
| Fees / funding | $5.6 / -$0.6 |

- Holds of 72h or more made +$25.60 lifetime (n=4; v2 said n=6, +$52). Holds
  under 6h lost $203 lifetime (n=25, mostly June; v2 said $137).
- Winners captured a median 53% of MFE.
- After a stop-out, the planned target was reached within 48h in 0 of 5 cases
  since August (1 of 13 lifetime). The stops are not cutting trades that later
  reach the target.
- **New defect: `ladder_outcomes` double-counts P&L.** Each outcome window runs
  from the ladder's start to its resolution, and the window sums every fill on
  the coin inside that span. Overlapping ladders on one coin therefore count
  the same fills more than once.
  - trend-follow-8h-long: fills give **+$15.09 over 6 trips**. The ledger
    gives $112.90 (+0.65R, 6 closed rows).
  - The same overlap inflates the HYPE rows, the ETH Retail Sales and Jackson
    Hole straddles, FOMC v3, and runner-management ladder 1fb773de (+$32.81,
    which re-counts the Retail Sales fills).
  - 11 of the 13 mismatches between the two sources are this overlap.
  - The "27 closed, +0.19R" figure was not reproduced from the table.
- Fills attributed to ladders total only +$52.67 lifetime. The 21 manual trips
  (-$204.54) are mostly June scalps.

### F2. Lane scorecard defects (verified in code)

The scorecard has five verified defects:

1. `estimateFromFills` (`src/lib/scout/lane-scorecard-service.ts:44-89`, query
   at `:133-135`) groups fills by coin across all scout sessions.
2. The same function applies TODAY's `fundingHourly` to every past hour
   (`:130-132`).
3. It nets dollar notionals, not coin quantities (`:74`). Equal-quantity exits
   at different prices leave phantom exposure. This is the likely source of
   the reported 1,190h BTC "holding".
4. `buildLaneScorecards` (`src/lib/scout/scout-review-business-logic.ts:278-290`)
   charges a coin's funding to the last lane in iteration order. The comment at
   `:247-252` assumes one lane per coin, and BTC now breaks that assumption.
5. Lane cards apply `DEFAULT_SCORECARD_CONFIG` (21d / 3 closes,
   `scout-review-business-logic.ts:65-68`), not each lane's registered bar.
   `periodDays` is account-wide (`lane-scorecard-service.ts:136`). The time bars
   are therefore wrong for every lane.

Consequence: the 2026-10-13 compression-straddle verdict ("survived its
6th-close bar", +$34.51) rests on a wrong number. A scratch reconstruction gives
-$12.30 realised over 7 closes. If the FIXED, unit-tested scorecard reproduces a
negative net, the registered bar has fired
(`docs/scout/PREREGISTRATION_compression-straddle.md:60-61`), and the lane is
killed. That kill is an operational stopping rule. It does not prove negative
expectancy at n=7.

**Status after item 1 (2026-10-24).** The fixed scorecard (read-only
`pnpm scout:review`) reproduces the problem:

| Lane | Net | n | Verdict |
|---|---|---|---|
| compression-straddle | -$12.39 | 7 | **KILL** |
| htf-trend | +$100.41 after historical funding | 12 | CONTINUE |

- A second bug surfaced during the run, now fixed. HL funding timestamps land
  a few ms after the hour, and the first version of the estimator matched
  exact hours, so it missed about 6,500 hours of funding.
- The KILL is recorded here. The Monday 2026-10-26 retro applies it formally,
  with `pnpm scout:review -- --write` and a playbook entry.

### F3. Event-straddle R is measured in a unit that hides the lane

- `src/lib/skills/ladder-expectancy-business-logic.ts:71,117` divides realised
  net P&L by the planned slip-aware risk, `worstCaseLossWithFundingUsd`
  (`scripts/ladder-expectancy.ts:85`). For a 1% stop the denominator is about
  10.9x (long) / 11.1x (short) nominal risk, plus funding.
- The denominator exists on purpose. It backs the arm cap and the consent gate
  (`src/lib/ladder/ladder-risk-business-logic.ts:7-22`). It is the wrong unit
  for comparing setups: it penalises a 1% stop about 4x harder than a 5% stop.
- Event straddles are pooled into `breakout-long-single` /
  `breakdown-short-single` (`ladder-expectancy-business-logic.ts:48`), so the
  event lane has no verdict of its own.
- **The count is settled at 6 fired legs** (2026-10-24). The definition: a leg
  is FIRED when its `open` rung has a `ladder_fires` row with
  `status='filled'`, counted per leg, never per management fire. The six legs:
  - PPI ETH long b965df6d (lost)
  - CPI-Aug BTC long 7a024889
  - Jackson Hole BTC short ce7d63cd
  - FOMC v3 BTC short 880bdd71
  - Retail Sales ETH short 1fa6710c
  - CPI-Sep BTC short 9ddfcf7e

  The other 12 legs are `never_filled` costless passes.
  - Several of the 6 rows carry the double-counted P&L above, so their R is
    unreliable either way.
  - Settle the definition of "fired" (and fix the overlap) before quoting any
    event-lane mean. The v1 "+0.56R" figure stays withdrawn.
- **Worked example.** The CPI leg has `planned_risk_usd` 101.44 (slip-aware),
  which gives +0.09R. On nominal risk the same trade is about +0.7R.

### F4. htf-trend rests on one cluster, and its bar cannot detect a small edge

- n=12 closes, +0.66R mean, +$107. The four 2026-08-20 breakout longs made
  +8.52R of the lane's +7.87R total. The other 8 closes average -0.08R. That
  cluster is one bet, not four.
- The 2026-08-20 ETH entry risked $50 against the $8 floor.
- The same-direction cap (max 2, `scripts/scout-trade.ts:128`,
  `MAX_SAME_DIRECTION_MAJORS` at `scout-execution-guard.ts:92`) arrived
  mid-sample on 2026-08-20.
- **The registered bar.** It is >= +0.25R
  (`docs/scout/PREREGISTRATION_htf-trend.md:47`), times the 0.7 haircut, plus
  the largest-cluster-removed test (`docs/scout/playbook.md:284-287`). The bar
  is a search-budget stop, not a power-sized test, and it was never meant to be
  one.
- **Power.** With SD about 2.6R, n=20 cannot separate 0 from +0.14R under any
  bar. Detecting +0.14R at 80% power needs about 2,100 independent trades
  (one-sided), or 2,700 (two-sided). The v1 pass rates (18% / 24%) are
  unverified. A normal approximation gives about 27% / 35%. Only a simulation of
  the complete rule, cluster removal included, gives the real figure.
- **Exploratory backtest.** Frozen 20/10 rule, 2022-2026, 14 HL perps: +0.14R,
  t=1.7, with 2025 at -0.10R. The backtest is exploratory, already peeked at,
  and survivorship-biased: it uses only coins listed on HL today, and HYPE did
  not exist before late 2024. **It is a prior, not evidence.**
- **Execution.** `decision is not valid JSON`
  (`src/lib/scout/scout-cycle-business-logic.ts:97`) hit in about 11% of recent
  cycles. 3 of 13 entries filled 12-17h late.
- **Exits.** The exit variants scored worse than the frozen exit. The giveback
  is the price of the fat tail.

### F5. Catalysts are under-captured

- **Calendar.** `src/lib/skills/economic-events.ts:25-62` lists 5 events (Jackson
  Hole, CPI x2, FOMC x2). NFP, PCE and PPI are absent. Prep runs from hand-made
  per-event systemd timers. The prod cron
  (`src/lib/ladder/event-prep-alert-service.ts:7`) only sends reminders.
- **Missed event.** The FOMC prep on 2026-09-16 never ran (commit `0edc956`).
  BTC rose +7.4% and ETH +9.8% at 48h (unverified).
- **Straddle exits.** The template (`scripts/event-straddle-prep.ts:94-108`)
  reduces 34% at +1R, then 50% of the remainder at +2R. That banks **67%, not
  84%** (v1 error). A 33% runner trails from +1.2R, and a separate stall rung
  can reduce more.
- **Expiry.** The 24h expiry DISARMS pending rungs. It does NOT flatten the
  position (`src/lib/ladder/ladder-fire-service.ts:122`).
  - The residual is still stop-protected. `fireOpenOrAdd` places an
    exchange-resting bracket stop at fill. Any `stop_move` that fired before
    expiry replaced that order on the exchange, so the latest stop persists.
  - What the residual loses is the automation: adds, reduces, further stop
    moves and the trail. A runner then exits only on the static stop or by a
    manual action.
  - Live precedent: CPI straddle leg 9ddfcf7e expired 2026-10-15 12:31 with a
    residual short open. The resting stop protected the short, and it resolved
    at +$8.68.
  - `ladder-expiry-alert-business-logic` alerts only on UNFIRED expiries. Item
    5 extends it to the residual-position case.
- **Tails.** Moves kept running past 24h on 4 of the 5 measurable prints. ETH
  moved 1.2-2x as far as BTC (n=5, unverified).
- **Runaway drafter.** `runaway-alert-business-logic.ts:37,55` enters on a 3.5%
  pullback, plus a continuation add. "Fills underperform unfilled drafts" is
  partly tautological. A limit order below the extreme fills only when the
  continuation is weaker. The real question is whether fills are negative FROM
  THE FILL PRICE, and 11 fills (1W / 1L / 2 scratches) cannot answer it. A
  continuation entry will pay heavy overshoot in runaway volatility.
- **Reversion drafter.** Muted in prod, and killed in the scout at -0.55R over
  12 trades. Leave it muted.
- **Blackout** (`src/lib/scout/scout-execution-guard.ts:118,123`, -48h to +4h).
  Blackout stand-downs ARE logged (`docs/scout/playbook.md:336`; v1 said
  otherwise). What is missing is a structured counterfactual: the outcome of
  the refused trade. "Ghosts beat taken trades" would also compare different
  market conditions, so any test must pair outcomes per event.

### F6. Signal and process gaps

- **Missing signal families.** Implied vs realised vol (Deribit DVOL), and
  cross-venue funding (HL `predictedFundings` already returns Binance/Bybit
  rates, unused).
- **Partly used families.** OI-vs-price is context only. Spot-perp premium is
  stored and never scored. Leader liquidation prices are stored and never
  clustered.
- **Process gaps.**
  - Neither ladder-expectancy nor scout-review splits R by regime.
  - No time-to-graduation simulation exists.
  - No report covers R-distribution tails or realised gap-past-stop.
  - Nothing measures realised correlation between lanes.
  - Sample sizes count trades, not independent episodes.
- **Not read-only.** `pnpm scout:review` inserts a `scout_reviews` row
  (`scripts/scout-review.ts:88`).
- **Idle capital.** HLP would earn about $1-2/month on a safe slice.
  Deprioritised.

## The plan (v2, ranked)

| # | Change | Why | Test / bar | Effort |
|---|---|---|---|---|
| 0 | **Reconciled evidence bundle.** Commit the reconstruction scripts (fills to round trips, `ladder_outcomes` join, straddle count, scorecard inputs) under `scripts/analysis/`. Reconcile the fill ledger with `ladder_outcomes`. | No number in this doc is verified. The F1 and F3 counts disagree. Reconcile "trend-follow +$164" against `ladder_outcomes` trend-follow-8h-long (net $112.90, 27 closed, +0.19R as of 2026-10-19). Exclude `stop_move` rows and trigger-0 indicator reduces from the fire-to-fill join (the pitfall in `DESK_PROFITABILITY.md`). | One reproducible run that every later verdict cites | S-M |
| 1 | **Fix the lane scorecard.** Five fixes: per-session windows, quantity netting, historical funding, funding charged to the holding lane, per-lane registered bars and periods. Then re-score compression-straddle, and apply its bar only if the fixed code shows a negative net. | F2 | Unit tests with cross-session and partial-exit fixtures. Re-run the 10-13 and 10-19 scorecards inside the Monday retro, so the weekly cadence stays the multiplicity guard. | S-M |
| 1b | **Fix `ladder_outcomes` attribution.** Attribute fills to ladders by their order ids or cloids, not by coin-and-window. Then backfill the existing rows. | F1: overlapping windows double-count P&L, so every ladder verdict is inflated | Fixture: two overlapping ETH ladders must sum to the fill total. Backfilled totals must match item 0. | S-M |

| 2 | **Make `scout:review` read-only by default** (`--write` to persist). | F6 | Existing tests | S |
| 3 | **Report both R units.** Add an `event-straddle` setup type. Add nominal-R and realised gap-past-stop beside slip-aware R. Keep slip-aware R for the arm cap. | F3 | Do NOT set a new pass bar after seeing these 6 trades. Pre-register the event lane's bar on fresh fires only. | S |
| 4 | **Calendar and prep reliability.** Add NFP, PCE and PPI. Move straddle prep to the prod cron at T-30, with duplicate-prep protection. Prep creates `mode: 'live'` drafts; arming stays manual. | F5. **Land after the 2026-10-28 FOMC.** Do not change that print's prep path mid-flight. The proven path is a manual `pnpm straddle:prep` at T-30 plus the prod Discord ping (4-event track record). | Prints prepped / prints listed = 100%; no duplicate drafts | S |
| 5 | **Pin and alert the post-expiry residual.** Pin the resting-stop persistence with a test. Extend the expiry alert to a residual open position, because the trail stops ratcheting at expiry. | F5 | Test: expiry with an open position leaves the latest resting stop on the exchange and sends an alert | S |
| 6 | **Deterministic htf-trend entries** in the daemon; the model only vetoes, with logged reasons. **Version the ledger at the switch date**, because the change alters the paper rule mid-sample. | F4: JSON failures, late fills | Fill latency and parse-error rate before vs after | S-M |
| 7 | **htf-trend historical replay as a PRIOR only.** Point-in-time listings including delisted perps, lagged signals, executable prices, funding, the whole capped portfolio, time-blocked folds, and cluster resampling. The forward paper record (from 2026-08-06) stays the only out-of-sample gate. Simulate the complete registered rule to get real pass rates. | F4 | No pass/fail on the replay alone | M |
| 8 | **Shadow-test the straddle exit variants** after item 5: a longer window, a trail-only runner, no +1R bank, and an ETH leg. Do not change the live template first. | F5 | Paired per-event comparison with uncertainty and downside limits; n counted in events, not legs | S-M |
| 9 | **Shadow-test the runaway entries.** Measure the existing fills from the fill price. Compare pullback vs continuation vs split, with identical horizons, costs, stops and overshoot. | F5. The desk-retro discard vet already replays unarmed and expired drafts. The 2026-10-16 vet showed a pruned HYPE runaway as a dodged stop at -1R, so the unfilled set is not obviously money left behind. | Paired executable outcomes; correlated drafts collapsed to episodes | M |
| 10 | **Structured blackout counterfactuals.** Record the refused trade's would-be outcome next to the existing stand-down log. | F5 | Paired per-event comparison; no exemption on raw "ghosts beat taken" | S |
| 11 | **Research queue**, each pre-registered and only after 0-4: DVOL filter on straddles, OI-direction filter on htf breakouts, cross-venue funding as a crowding veto, regime-split expectancy, episode-based n. | F6 | Kill bars set per pre-registration | M each |

Item 1b implementation note: older ladder orders did not send the stored rung cloid to HL.
New fires record entry, reduce, stop and take-profit oids in `ladder_fires.detail`.
The outcome resolver now walks the full account fill stream by coin. An opening fill
uses its recorded entry oid first. Historical entries match the nearest unclaimed
filled open/add fire from one second before to ten seconds after its fire time.
Unmatched openings are manual lots. Closing fills consume lots FIFO, including
resting stops and position flips. Funding is excluded. The backfill prints per-coin
conservation and ladder/manual totals. `--write --backup PATH` requires a backup
and refuses an incomplete fill history or a conservation failure. The historical
ladder total still needs a dry run against account data before it is cited.

### Performance page (agent-first)

The storyboard has 5 frames: Overview, Lanes, Forecast, Change log and Phone
(Claude artifact "Lane Performance storyboard"). Build it agent-first, so the
weekly retro reads the same numbers as the page in one command:

1. **One pure core.** A pure module, `src/lib/performance/lane-performance-business-logic.ts`,
   computes the per-lane series, the marker splits and the forecast. Three
   consumers share it: the API route, the cockpit UI and a CLI. The UI does no
   maths.
2. **CLI first.** Add `pnpm perf:report [--since <date|last-retro>] [--lane <id>] --json|--md`.
   The JSON schema is versioned. Every figure carries `n`, its unit
   (nominal R, slip-aware R or $) and its source table. The command is
   read-only by default.
3. **Change markers table** (`change_markers`), with these fields: `at`,
   `kind`, `lanes[]`, `title`, `note`, `source`
   (commit / manifest / prereg / flag / manual), `ref`, `proposed_by`,
   `confirmed_by`.
   - Agents PROPOSE markers with `pnpm perf:marker propose ... --write`.
   - The retro auto-suggests markers from commits under `src/lib/scout` or
     `src/lib/ladder`, manifest versions, new pre-registrations and flag flips.
   - A marker splits lane stats only after the operator confirms it in the UI.
4. **Forecast snapshots table** (`forecast_snapshots`). The retro freezes each
   month's forecast with `pnpm perf:forecast --freeze --write`, storing the
   inputs hash and P5-P95. Month-end scoring is automatic, so the forecast's
   track record is visible.
5. **desk-retro integration.** The skill runs `perf:report --since last-retro --md`
   first and quotes it verbatim, then lists the proposed markers for the
   operator to confirm. No retro numbers are re-derived by hand.
6. **Order.** Build after items 1 and 1b, because the page must not show the
   double-counted ledger.

### Explicitly not doing

- Breakeven or trailing-stop changes on htf-trend.
- Reviving reversion or funding fades.
- Sizing up any lane before its verdict. In particular, no size-up decision may
  read nominal R without realised gap-past-stop beside it.
- HLP or HYPE staking for idle cash.
- Any change to live-firing behaviour without a pre-registration and the
  adversarial ladder panel.

## Live state at review time (2026-10-24)

- The book is flat, and nothing is armed.
- Two runaway auto-drafts are queued and un-armed: ETH 97dfe492 and HYPE
  79e9d786. Any arm gets a pre-FOMC expiry.
- The FOMC prints on 2026-10-28 at 18:00Z. Its prep uses the existing manual
  path (see item 4).
- The next desk retro runs Monday 2026-10-26 at 13:03, in the Ladder Expert
  session.

## Review record (v1 to v2)

| Point | Sol | Astra | Fable | v2 action |
|---|---|---|---|---|
| Scorecard defects real; kill only after the fixed code reproduces it | Yes | Yes, plus notional netting | Yes, plus per-lane bars | F2 expanded; item 1 |
| "84% banked" is wrong (67%); expiry does not flatten | Yes | Yes | Yes | F5 corrected; item 5 added |
| Nominal R is useful, but the slip-aware unit has a purpose | Keep both | Keep both | Keep both, plus gap-past-stop | Item 3 |
| A historical replay cannot be deciding evidence | Supporting only | Peeked, survivorship | Prior only | Item 7 reworded |
| Pass rates of 18% / 24% unverified | Yes | Calculates about 27% / 35% | Bar is +0.25R x 0.7 | F4 corrected |
| Runaway inference plausible, not established | Yes | Yes | Partly tautological | F5 and item 9 |
| Small-n promotion rules repeat the n=20 problem | Implied | Yes | Count episodes | Items 8-10 use paired, episode-based tests |
| Unverified numbers need a reconciled bundle | Yes | Yes | Reconcile F1 vs `ladder_outcomes` | Item 0 added |
| Wrong file path for ladder-expectancy | Yes | n/a | Yes | Fixed |
| Blackout refusals ARE logged | n/a | Yes | n/a | F5 corrected |

The Ladder Expert session reviewed v2 with live ladder context and returned
ACCEPT. Its additions:

- The post-expiry residual keeps its resting stop (precedent 9ddfcf7e). Item 5
  becomes a test plus an alert.
- The reconciled straddle count is 2 fired. +0.56R is withdrawn.
- Item 0 gains the join pitfall and the trend-follow reconciliation.
- Item 4 waits until after the 2026-10-28 FOMC.
- Item 1's re-scores run inside the Monday retro.
- The live-state section above was added.

## Shipped and follow-ups (updated 2026-10-24)

Shipped to main (e6bfabc, then the polish loop to 3a9441b): items 0, 1, 1b and 2,
the validation gates, seven live-path fixes, migration 0045 (applied before the
push), the ladder_outcomes backfill (75 rows, backup in ~/hl-backups/), and three
polish-loop iterations (2 High and 1 Critical caught before deploy, plus 20
Medium).

Performance page (agent-first): shipped 2026-10-24 (583deae backend, 1ca2040
Lanes view). Migration 0046 applied and verified. The NAS checkout was updated,
and its scorecard writer now records compression-straddle at -$12.39, KILL
(19:50 UTC). Caveat: the forecast resamples whole episodes, so its downside
(P5, worst 30-day loss) is optimistic until more trades accumulate.

Items 3, 5, 7, 8, 9, 10 and 11 shipped to main on 2026-10-24 (03db6aa, 70e4ede),
with migrations 0047 and 0048 applied. Items 4 and 6 and the live Low follow-ups
wait on branch `post-fomc-2026-10` (migrations 0049-0051). Do not merge that
branch before 2026-10-29.

### Study results on real data (2026-10-24)

No study crossed a bar, so no live change follows.

- **htf replay (item 7, prior only):**
  - All coins: -0.065R (95% CI -0.18 to +0.05), n=8,275, 242 episodes.
  - Registered four coins: +0.33R (CI -0.16 to +1.00), n=132. Twelve 2023 trades
    at +2.9R carry that figure.
  - Read: no all-coin edge after 2023. The forward bar has about a 1% pass chance.
- **dvol, oi, funding-veto:** insufficient evidence (n=6, n=10 and n=0 against
  bars of 15, 20 and a filled archive).
  - funding-veto needs captures: the NAS tick (`scripts/nas-watch.sh`) runs
    `pnpm study:funding-veto -- --capture` at 07:55, 15:55 and 23:55 UTC.
- **regime split (descriptive):** most cells have fewer than 5 observations.
  - Scout `reversion` in bearish regimes: -0.80R (n=6, 2 episodes).
  - Scout `htf-trend` in bullish regimes: +1.11R (n=7, 3 episodes).
  - Treat both as retro discussion points, not verdicts.

Deferred Low items (fix in a later session, not in the loop):

- `releaseOcoClaim`: the check and the delete are separate statements; a ladder
  with several open rungs could race. Straddle legs have one open rung.
- Keep brackets (rungs with a `targetPx`) unexercised through the 2026-10-28
  FOMC. The read-back excludes pre-submit oids, but the path has never fired live.
- `submitLiveOnce` never evicts successful fills in a long-lived process.
- `snapshotFromCandleResult` hardcodes `WATCH_CANDLE_MS` (15m).
- The add-opposite-side path marks the fire failed but the rung skipped.
- `flattenAfterFault` could cancel the just-placed stop and TP oids it knows.
- `ladder-service.ts` (680 lines) and its test file need a split.
- `.claude/skills/desk-review` says disarm "cancels resting orders"; it does not.
- Performance view: label the closed-only KPIs ("realised"), and rename
  `openUnrealized`, which is now fee-net.
- Account scorecard: show "all-history funding" in the visible label.
- CI: pin actions by SHA; use 127.0.0.1 for dummy URLs.

## Research lane (2026-10-26)

Opus, Fable and Astra (Codex) reviewed the desk independently. They agreed on three points:
- Capital is the binding constraint.
- The event lane is the anchor.
- htf-trend should stop as a graduation candidate.

Five follow-ups ran, each pre-registered before data:

1. **Catalyst classes** (`study:catalyst-classes`, Binance 15m, 2024-01 to 2026-10). No class clears the bar (BTC T+2h median above 1.0% and 24h continuation above 50%).
   - CPI moves about 2x noise (1.17%) but continues only 45% of the time.
   - FOMC moves 0.54%, close to noise.
   - NFP, PCE, PPI and ECB do not clear the bar.
   - Read: do not add NFP, PCE or PPI straddles. Test faster CPI exits in the straddle-exit shadow.
2. **Entry overshoot.** Event legs average 0.26R overshoot (n=6) against the 0.2R build bar. One 1.23R leg carries the mean; without it, the mean is about 0.07R. A design review of resting entry triggers comes first; nothing merges before FOMC.
3. **HIP-3 earnings straddles** (`study:hip3-earnings`). FAIL: +0.13R mean (n=38). The top-3-removed mean is -0.35R.
4. **Spot-perp carry** (`study:spot-perp-carry`, 4h). BTC, ETH and SOL FAIL at 3.7-5.1% APR against the 6% bar. HYPE and the basket are INSUFFICIENT, and the 2026 basket run rate is about 3% APR. A 3x short leg would have needed top-ups in the ETH, SOL and HYPE rallies.
   - Open: `fundingCarryBenchmark` never re-enters after a funding flip, so the scorecard carry control understates the lane.
5. **Capital rule** registered in `docs/scout/PREREGISTRATION_capital-rule.md`. The first count is the November freeze (2026-11-02 retro).
