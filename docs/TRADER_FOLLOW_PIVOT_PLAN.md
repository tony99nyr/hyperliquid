# Trader Follow/Discovery Pivot — Implementation Plan (FOR REVIEW)

> **Status: REVIEWED & ADOPTED (2026-06-25) — implementation started.** The companion
> `TRADER_FOLLOW_PIVOT_PLAN_REVIEW.md` was adopted IN FULL. Material deltas vs the
> phases below: **A3** Phase 2b/PR-3 is **Python-on-worker (NOT a TS port)** — no parity
> test; **A2** adds **Phase 4.5 small-live vetting gate** (Phase 5 ships hard-capped-tiny
> first; operator pre-commits N / excess-over-hold / concentration cap / ≥1 regime;
> clearing it is *necessary not sufficient*) + hard going-live gates (operator-set size
> caps, circuit-breaker ON, auto-exit slow-drift backstop, kill-switch default `paper`);
> **A4** on-demand vetting emits a single-window fingerprint + frozen
> `persistenceConfidence: 'multi-window'|'single-window'|'insufficient'` enum (certifies
> operational feasibility, NOT forward profit); **A5** Favorites' Plays defaults to NEW
> opens (profitable = secondary, extension-gated); **B1** study selected by win-rate/
> consistency (not copyability); **B2** follow trim = operator-editable suggested default
> (keep `fraction` mechanic, don't auto-fire); **B3** Phase 6 = eligibility gate +
> confidence badge, no hard numeric cut. **A1** the study figures are iamrossi-sourced /
> unverified-here — pre-flight-verify against `iamrossi/data/backups/perp-follow-study/`
> before any real-capital follow. Phase 5 safety stack needs a dedicated audit before PR-6.
>
> Self-contained: an agent
> should be able to critique/act on this without the originating chat.
> Pairs with `docs/TRADER_DISCOVERY_AND_FIXES_PLAN.md` (the discovery/evaluation
> handoff this plan absorbs) and the data-processing cost audit.
>
> **Provenance:** drafted with the operator, then hardened through **3 polish-loop
> review rounds** (safety / cost-dependency / scope lenses). R1 added the
> scout-decoupling phase + redesigned follow-sync + made the drill-down chart
> net-new. R2 killed a false-premise broad-positioning snapshot (no such job
> exists), found a 2nd scout consumer, and caught follow-sync display/flip safety
> gaps + the HL 5000-candle cap. R3 corrected discovery facts inherited from the
> handoff doc (Python engine vs the partial TS reimpl; the real dataset-lock; the
> off-leaderboard discovery source) and moved chase/risk context to the decision
> point.
>
> **What to scrutinize most:** (1) the Phase-2b "port the Python copyability engine
> to TS" decision; (2) the Phase-5 follow-execution safety stack; (3) whether
> "favorites'-plays as opportunities" invites chasing; (4) the rollout slicing.

## Context

The operator has lost faith in self-generated alpha (UI "Opportunities," discretionary charts, autonomous scout — all feel random). New thesis: **some other trader has built a better alpha engine; optimize to FIND them and FOLLOW them.**

Goals: (1) cut data cost — `trader-watch` polls top-50 @60s = ~72k HL calls/day; gate to **favorited** traders; (2) repurpose Opportunities into *favorited traders' new/profitable positions*; (3) refactor the trader panel — sortable/filterable table, trader + **position drill-down** (when-opened + entry-vs-market chart + health), **favorite**, **follow**; (4) **build real trader discovery/evaluation** (the "find" half, done right).

### Prior evidence — what it rejects, and what it does NOT (`PERP_FOLLOW_STUDY_V2`, config `wallet-selection-hl-copyability-v0.1.1.json`)
The study tested **AUTONOMOUS, MECHANICAL mirroring** — auto-copy *every* trade of leaders selected by past copyability, no human, no overlay:
- Mechanical exhaustive mirror = **−0.15%/trade** (after 4.5bps taker + slippage + funding), **dominated by our own regime detector (+1.93%/trade)**.
- **Copyable-edge persistence is NEGATIVE (IC −0.50)** — selecting a trader *because they were copyable* doesn't predict they stay copyable. Only **HL vaults persist (IC +0.223)**. Latency is a red herring.
- **This does NOT reject the operator's model.** The operator's model is **human-discretionary**: favorites' positions surface as *opportunities*; the operator chooses which/when to enter, with their own timing and stop. That IS the study's *recommended* alternative — "leader as an entry **signal** + our own overlay + our own stop" — where **the operator's discretion is the overlay**. The study can't measure a discretionary model.
- **So the findings are DESIGN INPUTS, not blockers:** because a trader's edge doesn't persist, the tool must **arm the operator's discretion** (copyability verdict, position health, entry-vs-market context, own stop) rather than imply "copy the green ones"; **flag averaging-down leaders** (`adds/trip`); **surface vault-backed** names (the one persistent signal).

### Locked decisions
- Scout + rubric: **keep running** (rubric stops feeding the UI, keeps feeding the scout).
- Follow execution: **human-discretionary** — the operator selects entries from presented opportunities and approves every entry/adjustment (**alert + 1-click approve, never auto-fire**). Not autonomous mirroring; the operator's discretion + own stop is the overlay the evidence calls for.
- Rating/discovery rework is in scope — **reuse the copyability engine v0.1.1, do not reinvent it.**

## Core principle — ONE evaluation, TWO consumers (discovery doc §4, ADR-0002)
Every trader evaluation is **persisted once** (a `trader_evaluations` row, service-role write) and consumed by both the **UI** (anon select → renders verdict+charts) and **Claude** (a `review-trader` skill reads the same row). No UI-only computed stat Claude can't see; no CLI-only output the UI can't render.

## Current state (verified across all three review rounds)
- Cost scales linearly with the watch-set (**8 favorites ≈ 11.5k/day ≈ 84% cut**). `getTopTraders()` is a pure fs read of a **weekly external** `rated-wallets.json` (zero HL calls); the only in-repo broad-positioning fetcher is trader-watch itself.
- **Discovery dataset-lock (re-scoped in R3):** the real blocker is NOT a single throw at `analyze-traders.ts:51` — it's the silent `.filter()` of un-rated addresses plus `buildCopyMonitorAnalytics` no-oping its metric alerts when `rating===null`. `scripts/_research-trader.ts` (read-only, written earlier) computes a copyability fingerprint for ANY address off HL's public API, **but only a SUBSET** of the canonical metrics.
- **Canonical rating engine is Python** (`scripts/analysis/wallet-rating/hl_copyability_metrics.py` `extract_metrics`: `reserveMultiple`, `majorsShare`, `subMinuteFrac`, net-of-cost return, `positiveSubPeriodFraction`, …) — a weekly NAS re-rank, not wired to on-demand UI/Claude. `_research-trader.ts` does NOT compute these.
- **"Median Hold" UI stat is misleading** (`TraderDetailDrawer.tsx:228`): unstable across windows (90h/133h/67h/175h), hides bimodal behavior, shown without copyability context.
- `leader_positions`/`leader_actions` are OFF realtime (migration `0014`) → reads POLL. **Silent-baseline gotcha:** first observation writes positions but no `leader_actions` → entry must come from `leader_positions.entry_px`; `detected_at` is "first seen," not fill time.
- **Two scout consumers degrade if the watch-set shrinks:** `leaderConsensus()` (`rubric-inputs-service.ts:86`, no favorites filter — **but has freshness decay-to-neutral** at :108-118) and `recentLeaderDerisk()` (`rubric-scan-service.ts:23`, no decay).
- Opportunities: `OpportunityBoard`'s `useRubricScores` is inert; live owner is `CockpitView` (`rowsOverride` + chart `selectedOpp` overlay via `toCardModels(RubricScoreUiRow[])`). `WhalePosture.coveringCount` needs `leader_actions`.
- Traders = full-screen `traders-view` tab (not the rail); `TopTradersRail` owns `selected`, renders `TraderDetailDrawer` (has `detailOverride` test seam). Inner `CandleChart` is generic; `candle-service.fetchCandles` accepts `endTime` (only `/api/hl/candles` hardcodes `end=now`); HL caps ~5000 bars/response. Auth = cookie-HMAC; new write routes mirror `approve/route.ts` (verifyAdminAuth + isSameOrigin + rate-limit) → service-role.

## Plan

### Phase 0 — Graceful scout degradation (no new HL cost; replaces R1's broad snapshot)
Don't build a broad-positioning snapshot (no existing job feeds it; a new fetcher re-adds ~2.4–7.2k HL calls/day). Lean on the existing freshness decay-to-neutral in `leaderConsensus()`, and apply the **same decay-to-neutral to `recentLeaderDerisk()`** so BOTH scout consumers degrade to "no signal" (never lie) once the watch is favorites-scoped. Keeps the 84% cut intact.

### Phase 1 — Data model + favorites-gated watch (the cost win)
- **Migration `0015`:** `favorited_traders`; `followed_positions` (`status active|ended`); `trader_evaluations` (fingerprint + copyability verdict + hold distribution + per-coin round-trip series + window/freshness); `pending_actions.dedupe_key` + partial unique index (Phase 5 idempotency). Operator-global. RLS mirrors `0004` **anon SELECT only, no anon write**, NOT on realtime; **test asserts anon cannot write.** (Also verify `leader_actions.kind` + `leader_positions.unrealized_pnl` exist in `0004`; if not, fold column adds here.)
- **Write routes** `/api/cockpit/{favorites,follows}` mirror `approve/route.ts` auth → service-role; add AND remove.
- **`watch-set-business-logic.ts` (PURE):** `resolveWatchSet(favorites, activeFollows)`; seed favorites first-run from top-composite traders.
- **Daemon:** read the set each cycle; **prune in-memory `prior` for removed addresses**; **durably delete `leader_positions` for any address in DB/`prior` but not in the current set, computed from the SAME watch-set read used to tick** (route-side un-favorite delete = best-effort fast-path, not the sole mechanism — otherwise a mid-cycle reconcile re-upserts orphans).

### Phase 2 — Discovery & on-demand evaluation (the "find" half) — own track (2a UI / 2b backend)
- **2a P0 honesty fixes (UI, no migration — ship first):** fix the median-hold stat (`TraderDetailDrawer.tsx:228`) → round-trip `n` + `adds/trip` + live open-age + p10–p90 hold range, marked sample-dependent. **Dataset-lock:** make `gradeCandidate`/`buildCopyMonitorAnalytics` tolerate `wallet:null` (fetch+grade on the fly), keep the INSUFFICIENT_HISTORY gate.
- **2b On-demand vetting, persisted (dual-consumer):** **port `extract_metrics` (Python) to TS as the single source of truth** (a Vercel route can't shell `python3`; the daemon host could, but two engines drift) so the on-demand path emits the **full** fingerprint, not the partial one `_research-trader.ts` has now. Promote it to a **queued/persisted job** (write `pending` → daemon/worker fills → UI/skill poll; sync compute is multi-second due to deep `fetchAllFills`). Writes a `trader_evaluations` row; a `review-trader` skill reads it. **Freeze the row shape = `RatedWalletMetrics` + `{verdict, holdDist p10–p90, roundTripSeries, window, freshness}` as a typed contract** before 2a/2b/Phase-3 build against it.
- **Candidate funnel:** `01-discover-addresses.ts` is **off-leaderboard L1 block-sampling** (NOT a leaderboard pull) and a ~38-min batch crawl — wire it as an **offline batch feeding a candidates table**, dedupe to distinct addresses, **rank by the copyability grade, not block-frequency** (block-freq over-represents high-churn martingale whales — the risk shape we exclude). A leaderboard cohort, if wanted, is `05-leaderboard-comparison.ts` (separate source).
- **Persistence-aware screening:** require multi-window stability (not one snapshot); **prefer vault-backed** names; gate on **`adds/round-trip`** + `worstLossVsMedianWin`.

### Phase 3 — Trader panel + vetting surface — build on the `traders-view` tab
- **Convert the rail/cards into a sortable, filterable TABLE.** Columns tell the trade/profit/risk story: net-of-cost return, median hold + p10–p90, conviction (majorsShare / concentration / #positions), risk-health (reserveMultiple, worstLossVsMedianWin, liquidations, drawdown), win-rate, `adds/trip`, vault badge, copyability verdict. **Client-side sort + filter** over loaded rows (dataset already in memory server-side → cheap): sort by most-profitable / shortest-hold / risk-health / any column; filters (min profit, max hold, risk caps, vault-only, exclude flagged). **Load-more** extends rows with an exhausted state. Row click → drawer/detail. **Favorite star** add/remove inline → `useFavorites()`.
- **Trader drill-down:** keep `TraderDetailDrawer` + `useTraderPositions`; render the `trader_evaluations` verdict: **copyability headline (follow/caution/avoid) + the *why***, hold distribution + `n` + live open-age, labeled chips, equity/realized-PnL curve, **source/freshness badge**. HL-only/non-favorited traders hide the timeline.
- **Position drill-down:** the position view **replaces the drawer content** (single dialog; lift `selectedPosition` into `TopTradersRail`, thread `onPositionClick`).
  - **New `PositionHistoryChart`** split like `CandleChart`/`CandleChartPanel`: inner takes **injected `candles` + overlay levels, no fetch** (test seam) + a thin fetching container.
  - Entry line from `leader_positions.entry_px`; **window:** add optional `endTime` to `/api/hl/candles` + `fetchCandlesViaProxy`, **interval by entry-age** so bars < ~4000 (avoid HL's 5000 cap dropping the entry bar).
  - **"market-then":** `leader_actions`-backed opens → candle at `detected_at` (labeled "first detected"); silent-baseline/HL-only → drop that leg, label "entry vs now (held before we watched them)."
  - Health: new PURE `position-health-business-logic.ts` (liq-distance + drawdown bands → badge); HL-only = live liq-distance only.
- **Follow button** add/remove → `/api/cockpit/follows`.
- **Testing:** override-prop seams (mirror `detailOverride`) + realtime-mock emit/queueResult — **no DB-seeding harness exists.**

### Phase 4 — Repurposed Opportunities → "Favorites' Plays"
- PURE `favorite-plays-business-logic.ts`: favorites' recent `leader_actions` `kind='open'` (NEW) + favorites' `leader_positions` `unrealized_pnl>0` (PROFITABLE). `useFavoritePlays()` snapshot-polls.
- **Anti-chase at the decision point:** a "profitable open" structurally surfaces the most-*extended* entries → the card MUST show `leader_entry_px` + **% extended from leader entry** (entry vs current mark). The deep entry-vs-market view is Phase 3's chart; the **card** needs the one-number extension badge.
- **Verdict on the card:** thread `adds/trip` + `worstLossVsMedianWin` warnings and a **vault-backed positive badge** from `trader_evaluations` onto the play card — gating discriminators must appear where the entry decision is made.
- **New favorite-play card model + board — do NOT route through `toCardModels`/`rowsOverride`** (no `chosenSide`/entry/SL/TP). Integrate at `CockpitView`; **chart `selectedOpp` overlay = derive from `leader_positions.entry_px`/`liquidation_px`** (rubric feed retired from the UI). **Relabel `WhalePosture` to favorites-only** (keep its `leader_actions`/`coveringCount` source).

### Phase 5 — Follow execution: discretionary signal + alert + 1-click approve (NOT autonomous mirror)
Following is **discretionary**: favorites' positions surface as opportunities (Phase 4); the operator chooses entries with their own timing/stop; "follow" tightens tracking on a chosen leader position and **alerts on the leader's changes as a suggestion** — every entry/adjustment human-approved, nothing auto-fired.
- `useFollowedPositionAlerts()` snapshot-polls `leader_actions` for active follows; triggers **only on positively-written event rows**, never inferring exit from an absent snapshot.
- **Reduce-only matching route** builds from the operator's OWN live position (`loadPosition`) via `buildMarketReduceOnlyClose` — leader gives **direction only**; **build `display` from the reduce-only intent** (close side, `reduceOnly` badge; safety test `display.side===closeSide`); **`flip` guard:** stage only when the operator's live side matches the leader's `prev_side`, else stage nothing+log.
- **Proportional, not full-close:** on a leader `reduce`, derive `fraction = leaderReduceSz / leaderPrevSz` and pass to `buildMarketReduceOnlyClose` (supports `fraction`). Leader `close` → full reduce-only close. Leader `add` → suggest an *add* (operator-approved entry). Leader `flip` → flip-guard.
- **Idempotency via DB constraint:** `dedupe_key = hash(leader_action.id)` + `createPreview` upsert `onConflict ignoreDuplicates` (collapses idempotency+lock). Session: `getActiveSession() ?? openSession()`; no matching own position → stage nothing+log. Defense-in-depth: executor rejects zero-fill reduce-only (`safe-exit/route.ts:190`). Lifecycle: leader `close` → follow `ended` after the match resolves.
- **Arm the overlay:** surface a suggested stop / liq-distance on the discretionary entry preview so "own stop" is an affordance. Guardrail: averaging-down leaders flagged on the play card + vetting view; vault-backed get a positive badge (reconcile with the existing `VAULT_LED` *warn* flag — distinct labels for "vault flow polluting a single-trader read" vs "follow the vault itself, which persists").
- **No-auto-fire:** only `preview/decide` executes, behind admin auth + typed confirm; Claude/poller cannot reach the execute path.

### Phase 6 — Redefine "top traders" + widen the pool (rating rework; reuse v0.1.1 metrics)
The operator wants **smart, high-conviction** traders and worries the current "top-50 by composite" baseline excludes ideal names. Rating is static-dataset + on-demand → widening is cheap and does NOT touch the favorites-gated live watch.
- **Widen the pool:** raise the browsable N and **lower the inclusion baseline** so high-quality-but-currently-excluded traders surface in the Phase-3 table (let sort/filter narrow, not a hard top-50 cut).
- **Redefine "top" = smart + high-conviction**, on the existing copyability metrics: profitability = **net-of-cost return**; conviction = **majorsShare / concentration / meaningful size** (penalize over-diversification + dust); risk discipline = **reserveMultiple, bounded worstLossVsMedianWin, 0 liquidations, no martingale flags**; mirrorable **hold band**. Surface every sub-score as a Phase-3 column/chip — reweight + expose, don't reinvent the scorer.

## Key files
- **New:** `0015` migration; `/api/cockpit/{favorites,follows,research-trader}` + reduce-only route; `research-trader`/`review-trader` skills; `useFavorites/useFavoritePlays/useFollowedPositionAlerts`; `watch-set/favorite-plays/position-health-business-logic.ts`; `PositionHistoryChart` + position-detail view.
- **Promote/modify:** `scripts/_research-trader.ts` (→ TS engine + skill + endpoint + persist), `analyze-traders.ts`/`copy-monitor-analytics.ts` (null-rating grade path), `TraderDetailDrawer.tsx` (median-hold + evaluation render); `leader-watch-service.ts`, `scripts/trader-watch.ts`; `rubric-inputs-service.ts` + `rubric-scan-service.ts` (decay-to-neutral); `CockpitView`/`OpportunityBoard`/`WhalePosture`; `/api/hl/candles` + `fetchCandlesViaProxy`.
- **Reuse (don't reinvent):** copyability engine v0.1.1 (`scripts/analysis/wallet-rating/**`, `hl_copyability_metrics.py`), `01-discover-addresses.ts`; inner `CandleChart`; preview→decide pipeline + `buildMarketReduceOnlyClose` + `loadPosition`; `approve/route.ts` auth; `detailOverride` test seams.

## Verification
- **Unit:** watch-set (union/empty/prune), favorite-plays, position-health, follow stale-guard (no row→no action), reduce-only sizing-from-own-position + `display.side===closeSide`, flip-side guard, proportional `fraction`, idempotent createPreview, anon-cannot-write RLS, TS-engine fingerprint vs Python `extract_metrics` parity, evaluation row dual-read (UI shape == skill shape).
- `pnpm validate` + `pnpm smoke`.
- **Manual E2E:** vet an arbitrary (un-rated) wallet → `trader_evaluations` row renders verdict+chips+hold-dist and a skill reads it; favorite → cycle populates `leader_positions`; un-favorite → durable cleanup; position drill-down → entry vs now + health + correct label; follow → leader reduce → proportional reduce-only match sized from MY position (stale cycle/duplicate poll → no extra popup).
- **Cost check:** trader-watch HL/day after gating (~80%+ cut; no new broad fetcher).

## Rollout (PR slices — ship incrementally, don't land as one)
1. **PR-1 "stop lying" (no migration):** Phase 0 decay on `recentLeaderDerisk` + Phase 2a median-hold fix + dataset-lock null-rating path. Zero schema risk, demoable.
2. **PR-2 cost win:** Phase 1 migration `0015` + favorites-gated watch + write routes.
3. **PR-3 discovery backend (parallel):** Phase 2b TS-port + queued `research-trader` job/endpoint + `trader_evaluations` writer + candidate batch. Shares only the frozen row-shape contract with the UI.
4. **PR-4 trader table + vetting surface:** Phase 3 + Phase 6 columns. Depends on PR-2 + PR-3 contract.
5. **PR-5 Favorites' Plays:** Phase 4.
6. **PR-6 follow execution:** Phase 5.

A–G coverage: A (load-more) B (drill-down) C/D (position chart + health) E (follow) F (favorite + favorites-only watch) → Phases 3/1; **G (subscribe to a followed position's changes / keep matched) → Phase 5.** All covered.

## Guardrails / out of scope
- **No-auto-fire**; INSUFFICIENT_HISTORY/data-completeness gate kept; **don't trust a single-window grade** (screen persistence, prefer vaults); `adds/trip` + `worstLossVsMedianWin` are the gating discriminators; one-evaluation-two-consumers.
- Out: auto-mirroring; HL `userFills` exact fill-time; a broad-consensus fetcher.

## Open questions for the reviewing agent
1. **TS-port vs Python-on-daemon** (Phase 2b): is reimplementing `extract_metrics` in TS the right single-source-of-truth call, or should the on-demand job run the existing Python on the daemon host and the cockpit stay UI-only? Parity-test burden vs drift risk.
2. **Chase risk** (Phase 4): is the per-card "% extended from leader entry" badge sufficient, or should profitable-but-extended plays be down-ranked/hidden by default?
3. **Follow proportionality** (Phase 5): is "trim my position by the leader's reduce fraction" the right keep-matched suggestion, or should it be a simpler "leader reduced → suggest you consider trimming" with operator-chosen size?
4. **Widened "top" baseline** (Phase 6): how low to drop the inclusion threshold without flooding the table with under-sampled/INSUFFICIENT_HISTORY names?
