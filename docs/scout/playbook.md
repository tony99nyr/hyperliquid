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

## Lane: trend-follow (pre-registered 2026-07-28 — paper; verifies the trend-alert edge)

The paper twin of the trend-alert. When the REGIME section flags a coin as a
CONFIDENT TREND (regime bullish/bearish, conf ≥ 55%):
- ENTER WITH the trend (bullish → long, bearish → short), ONE position per coin,
  only if you hold none on it. Risk floor, `--stop-frac 0.04`,
  `--lane trend-follow --setup-type trend-follow`. Thesis = "confident 4h <regime>
  trend, riding it".
- EXIT (MECHANICAL — not a judgment call): CLOSE the FULL position the cycle the
  coin's 4h regime is NO LONGER a confident trend in your direction (→ neutral or
  flips), OR the 4% stop. No target, no trail. See PREREGISTRATION_trend-follow.md.
- Empty when the tape is ranging (the reversion lane's mirror) — that's correct.

## Lane: rubric-crossing (pre-registered 2026-07-28 — paper; RETIRES 'directional')

Mechanizes the desk-review breakdown-short / reclaim-long shapes. When the RUBRIC
section shows a side at GO:
- SHORT-GO → short, `--lane breakdown-short`; LONG-GO → long, `--lane reclaim-long`.
  `--setup-type rubric-crossing`, ONE position per coin×side, only if none open on
  it. Risk floor, `--stop-frac 0.025`. Thesis = "rubric <coin> <side> crossed GO
  (opp=X)".
- EXIT (MECHANICAL): CLOSE when that side drops OUT of GO (→ WATCH/NO-EDGE) OR the
  2.5% stop. See PREREGISTRATION_rubric-crossing.md.
- **`directional` is RETIRED** (0/6, unfalsifiable): take NO untagged directional
  bet. A rubric-driven entry is ONLY one of these two tagged crossings; otherwise
  STAND DOWN.

## Learned rules (curated by scout-review — append below)

### reversion-extreme (PRE-REGISTERED FORWARD TEST — Jul-20, not yet proven)
A day of honest backtesting found MOMENTUM/BREAKOUT has negative expectancy on
15m majors, but fading a STATISTICALLY EXTREME stretch in a RANGE regime edged
positive. This lane forward-tests it. When the REVERSION SCAN section lists a
candidate (|z| ≥ 2.5 stretch, efficiency ratio ≤ 0.35 = range), it is a valid
paper entry to FADE it: open the given side, risk small (floor), stop at the
listed level, thesis = "extreme <coin> stretch (z=X) in a range regime, fading
to the mean". TAG IT: lane 'reversion', setupType 'reversion-extreme', regime
'range'. Do NOT fade a stretch the scan did NOT list (a trend-regime stretch is
skipped by design — fading a trend loses). One reversion position per coin.
Empty scan in a trending tape = correct, take nothing. See
PREREGISTRATION_reversion-extreme.md for the kill/graduate bar.

**EXIT — pre-registered 2026-07-23 (NON-DISCRETIONARY rule; model-executed).** The
registered reversion exit is a FIXED TARGET take-profit at the scan's `target` (the
50%-retrace of the stretch), NOT a trail and NOT "hold for more". Pass `--target
<targetPx>` (the scan's exact `target`, no other level) on the open so it persists
(positions.target_px, migration 0042). When the snapshot's position shows
`atTarget: true` (mark reached/crossed the target) OR a `position-at-target` trigger
fires, you MUST close the FULL position that cycle — `scout:trade --exit`. This is
not a judgment call. NOTE the honest limit: nothing auto-fires the close — it is a
deterministic SIGNAL (the atTarget flag + act trigger) plus this hard rule, but the
close still executes through YOUR `scout:trade --exit` call, so compliance is on the
model. (A scout-side auto-close mirroring risk-exit is the future hardening if
compliance slips.) Rationale: taking the registered target is the strategy being
measured; holding a winner past target turns the forward test into "fade and hold
until something breaks", making planned-R vs realized-R meaningless. The stop stays
the pre-registered invalidation level — no break-even move, no trail (those are
SEPARATE strategies to pre-register + A/B only IF the lane graduates).
Why the rule exists: the first SOL reversion short (07-22) blew ~4× past its target
and sat open ~24h because no target-close rule existed — a +4R paper windfall, but
zero clean measurement of the registered exit. That hypothesis has been marked
`excluded=true` (transitional — the rule wasn't live at its target-hit), so its
fat-tail R never enters the sample in EITHER direction; every close after 07-23
follows this rule and counts.


<!-- scout-review appends/edits dated, evidence-backed rules here, e.g.:
- 2026-07-01: negative-funding shorts into a flush lost 4/5 (avg -$X). Require
  confirmed 8h+1d bearish regime before shorting against funding. -->

### 2026-07-28 review — reversion-extreme is FAILING (n=12, −0.55R); account KILL
Scorecard: account NET **−$32.58** over 19 trades / 35d (13% win) → deterministic **KILL**.
The one active edge, reversion-extreme: **−0.55R expectancy over 12 closed (2 wins), net
−$5.7** — below breakeven, far below the +0.15R graduation bar.
- **Failure mode (evidence):** fades of dislocations that **keep trending** drive the losses —
  BTC z=3.94 (−1.07R), SOL/BTC down-fades z=−3.16/−3.04/−2.58 that extended (−0.5..−0.6R each),
  BTC z=2.74 tagged regime=bullish/50% (−1.76R). The ER≤0.35 + 4h-regime range gate is admitting
  **fast directional legs**, not just range dislocations. The 2 wins were tiny (+0.38R, +0.03R)
  while losers ran full stops — the asymmetry of a negative edge.
- **Discipline (do NOT p-hack):** the pre-registered decision point is **n=15 (≈3 trades away)**
  or 21 days — NOT yet reached, so the frozen rule stays frozen: no loosening, no tightening, no
  new gate mid-test (that resets the clock). Let it reach n=15 → KILL (near-certain) or the rare
  reprieve. Any redesign (e.g. a fresh-move / short-TF-trend-alignment filter) is a **NEW
  pre-registration**, not an edit to this one.
- **Separation:** the operator-facing Discord-alert / ladder-draft lane is NOT this frozen
  paper ledger — its filtering (e.g. don't draft a fade against an aligned short-TF trend) may
  be tightened freely without touching the forward test.

### 2026-07-31 review — worse (NET −$105); trend-follow bleeding; the "both lanes lose" tell
Account NET **−$105.38** over 23 trades / 39d (10% win) → **KILL**, and the paper breaker is in a
**drawdown HALT** (−18% from peak). Down ~$73 in 3 days — the driver is the NEW **trend-follow**
lane: **−$69.30 over 4 trades, 0% win, −0.37R.** It entered 4 confident-4h trends and all
**reversed and stopped out** (~full 4% stop each) — trend-following whipsawed by a choppy tape.
- **THE TELL (the real finding):** the FADE lane (reversion, −0.55R) and the FOLLOW lane
  (trend-follow, −0.37R) are losing **simultaneously**. That's the paradox that resolves to one
  answer: at the scout's **15m-entry / 4h-regime timescale**, BTC/majors are **choppy noise** —
  neither clean persistence (trend) nor clean mean-reversion (fade) survives the ~9bps round-trip.
  Strong evidence there is **no mechanical edge at this timescale/instrument** for this account —
  which is exactly what the falsification engine exists to surface.
- **Discipline:** both reversion (n=12) and trend-follow (n=4) are BELOW their n=15 pre-registered
  kill points — let them run to n=15 (the paper bleed IS the honest cost of the test; don't kill
  early or p-hack). Near-certain KILL for both at n=15. `directional` (0/6, no frozen rule) should
  be **retired** now. Only the passive benchmarks (carry +$3, vault +$0.3) are non-negative.
- **Implication:** if both graduate to KILL, the honest next step is NOT another 15m mechanical
  lane — it's a different timescale (HTF/daily) or a structural/behavioral edge, pre-registered fresh.

### 2026-08-06 review — reversion KILL bar FIRED (clean); scout dormant 6 days; HTF pre-registered
Account NET **−$113.52** over 23 trades / **44.2 days** (10% win) → **KILL**; monthly run-rate
−$77/mo. Zero new trades since the 07-31 review (still 23 total / reversion 12 / trend-follow 4) —
the neutral chop of early August surfaced no candidates (and the operator-facing reversion
alert lane was muted 08-01, [[reversion-alert-muted]]). Verify the scout daemon is alive, not
just quiet ([[scout-repair-jul-2026]] — the consumer has died silently before).
- **reversion-extreme → KILL (pre-registered, NOT early).** The frozen bar is "net < 0 past **21
  days** with ≥3 closed." We are at **44 days, n=12, −0.55R, net −$14** → the TIME criterion has
  fired cleanly. This is the pre-registered decision point arriving, not a p-hack. **Retire the
  lane.** Any redesign (fresh-move filter, short-TF-alignment gate) is a NEW pre-registration.
- **directional → RETIRE.** 0/6, no frozen rule — flagged for retirement 07-31, do it now.
- **trend-follow → HOLD THE FROZEN BAR (do not KILL early).** n=4, ~9 days since it registered —
  BELOW both its criteria (n≥15 OR 21 days). It is the worst bleeder (−$72.59, 0/4, −0.37R) and
  near-certain to KILL at its ≈Aug-18 time bar, but killing at n=4 is exactly the loss-driven
  premature judgment the pre-reg guards against (trend-follow is DESIGNED low-win + lumpy). Let
  the frozen bar arrive; it is dormant meanwhile, so this costs nothing.
- **leader-follow / vault:HLP / carry → CONTINUE** as controls only (n=1 and two passive
  benchmarks; not edges under test).
- **THE PIVOT (the actual forward work):** the only test worth BUILDING now is the pre-registered
  **`htf-trend`** daily Donchian-breakout lane (c710516, [[PREREGISTRATION_htf-trend]]) — a
  different timescale + mechanism, the honest response to the confirmed "no mechanical edge at
  15m/4h" finding. It needs its signal-surfacing built into the scout cycle before it trades;
  that build — not another 15m lane — is where effort goes next.

### 2026-08-13 review — trend-follow churned 42 trades PAST its fired kill bar (process failure)
Account NET **−$174.98** over 68 trades / 52.3 days (8% win) → **KILL**; run-rate −$100/mo.
- **What happened:** when the daemon was revived (08-07), the cycle's REGIME section still
  carried an ACTIVE "enter trend-follow" directive — so the scout churned **42 more trend-follow
  trades in ~6 days** (mostly HYPE 4h flip-flops, −$38 incremental; lane totals n=46, 4% win,
  −$141.39, −0.10R), sailing far past the n=15 kill bar with no review in between. The bar had
  effectively FIRED at n=15; everything after was untracked bleed. **trend-follow is now KILLED**
  (this was already near-certain on 08-06; it is now decisive and overdue).
- **The process rules this adds (both applied in scripts/scout-cycle.ts, 08-13):**
  1. **A killed/held lane's entry directive must be REMOVED from the cycle the moment its status
     changes** — the model trades what the snapshot invites; playbook prose alone does not stop
     it. REGIME + REVERSION sections are now CONTEXT-ONLY (no entry language).
  2. **Kill bars need enforcement between reviews:** a lane at/past its pre-registered n with
     negative expectancy must stop being tradeable without waiting for the next human review.
     (Deterministic bar-check in the cycle = future hardening if this recurs.)
- **Open position:** one BTC short (lane trend-follow) opened 08-13 — the cycle now instructs
  closing any open killed-lane position; verify it's flat by next review.
- **htf-trend: 0 trades** — correct, not broken: no major has closed a daily bar through its
  20-day channel in this chop. The lane is live and waiting; its clock starts on the first breakout.
- **Active roster after this review:** htf-trend (the ONE live experiment) + rubric-crossing
  (n≈0, within bar) + passive controls (vault, carry). Killed: directional, reversion,
  trend-follow. Queued: [[PREREGISTRATION_compression-straddle]] (after htf-trend resolves).

### 2026-08-29 review — htf-trend's first real read: +9.7R unrealized; the steward scores NET-NEGATIVE
Account NET **−$180.53** / 83 trades / 67.4d → deterministic **KILL**, but the number is
legacy graveyard (killed lanes −$168 of it). The LIVE experiment set reads differently:
- **htf-trend — the first genuinely promising interim signal this desk has produced.** Four
  entries (Aug 19-20, the treasury-rally breakouts), ZERO closed, aggregate **+9.7R
  unrealized** (ETH +1.38R, HYPE +1.77R, BTC +2.60R, SOL +3.92R) after riding through the
  Warsh −3% dump without any stop/channel exit. This is the fat-right-tail shape the
  pre-reg predicted. DISCIPLINE: unrealized R is NOT the ledger — the lane's R exists only
  when the 10d-channel/stop exits (daemon-enforced) close it. No graduation talk at n=0.
- **leader-follow (post-registration)**: 11 closed, **net −$15.76**, whale-conviction
  −0.14R (n=6). Trending toward its bar (KILL at n=15 or 30d/Sep-14 with net<0). Let the
  frozen bar arrive; no early kill.
- **compression-straddle**: n=0 — the Aug-19 squeeze resolutions were consumed by htf
  entries (one-directive-per-cycle + the 2-major portfolio cap crowded it out). Not a
  failure; a sampling reality. Its 45d clock only kills on ≥6 closed — patience.
- **STEWARD COUNTERFACTUAL VERDICT (new, actionable): 2 helped / 10 hurt, net-if-followed
  −$27.49.** Every stop-tighten it proposed during winning trends scored hurt/no-effect —
  the twitchy-override pattern, now measured. RULE: steward proposals carry NEAR-ZERO
  authority until this ratio inverts; the desk's default answer to a stop-tighten proposal
  on a mechanically-managed position is NO (the 08-19/08-28 rejections were both correct).
- **Event note (live desk, for the record):** the Warsh straddle banked +$18.13 (+0.67R on
  $27 risk), the template's full rung choreography firing correctly — the event lane and
  the htf lane profited from OPPOSITE sides of the same week (breakout longs into it,
  event short through it). Diversification across mechanism, working as designed.

### 2026-09-03 review — leader-follow KILLED at its bar; htf-trend's first LEDGER R is real
- **leader-follow: KILLED, mechanically, at the frozen bar** — n=15 closed post-registration,
  net **−$18.54** (< 0), whale-conviction −0.12R (n=10). The registered hypothesis (rated-whale
  ≥$1M adds carry short-horizon information) is falsified at this sample: even with the 24h
  cooldown, real stops, and the martingale filter, following size did not pay. Enforcement:
  added to KILLED_LANES (executor-refused), removed from the allowlist + prompt. Third
  mechanism to die at 15m-to-3d horizons (persistence, reversion, now imitation) — the
  surviving edges remain DAILY-timescale (htf-trend) and EVENT-window (straddle).
- **htf-trend: first two LEDGER closes, both daemon-enforced 10d-channel exits (Sep 2):**
  ETH +$51.28, BTC +$20.24 → per-setup expectancy **+1.78R at n=2** (100% win — meaningless
  rate at this n, the R is what counts). The lane banked the rally mechanically on the
  pullback and still holds SOL + HYPE. n=2 of the ≥20 graduation bar — a long way to go,
  but the first positive-expectancy ledger entry any active lane has produced.
- Steward counterfactuals unchanged (2 helped / 10 hurt) — the near-zero-authority rule stands.

### 2026-10-03 review (day 103, adversarial retro)
- **htf-trend: HOLD, and stop the graduation talk.** n=8, +0.90R nominal, but four
  of eight entries were ONE correlated cluster (Aug 19-20, all four majors on the
  same breakout). Effective n ≈ 5, t ≈ 1.1. Under a 6-lane search, the chance that
  at least one lane shows +0.90R at n=8 by luck is ~37%. The lane earned its
  CONTINUE, nothing more. The "surviving set is green" framing is retired: the
  honest statement is "search cost -$189; one unproven candidate remains".
- **Graduation bar amended (stricter only, 2026-10-03):** at n>=20 the >=+0.25R must
  ALSO hold with the largest 5-day entry cluster removed, and the live-decay
  haircut is now a number: multiply paper expectancy by 0.7. Both changes tighten
  the bar; neither can rescue a failing lane.
- **compression-straddle: HOLD by the letter of its bar.** 0/4 is a 24% event at
  the design win rate. The lane auto-dies at its 6th close unless trades 5+6 net
  more than +$5.30. No early kill; check the four stops for same-episode re-entry
  violations at the next review.
- **Blind-day policy:** outages (~6 days) are missing-at-random; expectancy is
  unbiased but n shrinks and time-based bars overcount. TODO: replay daily candles
  for blind windows and log SHADOW trades (off-ledger) so sample loss is visible.

### 2026-10-04 shadow replay (the blind-day TODO, built)
- **Tool:** `pnpm scout:shadow-replay [--days 60] [--coins ETH,BTC,HYPE,SOL]
  [--lanes htf-trend,compression-straddle] [--json]`. READ-ONLY. It replays the two
  mechanical lanes' frozen rules over every completed bar (windows clamped to each
  lane's registration date), groups signals into entry EPISODES (consecutive
  breakout bars = one opportunity), and diffs them against the hypotheses ledger.
  A missed episode = the rule fired but nothing reached the ledger. The miss count
  is an UPPER bound on daemon-attributable loss: the live cycle only scans the
  top-6 rubric coins, so a ranked-out coin's episode counts as missed too.
- **First run (60d, 2026-10-04):** htf-trend 26 episodes, 9 matched, 17 missed
  (65%). compression-straddle 24 episodes, 5 matched, 19 missed (79%).
- **Consequence for the bars:** the ledger's n is a FLOOR on the lanes' signal
  population. The tool CANNOT attribute a miss (heartbeats keep no history): a
  missed episode may be an outage, the rubric ranking the coin out of the top-6,
  a concurrency cap, or an open position — attribute only after cross-checking a
  specific date. The n=20 graduation checkpoint must quote the shadow-replay miss
  count beside the ledger n, and a time-based kill bar (compression's "6th
  close") counts LEDGER closes only — it must not be read as "the lane only
  found 6 setups". Re-run the replay at every weekly review.
- Economics: live break-even needs ~+0.5R at 1% risk; a clean n=20 pass justifies
  only $5-10 risk per trade (quarter-Kelly on the haircut expectancy). The
  programme's value is option value on a proven edge, not its paper run-rate.

### 2026-10-13 review (day 113)
- Account NET **−$73.99** over 105 trades → the deterministic account verdict stays
  **KILL**, but ALL of the bleed sits in lanes already killed at their own bars
  (trend-follow −$135, leader-follow −$26, directional −$22, reversion −$7). The two
  active lanes are both net positive: **htf-trend +$81, compression +$35**. The 10-03
  framing stands: search cost ≈ −$189; what remains is option value on two candidates.
- **htf-trend: CONTINUE.** n=11 (7 confirmed / 4 invalidated), donchian-20-10
  **+0.70R, 64% win, net +7.7R**. Expectancy drifted down from +0.90R at n=8, as the
  10-03 cluster caution predicted. After the 0.7 live-decay haircut it is ~+0.49R —
  sitting exactly at the ~+0.5R live break-even. No graduation talk before n=20 plus
  the cluster-robust check.
- **compression-straddle: CONTINUE — it survived its 6th-close kill condition.** The
  Oct 7-8 squeeze gave the lane its first two confirms (BTC and ETH shorts, both
  entered 10-07, resolved 10-08). Record 2/7, net **+$34.51**. The coded bar returns
  CONTINUE; the next checkpoint is simply more closes.
- **Shadow replay re-run (60d to 10-13):** htf-trend 32 episodes, 11 matched (66%
  missed); compression 29, 7 matched (76% missed) — stable vs the 10-04 run. NEW:
  recent misses are now attributable via `scout_decisions` — the 10-12 htf-trend
  shorts (ETH/HYPE/SOL) were refused by the 48h CPI event blackout (logged
  stand-downs), and ETH/HYPE also had open lane positions. So the miss count mixes
  DISCIPLINE refusals with outages and rubric ranking; it remains an upper bound on
  attributable sample loss, never a defect count on its own.
- **Steward counterfactuals: 5 helped / 11 hurt, net if-followed −$17.74** — the
  near-zero-authority rule stands and hardened slightly.
- No frozen-rule changes. Cadence repair: reviews slipped to 10-day gaps twice; a
  weekly reminder now fires (Mondays) bundling scout-review + shadow-replay +
  ladder-expectancy + a discard vet of archived drafts.

### 2026-10-13 addendum — htf-trend miss attribution (all 21 misses cross-checked)
- Full attribution of the replay's 21 htf-trend misses against `hypotheses` open
  intervals, `scout_decisions`, event windows and decision-cadence gaps:
  **14 position-blocks** (the Donchian re-signals while the lane already holds that
  coin — by design, one position per lane+coin), **4 logged stand-downs** (one
  feed-degraded, one rubric NO-EDGE, one single-bet concurrency choice while the
  ETH breakout was live, one no-active-directive), **2 event blackouts**, and only
  **1 daemon gap** (2026-09-21, ~10.5h).
- **Consequence: the "66% missed" headline is NOT sample loss.** True
  infrastructure-attributable loss is ~1-3 episodes (~5-15%); the rest is the
  lane's own entry guards working. The n=20 checkpoint should quote THIS
  attribution, not the raw miss count, and no capture-widening work is justified
  by the replay. Consecutive-episode re-signals while holding are a PYRAMIDING
  question — a separate strategy that would need its own pre-registration, not a
  "recovered" sample.
- Live-account cost audit (113d, all 156 fills): **100% taker, $39.32 fees on
  $87.4k notional (4.5 bps/side)**; mean entry overshoot on price-triggered
  opens/adds ≈ **+16 bps adverse** (median ~+10, worst +143 — the documented
  fill-at-candle-close design, dollar risk unaffected). Maker entries would save
  ~3 bps/side (≈ $2-3/mo at current size) — not worth the build until size
  scales post-graduation; a max-overshoot fire guard is a candidate rung field,
  to be pre-registered, not slipped in.

### 2026-10-19 review (day 118)
- **Verdicts unchanged** (deterministic scorecard): account headline **KILL**
  (net −$56/105 trades, all bleed in already-killed lanes), **htf-trend CONTINUE**
  (donchian-20-10: 11 closed, +0.70R, 64% win; lane net $99.46 with the ETH and
  SOL shorts opened 2026-10-15 still open, daemon-managed on the 10d channel or
  the stop), **compression-straddle CONTINUE** (7 trades, +$34.51).
- **Shadow replay, all 30 htf-trend misses attributed** (same method as the
  2026-10-13 addendum): **20 position-blocks · 5 stand-downs · 4 event
  blackouts · 1 daemon gap (2026-09-21) · 0 unexplained.** The Oct-14 misses were
  the CPI blackout; the Oct-17 misses were position-blocks on the open ETH/SOL
  shorts. Infrastructure loss stays ~3% (1/30). Still no capture multiplier.
- **Observation, not a rule change:** the 2026-10-16 BTC and HYPE misses were the
  2-short portfolio cap — the scout ranked BTC its strongest signal (12.7 risk)
  and correctly refused a third same-direction short. Lifting the cap is a
  concurrency redesign = a NEW pre-registration; at n=11 nothing changes.
- **Desk ledger (live):** the CPI (Sep) BTC straddle short leg **won +0.09R
  (+$8.68 net)**; the long leg was a costless OCO pass. The SOL runaway short
  resolved **scratch +0.03R** on the operator's weekend flat. Ledger: 27 closed,
  +0.19R, every setup family still COLLECT (below the 10-close sample bar).
  That is the desk's 2nd live event-straddle win of 2 fired (Retail Sales
  +0.82R, CPI +0.09R) — evidence for the event lane, no pre-registered verdict
  moved.
- **Discard vet (3d window, 2026-10-16 sub-weekly rows not re-counted):** nothing
  missed — the weekend-cleared ETH runaway draft never triggered, 0 missed
  targets. The 2026-10-16 interim vet also replayed the Oct-13 HYPE prune as
  dodged-stop (−1R avoided).
- **Steward:** unchanged (5 helped / 11 hurt) — near-zero authority stands.
- No frozen-rule changes. `docs/DESK_PROFITABILITY.md` untouched: no lever
  verdict moved (htf-trend checkpoint still pends ~9 closes; 2 are open now).
# 2026-10-24 retro note: kill rule measure

The pre-registered wording says to kill a lane when net expectancy is below zero.
The current scorecard applies the kill bar to net realised dollars. Keep this
behaviour during the active sample. At the next retro, decide whether to align
the implementation with expectancy or amend the registered rule.
