# Review — `TRADER_FOLLOW_PIVOT_PLAN.md`

> Companion review by a second agent. Reviews the 3-polish-round plan against
> primary sources read this session (`perp-follow-study/study-config.ts`,
> `hyperliquid-persistence/lib.ts`, the copyability configs, `hl_copyability_metrics.py`,
> the live HL profile of `0x795cfd…a242`). Paste-ready edits included.
>
> **Overall: endorse the plan's structure.** The phasing, the favorites-gated cost
> win, and the one-evaluation-two-consumers principle are sound. My edits concentrate
> on **the strategic framing (the evidence section) and one engine decision** — where
> the plan is more confident than the evidence supports.
>
> **Scope caveat:** the Phase 5 follow-execution safety stack (reduce-only routing,
> flip guard, idempotency, zero-fill defense) *reads* well-designed and is the
> plan's most-polished area — but this review did **not** line-by-line audit it.
> Given it's the real-money execution path, **a dedicated safety audit of Phase 5 is
> recommended before PR-6 ships** (don't treat "looks solid" as "verified").

---

## A. Must-fix (substantive)

### A1. Provenance — the study numbers are second-hand and NOT in this repo
The plan (lines 28–33, and again in Phase 4/6) states −0.15%/trade, +1.93%, IC −0.50,
+0.223 as established fact. **They are not verifiable from this repo.** The primary
report (`HL_PERSISTENCE_STUDY_2026-06.md`, `COPY_TRADING_RESEARCH_2026-06-10.md`) and
all study outputs live in the **iamrossi repo** (`study-config.ts PATHS.OUT_DIR =
/home/tony/gitrepos/iamrossi/data/backups/perp-follow-study`). What's *here* is the
pre-registered config + runner scripts, and the numbers only as **prose inside
`wallet-selection-hl-copyability-v0.1.x.json`** — a config summarizing the study.

**Edit:** add a one-line provenance caveat wherever the figures appear. **Concrete
verification task (pre-flight, before any real-capital follow):** open
`/home/tony/gitrepos/iamrossi/data/backups/perp-follow-study/` (e.g. `partB-results.json`)
and confirm the −0.15%/trade, +1.93%, IC −0.50, +0.223 figures against the primary
outputs — we are otherwise sequencing real engineering on numbers quoted from a config
comment.

### A2. Don't launder the discretionary model as "study-recommended" — it is UNTESTED
Lines 32 claims the operator's discretionary model "IS the study's *recommended*
alternative … the study can't measure a discretionary model." Half right, and the
half that's wrong matters:
- The study found mechanical copy is **dominated by our own regime detector
  (+1.93 vs −0.15)** — i.e. the leader added **negative** value *over our own signal*.
  So the evidence does not "recommend" following leaders; if anything it points to
  regime-alone and vaults. The discretionary-follow thesis (operator judgment beats
  both) is a **hypothesis, not a study finding.**
- And our own `docs/scout/BACKTEST_FINDINGS.md` says the regime core itself is weak/lumpy
  (~+$68/mo, "encouraging, not proven"). So **neither** copy **nor** regime-alone is
  a proven winner — the plan is building on two unproven legs and a human-judgment
  hope.

**This is the single most important gap: there is no validation gate.** The plan
goes Phase 4 (surface plays) → Phase 5 (execute follows) with no checkpoint that the
discretionary model actually beats regime-alone/hold net of cost. Given persistence
is negative and mechanical copy loses, **rebuilding a human-in-the-loop version of
the disproven thing and assuming the human fixes it is the exact risk to guard
against.**

**Operator decision (2026-06-25): NO paper trading.** The operator vets on the LIVE
system with small real positions — paper mode has historically tangled the UI and
carries its own bug surface, and paper fills don't capture real slippage/fill/psych.
The validation gate therefore moves to **small-live**, not paper. The discipline is
unchanged; only the medium differs (the point was never paper-vs-live, it was
"don't scale an unproven, negatively-prior'd edge").

**Edit (new gate — NOT "before Phase 5").** Small-live vetting *requires* the follow
path to exist (you vet by doing capped live follows), so the sequence is: **Phase 5
ships hard-capped tiny FIRST → run this protocol → only then lift the cap (scale).**
This gate sits between initial tiny-capped follows and any scaling, not before
execution. Insert it as:

> ### Phase 4.5 — Small-live vetting protocol (operator's call: no paper)
> **Phase 5 follow-execution ships at a hard tiny cap.** This protocol gates LIFTING
> that cap (scaling) — Phase 4 plays-surfacing and initial capped follows proceed
> first. Vet on the LIVE system under a **pre-registered** protocol decided up front:
> - **Success bar** — operator fills these three numbers BEFORE the first trade and
>   does not move them after (a negative-prior edge fools you exactly at "a few good
>   trades"):
>   - `N` = minimum closed follows before any judgement (suggest ≥ a few dozen; pick
>     a number you'll hold to, not 5).
>   - `excess` = required cumulative net-of-cost return ABOVE buy-and-hold over the
>     same span (must be positive by a margin, not break-even).
>   - `concentration cap` = max fraction of net result allowed from any single trade
>     (so one lucky outlier can't clear the bar).
>   - Span must cross **≥1 regime change**.
> - **HONEST CAVEAT (don't oversell):** a small-sample, possibly one-regime live run
>   is statistically weak — clearing the bar is **necessary, not sufficient**. This is
>   risk-capped *probing*, not proof of edge; size up slowly and stay killable.
> - **Hard size cap** — see prerequisite #2 below: the operator sets explicit
>   max-notional/position + /account numbers, enforced at order entry, BEFORE the flip.
> - **Track record** — the live `hypotheses`/`pnl` plumbing already records this;
>   review against the bar before any size increase.
> - If it doesn't clear, the follow UI stays a *screen-out / awareness* tool, not an
>   entry engine.

**Going-live prerequisites — HARD GATES, operator-confirmed (2026-06-25).** Real
money on a negative-prior edge; these block the live flip, not "add later":
1. `TRADING_MODE=live` + agent key per `docs/LIVE_EXECUTION_RUNBOOK.md` (two-key
   model; **rehearse on testnet first**). The live fill path is built but gated off.
   **Default state is safe:** `TRADING_MODE` defaults to `'paper'`
   (`src/lib/env/mode.ts` `DEFAULT_TRADING_MODE`); live is an explicit opt-in and the
   instant rollback is setting it back to `'paper'`.
2. **Enforced max-notional / size cap — operator sets the NUMBERS before the flip**
   (this doc deliberately does not invent them). Specify max-notional per position
   AND per account, enforced at order-entry. Anchor them to the existing concrete
   controls: auto-exit `maxLossUsd` (`data/auto-exit/`, default $30) and the
   circuit-breaker thresholds (`CIRCUIT_BREAKER_MAX_DAILY_LOSS_PCT` 5% /
   `_MAX_DRAWDOWN_PCT` 15%). A cap without a number is not a gate.
3. **Circuit-breaker ON, tuned to the small account** (built: daily-loss + drawdown
   halt blocking new entries — the FIRST line of defense). Also enable **auto-exit
   Layer-1** (`docs/LIVE_AUTO_EXIT.md`) as a backstop — but read it honestly: it is a
   **~5-min cron + HTTP + IOC** that catches *gradual* drift toward liquidation; per
   its own §9 it **cannot beat a fast liquidation cascade**. It is a floor for
   slow-drift, NOT a liquidation preventer. The size cap + circuit-breaker (blocking
   entry) do the real protecting; auto-exit is last-resort cleanup.

**Mixed-mode tension — RESOLVED (2026-06-25):** scout **stays paper**, walled off in
its own Scout tab / sessions; the operator trades live elsewhere. The operator wants
it to run to its **pre-registered kill/graduation bar** (`docs/scout/README.md`,
scored weekly by `scout-review`) rather than killing it on a hunch — it's free +
paper-only, so keeping the experiment alive is near-zero cost. Judge it on the bar +
track record, not gut feel.
- **Verification — DONE (2026-06-25): segregation is clean in LIVE mode, structural +
  tested.** The wall is the `TRADING_MODE` switch:
  - `getActiveSession()` is mode-scoped (`session-service.ts:67` `.eq('mode', getTradingMode())`)
    — live cockpit never resolves the scout's `mode='paper'` session (comment: this fixed
    the "paper-shown-as-real confusion").
  - Performance route ignores client `sessionId` → `getAccountPerformanceSummary(getTradingMode())`
    folds fills from ONLY that mode's sessions (`performance-service.ts:257-263`). Scout
    paper fills excluded in live.
  - Equity headline = real HL account (clearinghouse + spot USDC via `HL_ACCOUNT_ADDRESS`),
    never a fold of Supabase position rows.
  - Scout has its own `title='scout'` scoped reads (`performance-service.ts:333`, `ScoutPanel`).
  - Operator entry stamps mode via `getTradingMode()` (`open-position.ts:30`,
    `run-session-service.ts:166`); scout hardcodes `mode:'paper',title:'scout'`.
  - **CAVEAT:** the wall separates paper-from-live, NOT scout-paper-from-operator-paper.
    While `TRADING_MODE=paper` (pre-flip), the main cockpit folds ALL paper sessions incl.
    the scout's — the past "tangling." **Going live is what cleanly walls them off.** No code
    change needed for segregation; just set `HL_ACCOUNT_ADDRESS` (+ `HL_ACCOUNT_EQUITY_USD`
    for the curve anchor) so live equity reads the real account.

### A3. Engine decision (Open Q1): prefer Python-on-worker — do NOT port to TS
The plan's Phase 2b ports `extract_metrics` Python→TS as "single source of truth,"
then its own Verification lists a permanent **"TS-engine vs Python parity"** test.
That parity test is the tell: a port doesn't give you one source of truth, it gives
you **two engines plus a parity tax forever**, because the weekly NAS re-rank keeps
running the Python.

The genuinely single-source option: **keep Python canonical; run on-demand vetting as
a queued job on the daemon/worker host** (where `python3` already exists and the
weekly re-rank already runs). Vercel never shells Python — it enqueues a request and
**reads the persisted `trader_evaluations` row.** Dual-consumer is preserved (UI and
`review-trader` skill both read the row); zero reimplementation; zero drift; no parity
test.

**Edit — ⚠️ this is a PLAN CHANGE, not just an open-question answer.** It reverses
Phase 2b's stated "port to TS" decision. Concretely: **DELETE** the TS-port mandate
from Phase 2b *and* the "TS-engine vs Python parity" line from the Verification
section; **REPLACE** with a Python-on-worker queued job (NAS host runs `extract_metrics`,
persists the `trader_evaluations` row; Vercel enqueues + reads). Drop "TS-port" from
PR-3's description (it's already titled "discovery backend (parallel)"). Reserve a TS
port only if/when
we *retire* the Python weekly re-rank entirely (then there's one engine again).

### A4. "Multi-window persistence screening" is infeasible for arbitrary on-demand wallets
Phase 2b/2 promise "require multi-window stability (not one snapshot)." But HL's fills
endpoint **retains only ~12k recent fills per account** (declared in `study-config.ts`
as the study's own power limitation). The weekly re-rank gets 6×60d windows only for a
**cached cohort** in iamrossi data; an **arbitrary address vetted on demand will often
have ≤1 clean window.** The plan can't deliver multi-window persistence at vetting
time for the general case.

**Edit:** scope it honestly. On-demand vetting emits a **single-window fingerprint with
a `persistenceConfidence` flag** — **freeze this exact enum in the `trader_evaluations`
row contract (Phase 2b, line 66): `'multi-window' | 'single-window' | 'insufficient'`**,
read identically by the UI and the `review-trader` skill (else the dual-consumer
principle breaks). **State the semantics as the row's headline:** a verdict certifies
**operational feasibility** (fillable, mirrorable hold, not a martingale/illiquid tail)
— it does **NOT** certify forward profitability. A single-window read can look copyable
by pure chance (hot streak / lucky regime). **The small-live protocol (Phase 4.5) is the
ONLY gate on profitability;** the verdict's job is to screen OUT the uncopyable, never to
green-light a follow.

### A5. Phase 4 chase-risk (Open Q2): default to NEW opens, not PROFITABLE opens
Surfacing favorites' **profitable** open positions structurally selects the
**most-extended** entries (you see it *after* it worked) — and per the persistence
finding, "currently profitable" has ~zero-to-negative forward predictive value. A
"% extended" badge (the plan's fix) is necessary but treats the symptom.

**Edit:** default the board to **NEW opens** (`kind='open'`, fresh — timely, least
extended); make **PROFITABLE opens a secondary, extension-gated view** (hidden beyond
an extension threshold by default). Frame "profitable" as *context*, never the headline
ranking signal. This kills the chase at the source rather than labeling it.

---

## B. Should-fix (accuracy / fidelity)

- **B1 (line 29).** The study's Part B selected leaders by **win-rate** and
  **consistency** (`PARTB` methods 1–2), not "past copyability." The copyability
  config was the *response* to the study, not its selection method. Reword to avoid
  implying the study tested copyability-selection.
- **B2 (Open Q3, Phase 5 proportional trim) — CLARIFICATION (UX only; the plan's
  `fraction` mechanic already stands, this is not a reversal).** KEEP Phase 5's
  `buildMarketReduceOnlyClose(fraction)` mechanic (line 91) —
  do NOT remove `fraction` support. Change only the PRESENTATION: instead of
  auto-firing `fraction = leaderReduceSz/leaderPrevSz`, **display it as a suggested,
  operator-editable default** (leader trimmed ~X% → pre-fill X%, operator confirms or
  edits). Auto-matching creeps back toward the mechanical mirror we rejected, and the
  operator's entry size/timing differs from the leader's anyway. Keeps it discretionary
  by design while preserving the fractional reduce-only calculation.
- **B3 (Open Q4, Phase 6 baseline).** Don't pick a numeric inclusion threshold. Gate
  on **eligibility** (INSUFFICIENT_HISTORY + min round-trips/distinct-days from
  `ACTIVE_FILTER`), surface everything that passes with a **confidence/freshness
  badge**, and let sort/filter narrow. Under-sampled names are *shown but marked*,
  never silently cut or silently trusted.

---

## C. Confirmed correct (verified this session — no change needed)
- **Cost math** (lines 26/44): 50 leaders × 1440 cycles = 72k/day; 8 favorites = 11.5k
  (~84% cut). ✓
- **Discovery source** (line 67): `01-discover-addresses.ts` is off-leaderboard L1
  block-sampling, ~38-min paced crawl. ✓ (matches `study-config.ts DISCOVERY`)
- **Median-hold instability** (line 47): 90/133/67/175h across samples is real — it's a
  median over a handful of round-trips on a bimodal trader. ✓ (reproduced on
  `0x795cfd…a242`)
- **Dual-consumer / RLS anon-no-write** (lines 40, 59): correct and well-pinned.
- **Phase 0 decay-to-neutral** for both scout consumers: correct fix; prevents the
  shrunk watch-set from silently lying to the rubric.

---

## D. Direct answers to the plan's open questions
1. **TS-port vs Python-on-daemon:** Python-on-worker (A3). The parity test in the
   plan's own verification list is the argument against the port.
2. **Chase risk:** down-rank/hide extended plays by default; default board to NEW
   opens (A5). The badge alone is insufficient.
3. **Follow proportionality:** operator-editable suggested trim, not computed
   exact-fraction match (B2).
4. **Widened "top" baseline:** eligibility gate + confidence badge, no hard numeric
   cut (B3).

---

## E. Summary for the planning agent
Adopt the plan **plus** the edits below. **One is a true plan reversal** (flag it as a
mid-course correction): **A3** (Phase 2b: Python-on-worker, NOT a TS port). **B2** is a
UX *clarification*, not a reversal (the `fraction` mechanic already stands).

- **A1** — mark the study numbers as unverified/iamrossi-sourced + a pre-flight
  verification task against the primary outputs.
- **A2** — insert the pre-registered **small-live vetting gate** (Phase 4.5: operator
  pre-commits `N`/`excess`/`concentration` + ≥1 regime; clearing it is *necessary, not
  sufficient*) before *scaling* follows; its going-live HARD GATES are operator-set
  numeric size caps, circuit-breaker ON (first defense), auto-exit as a slow-drift
  backstop only, kill-switch default `paper`.
- **A3** — Python-on-worker, no TS port (PLAN CHANGE).
- **A4** — single-window verdict + frozen `persistenceConfidence` enum; it certifies
  operational feasibility, NOT forward profit (Phase 4.5 is the only profit gate).
- **A5** — default Favorites' Plays to NEW (not profitable) opens.
- **B1** (study selection wording), **B2** (editable trim — PLAN CHANGE, UX only),
  **B3** (eligibility gate + confidence badge, no hard numeric cut).

**Rollout impact:** Phase 5 follow-execution (PR-6) **ships hard-capped tiny**; add a
**PR-7 small-live vetting gate** (Phase 4.5) that must clear before the cap is lifted
(scaling) — it can't precede PR-6, since you vet by doing capped live follows. Drop
"TS-port" from PR-3's description (→ Python-on-worker).

**Not endorsed-as-verified:** the Phase 5 safety stack reads sound but was not
line-by-line audited here — audit it before PR-6 (see the scope caveat up top).
