# Trader Discovery & Evaluation — Discovery + Fixes Plan

> Handoff plan. Self-contained: an agent should be able to act on this without
> the originating chat. Pairs with the trader-panel refactor prompt and the
> data-processing cost audit. Status: PROPOSED (no code changes yet).

## 1. Thesis shift (why this exists)
The operator has lost confidence in **self-generated alpha** (the Opportunity/
rubric board, chart-read entries, autonomous scout entries — all felt like luck).
This is corroborated by our own backtests (`docs/scout/BACKTEST_FINDINGS.md`): the
regime/trend core has only a **weak, regime-conditional, single-regime edge**
(~+$68/mo on $1k, *"encouraging, not proven"*). **Pivot: back to evaluating and
selectively following traders.**

## 2. The non-negotiable prior result (do NOT re-learn this)
`PERP_FOLLOW_STUDY_V2` (encoded in
`scripts/analysis/wallet-rating/configs/wallet-selection-hl-copyability-v0.1.1.json`)
already established:
- **Exact-mirror copy of HL leaders = −0.15%/trade** (after 4.5bps taker +
  slippage + funding).
- It is **dominated by our own regime detector (+1.93%/trade)**.
- **Copyable-segment persistence is NEGATIVE (IC −0.50)** — a trader's copyable
  edge does *not* carry forward.
- **Only HL vaults** showed positive persistence (IC **+0.223**) — the lone
  non-inverting copy signal.
- Latency is a red herring (copy is negative at 0/5/15/30s).

**Implication:** faithful mirroring is the wrong model. Viable models are
(a) **vault allocation**, or (b) **leader as an entry *signal* + our own regime
overlay + our own stop**. Proportional position scaling fixes the *capital*
mismatch only — it does **not** fix the risk-shape or persistence problem.

## 3. Target trader profile (operator spec → measurable)
"Median hold intraday, clearly profitable, trades consistently, concentrates into
a few positions, manages risk." Mapped to metrics we *already compute* in
`scripts/analysis/wallet-rating/hl_copyability_metrics.py`, plus the discriminator
that actually matters:
- **hold**: median round-trip hold in a mirrorable band; low `subMinuteFrac`
- **concentration**: few coins; high `majorsShare`
- **risk**: low `reserveMultiple`, bounded `worstLossVsMedianWin`, 0 liquidations,
  no `DEEP_MARTINGALE` / `RIDE_OR_LIQUIDATE` / `DISQUALIFIED`
- **performance**: positive **net-of-copy-cost** return
- **load-bearing discriminator → `adds/round-trip`**: separates *cut-losers /
  let-winners-run* (copyable with a stop) from *average-into-drawdown* (uncopyable
  with a stop — you harvest their losers and miss their recoveries)
- **bonus**: runs an HL vault

## 4. Core principle — ONE evaluation, TWO consumers
Every trader evaluation must be **persisted once** and consumed by both:
1. **The operator, visually in the UI** — enough rendered detail (charts +
   fingerprint + verdict) to *decide* a trader is good enough to follow.
2. **Claude, as data** — the same evaluation readable by a skill so Claude can
   review/justify a follow and later manage the mirror.

This follows ADR-0002 (two-transport): Claude/services write evaluation rows
(service-role) → Supabase realtime → UI reads (anon, select-only); Claude reads
the same rows back for review. **No UI-only computed stat that Claude can't see,
and no CLI-only output the UI can't render.** The profiler/grader writes a durable
`trader_evaluations` row; the drawer renders it and a `review-trader` skill reads it.

## 5. Key findings from this session (evidence)
1. **Discovery is dataset-locked.** `analyze-traders` hard-throws on any address
   not already in `rated-wallets.json` (`scripts/analyze-traders.ts:51`). We cannot
   vet a new/arbitrary wallet on demand — the #1 gap for the pivot.
2. **We have a strong *offline* rating engine** (`scripts/analysis/wallet-rating/**`,
   copyability config v0.1.1) computing the right metrics — but it's a weekly NAS
   re-rank, **not wired to on-demand UI discovery or to Claude at decision time.**
3. **The "Median Hold" UI stat is misleading** (`TraderDetailDrawer.tsx:228`): a
   median over only a handful of net-flat round-trips → unstable across samples
   (committed dataset **90.3h**, live UI **133h**, fresh recompute **67h/175h** by
   window), hides bimodal behavior (hundreds of scaling fills around weeks-long
   cores), and is shown stripped of copyability context.
4. **The missing capability is buildable today.** `scripts/_research-trader.ts` (a
   read-only profiler written this session) computes the full copyability
   fingerprint — round-trips, hold distribution, adds/trip, worst-loss ratio,
   concentration, drawdown, live posture — for **any** address off HL's public API.
   It is the on-demand vetting primitive; it currently only prints to a CLI (must be
   persisted per §4).
5. **Worked example `0x795cfd…a242`:** rating composite 9.3, `winRate 0.846`, but
   `maxAddDepth 1102` vs median 163, flag `LIVE_DEEP_STACK`, multi-day holds, one
   10×-leveraged $9.8M HYPE core. **Profitable whale, uncopyable without a large
   reserve.** Demonstrates *clearly profitable ≠ safely copyable*, and that
   proportional scaling can't rescue the averaging-down risk shape.

## 6. Discovery plan
- **A. Reuse the copyability fingerprint as explicit filters** (v0.1.1 — do not
  reinvent the scorer).
- **B. Close the candidate funnel.** Add live discovery beyond the static set:
  leaderboard pull + block-sampling (`scripts/analysis/perp-follow-study/
  01-discover-addresses.ts` already does this) → feed candidates into the grader.
- **C. On-demand vetting, persisted.** Promote `_research-trader.ts` into a real
  `research-trader` skill + `/api` endpoint that grades **any** address (removes the
  dataset-lock) and **writes a `trader_evaluations` row** (fingerprint + copyability
  verdict + hold distribution + per-coin round-trip series). Backs both the UI and
  the Claude review skill.
- **D. Persistence-aware screening.** Because copyable-edge persistence is negative,
  require **multi-window stability** (not a one-snapshot grade) and **prefer
  vault-backed** names.
- **E. Decide the follow model BEFORE building follow** (open decision): faithful
  proportional copy vs. **signal + own-stop + regime overlay** (recommended — beat
  raw copy in our study) vs. **vault allocation**. Averaging-down leaders are flagged
  uncopyable-with-a-stop regardless.

## 7. Visual vetting surface (the UI the operator decides from)
The trader detail view must make "good enough to follow?" eyeball-able:
- **Copyability verdict headline** (follow / caution / avoid) + the *why* (the
  gating metrics), not just a composite number.
- **Hold distribution** (p10–p90 or a small histogram) with the round-trip `n` and
  **live open-position age** — replacing the single misleading median.
- **`adds/trip`, `reserveMultiple`, `worstLossVsMedianWin`, majorsShare, net-of-cost
  return, liquidations, vault?** as labeled chips with copyable/uncopyable coloring.
- **Equity / realized-PnL curve** over the available history.
- **Per-position drill-in** (operator's refactor ask): click a position →
  **entry-vs-market chart** (their entry marked, market at entry time, where it sits
  now) + position **health** read → a **Follow** action from this view.
- **Source/freshness badge** (live trade-watch vs on-demand HL; sample window) so the
  operator knows how stale/complete the read is.

## 8. Fixes plan (prioritized)
**P0 — honesty/correctness (small):**
- Fix the median-hold stat (`TraderDetailDrawer.tsx:228`): show round-trip `n`, add
  `adds/trip` + live open-position age, or a p10–p90 hold range; mark it
  sample-dependent.
- Remove the dataset-lock in `analyze-traders` (`scripts/analyze-traders.ts:51`):
  when an address isn't in the rated set, fetch + grade on the fly (keep the
  INSUFFICIENT_HISTORY gate).

**P1 — discovery capability (persisted, dual-consumer per §4):**
- Promote `_research-trader.ts` → `research-trader` skill + endpoint that **persists a
  `trader_evaluations` row** (new migration) the UI renders and a `review-trader`
  skill reads.
- Wire live candidate discovery (leaderboard + block sample) scored by the
  copyability config → a "candidates to review" list.

**P2 — trader-panel refactor (operator's separate prompt):**
- Paginated **"load more" traders**; click → detail + positions; **click a position →
  entry-vs-market chart + position health**; **favorite / follow** (the §7 surface).
- **Favorites are greenfield** (no DB/table today). Add a favorites table; **only
  favorited traders get a live action subscription** (cost containment).
- **Follow a position**: subscribe to that leader+coin in `leader_positions` /
  `leader_actions`; surface reduce/close/add so the operator can keep the mirror
  healthy.

**P3 — cost trims aligned with the pivot** (from the cost audit):
- If dropping self-generated opportunities: kill the `rubric-scan` full loop
  (~260–300 HL calls / 20 min) and consider removing the Opportunity Board from the
  UI; `scout-watch` goes inert (decide whether to keep the scout). **Keep**
  `trader-watch` (the follow backbone) and `watch` (open-position safety).

## 9. Guardrails to carry forward
- **No-auto-fire** preserved — follow = signal; human approves every entry/exit (or
  it's a vault allocation).
- Keep the **INSUFFICIENT_HISTORY / data-completeness** gate.
- **Don't trust a single-window grade** — screen for persistence, prefer vaults
  (IC −0.50 vs +0.223).
- **Proportional copy fixes capital only**; risk-shape + persistence remain —
  `adds/trip` + `worstLossVsMedianWin` are the gating discriminators.
- **One evaluation, two consumers** (§4): never a UI-only stat Claude can't read.

## 10. Open decisions for the operator
1. Follow model: signal+own-stop vs. vault allocation vs. faithful proportional copy?
2. Keep or retire the autonomous scout + the whole opportunity-generation stack?
3. Favorites scope: per-session or persistent/global?
