# Pre-registration — `compression-straddle` scout lane (volatility-squeeze breakout)

**Registered 2026-08-13, BEFORE any lane trade. QUEUED, not yet active** — this freezes the
rule now; it runs as the *next* scout test AFTER `htf-trend` gets its shot (one experiment at
a time, so each result is readable). It is the disciplined form of the operator's "set up a
straddle to catch the next move" idea: a straddle only has edge when something makes a large
move *likely* — a scheduled event (the existing event-straddle handles that) or **volatility
compression**. This lane tests the compression premise.

## Hypothesis

**Volatility mean-reverts.** When price coils into an unusually tight range (a squeeze), a
large expansion becomes statistically more likely — vol does not stay compressed. Entering
*with* the breakout that resolves a genuine squeeze has positive expectancy and **positive
skew** (a tight stop back inside the narrow range = small loss on a false break; the expansion
runs = big win). The novel element vs a naive straddle is the **compression precondition** — it
supplies the "reason" that separates monetizing a likely expansion from arming into chop and
getting whipsawed on both legs. NOT a proven edge: this exists to prove or KILL it on
post-registration paper data, never to assert it.

Distinct from [[PREREGISTRATION_htf-trend]] (daily Donchian, no compression filter): this tests
whether a **squeeze filter rescues a faster (4h) timescale** that is noise *unconditionally* —
the trend-follow lane died at 4h, so the claim under test is that 4h breakouts pay *conditional
on a squeeze* even though they don't in general.

## The exact rule (frozen)

- **Universe:** BTC, ETH, SOL, HYPE.
- **Signal — evaluated ONLY on COMPLETED 4h candles:**
  - **Squeeze precondition (the gate):** Bollinger Band Width `BBW = (upper − lower) / mid`
    (BB = 20-period SMA ± 2σ on 4h closes) is at/below the **20th percentile** of its own last
    **100** values. A genuine compression, not normal range.
  - **Breakout trigger:** in a squeeze (or within **3** bars of one ending), the 4h close prints
    **above the highest high of the prior 20 bars** (LONG) or **below the lowest low of the
    prior 20 bars** (SHORT). Enter WITH the break.
- **Entry:** ONE paper position in the break direction, only if none open on that coin. Risk-
  sized to the scout floor. (Scout single-position expression of the OCO straddle — see limits.)
- **Stop (hard invalidation):** back inside the range = the break failed. Stop at the **opposite
  edge of the pre-breakout squeeze range** (LONG → the squeeze low; SHORT → the squeeze high),
  capped at **4%**. The compressed range makes this naturally tight — that IS the positive-skew
  appeal (small risk per false break).
- **Exit (mechanical, NO fixed target):** the 4h close crossing **back through the BB middle
  band** (the 20-SMA basis) — the expansion is over once price re-enters the mean — OR the hard
  stop, whichever first. Let the expansion run; the tails are the edge (no bank, no breakeven-
  move — those are separate strategies to A/B only IF this graduates).
- **WHIPSAW GUARD (the operator's own FOMC concern, baked in):** **ONE entry per squeeze episode
  per coin.** If the first break fails and stops out, do NOT re-enter the opposite break — that
  is the both-legs double-loss. Wait for a *new* squeeze to form.
- **Tags:** `lane: 'compression-straddle'`, `setupType: 'squeeze-breakout'`, `regime: 'expansion'`.

## Pre-registered pass / fail bar

- **KILL** if net expectancy < 0 after **15** closed trades, OR net < 0 past **45 days** with
  ≥6 closed.
- **GRADUATE to consideration** only at **≥ 20** closed AND expectancy **≥ +0.25R** AND positive
  after the standard live-decay haircut. Graduation is a *conversation*; the paper/live seam holds.
- **SKEW CAVEAT (do not misjudge):** like every breakout, this is low win-rate by design — many
  false breaks stopped for small losses, occasional big expansion winners. **Judge on
  EXPECTANCY / R, NEVER win rate.** A string of small stops is the shape, not a failure.
- **WHIPSAW DIAGNOSTIC:** track the same-episode false-break rate. If a large fraction of entries
  stop out inside their own squeeze episode, the 20th-percentile filter is not selective enough —
  that is a signal to KILL and RE-PREREGISTER a tighter precondition, never to tweak this one mid-test.

## The honest limits

- **Scout single-position constraint (important):** the scout holds ONE paper position, not two
  OCO legs — so it tests this as a **single break-direction entry** (whichever way the squeeze
  resolves). The edge measured — *does riding a squeeze-resolution breakout pay after ~9bps?* — is
  **identical** to the two-legged straddle's. IF it graduates, the LIVE expression is the real OCO
  straddle via the ladder engine (both gates armed with momentumConfirm), which is a separate
  operator arming decision, never automatic.
- **We enter LATE, and that's fine here.** Entry is the completed-4h close-through — well after any
  fast trader moved. The edge is NOT front-running them; it is that a squeeze-resolution expansion
  tends to **persist for more than one 4h bar**, so a confirmed entry still catches the bulk of it.
- **Compliance-on-the-model exit** (same as the other lanes): the middle-band-cross exit is a
  deterministic SIGNAL, but the close executes via the model's `scout:trade --exit`. Nothing auto-fires.
- **Implementation is a separate build:** this freezes the RULE. Surfacing the BBW-percentile
  squeeze + breakout/exit levels in the scout cycle (mirroring the htf-trend scan) is the next
  step. NO trade counts until that is live AND htf-trend has had its run.

## Why this, and why it's a fair test

- **The compression precondition is the whole point** — it is what makes a straddle a bet on a
  *likely* move instead of whipsaw-bait in chop. Arming a straddle without it is the negative-EV
  breakout bet we already killed (trend-follow, −0.37R); the squeeze filter is the falsifiable
  claim that conditioning on compression changes the sign.
- **Positive skew, honestly built** — tight stop inside the narrow range, no fixed target, let the
  expansion run. That is the good half of the "reverse play" (bet levels break, not hold).
- **The whipsaw guard is pre-committed**, so a losing episode can't spiral into a two-sided bleed —
  the failure mode the operator correctly worried about is designed out, not hoped away.
