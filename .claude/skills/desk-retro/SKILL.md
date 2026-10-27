---
name: desk-retro
description: The weekly desk retro bundle — scout scorecard + playbook curation, shadow-replay sample loss, ladder expectancy, and the discard vet. Advisory and read-only except the playbook edit; never trades, arms, or disarms.
---

# desk-retro (weekly, advisory)

Single purpose: ONE repeatable weekly look-back that tunes the desk from evidence.
It answers four questions, each with its own deterministic gather, and ends with a
dated playbook entry. **Weekly, not daily** — at ~1-2 resolved events per week a
daily retro chases noise and invites p-hacking against the pre-registered bars.
The weekly cadence IS the multiplicity guard: do not run the bundle sub-weekly.
Run it on Mondays. This skill is the canonical weekly retro procedure; other docs point here.

## Protocol (run steps 0-5 in this order, with 4b after 4, then close the loop in step 6)

### 0. Performance report, markers and forecast

Run this first, before the other retro steps:

```
pnpm perf:report --since last-retro --md
```

Quote the report verbatim in the retro. Do not recalculate or paraphrase its
figures. Then list the proposed change markers for the operator to review.
Only an operator-confirmed marker can split lane statistics; do not treat a
proposal as confirmed or confirm it on the operator's behalf.

On the first retro of each month, freeze that month's forecast:

```
pnpm perf:forecast --freeze --write
```

Report the saved forecast snapshot with its inputs hash and P5-P95. Do not run
the freeze command on later retros in the same month.

On that same first retro, score the previous month (`pnpm perf:forecast --score --write`)
and update the capital-rule count in
[PREREGISTRATION_capital-rule.md](../../../docs/scout/PREREGISTRATION_capital-rule.md):
qualifying, neutral or reset, with the reason.

Then read the benchmark cards on the cockpit Scout tab (`lane_scorecards`, kind
`benchmark`, written by `pnpm scout:lanes` on the NAS tick). The funding-carry card is
a yardstick, not a lane: quote its net beside the lanes, and treat a card older than
one hour as a stale NAS feed (flag the operator, do not run it locally).

### 1. Scout scorecard + playbook curation

Run the `scout-review` skill (it wraps `pnpm scout:review -- --write`). Follow THAT skill's
judgment rules — multiplicity, regime coverage, survivorship, janitorial rows. The
scorecard verdicts are deterministic: interpret them, never re-derive or soften
them. Output: a dated entry appended to `docs/scout/playbook.md` (curate, don't
pile up — recency bias is the failure mode).

### 2. Shadow replay — scout sample loss

```
pnpm scout:shadow-replay            # 60d, both mechanical lanes
```

Quote the per-lane miss counts BESIDE the ledger n (the ledger is a floor, not the
population). A miss is an UPPER bound, not a defect count: before attributing one,
cross-check the date against `scout_decisions` (event-blackout stand-downs and
open-position blocks are discipline working, not outages).

### 3. Ladder / manual expectancy

Run the `ladder-expectancy` skill — the outcome ledger for every fired ladder
against each setup family's pre-registered bar (e.g. the catalyst-drafter kill bar:
mean ≥ +0.2R by fire 20). Defer to its verdicts: KILL / HOLD / SIZE-UP / COLLECT.

### 4. Discard vet — the missed-opportunity check

```
pnpm skill:desk-retro               # discards in the last 7 days
pnpm skill:desk-retro --days 14     # after a skipped week
```

It replays every ladder archived or disarmed in the window: would the core entry
rung have triggered, and then stopped out or paid? Read it in BOTH directions:

- **dodged-stop** = that one path would have lost −1R — consistent with the
  discipline working; say so without over-claiming it.
- **missed-target** = that one path would have paid. NOT automatically tuition:
  one replay is one path, and a sound discard stays sound even when its path
  would have paid (outcome bias is the trap). Cross-check the discard reason
  first; only a miss discarded from impatience or drift is a candidate lesson,
  and a PATTERN needs several independent instances, not one week's row.

**The vet is DESCRIPTIVE ONLY — it has no pre-registered bar and can never
change a rule on its own.** Its honest limits, all of which apply every run:

- One simplified path per discard: the CORE entry rung only, first profit-side
  reduce rung as a proxy target, no adds, no stop-moves, no breakeven ratchet.
- Gross of fees, funding and slippage; 4h bars; fill at the bar close;
  stop-first on a spanning bar. Evidence, never P&L.
- No base rate: only discards are vetted — the armed-and-fired ladders get no
  counterfactual here (that is the expectancy ledger), so a "missed" count has
  nothing to be compared against.
- A never-armed draft replays from creation and ASSUMES it was armable as
  drafted; the instant-fire arm guard may have refused it at those prices.
- A plan with no usable target can never show a miss — the summary flags those,
  and their dodges are weaker evidence.
- Overlapping windows (e.g. `--days 14` after a skipped week) can re-vet a
  discard already reviewed — never count the same discard twice.

### 4b. Open pre-registrations: is each count still moving?

A pre-registered test only reaches its decision if its evidence keeps arriving. List
each open `docs/scout/PREREGISTRATION_*.md` (verdict not yet final) in one table: the
test, its count toward the bar, the change since the last retro, and the next decision
date. Flag any count that did not move when it should have. Examples:

- event-straddle: new event episodes toward the 10-episode review.
- Entry overshoot (catalyst-classes): intrabar gate touches against completed-close
  outcomes, one row per new event leg.
- cross-venue funding-veto: rows in the capture archive
  (`data/backups/hyperliquid-study/cross-venue-funding/hl-observations.json` on the
  NAS, written at 07:55, 15:55 and 23:55 UTC by `nas-watch.sh`).
- capital-rule: the monthly count (first retro of the month only).

A count that stalls is an outage, not a result. Find the cause before the next retro.
Do not change a bar here: a redesign is a new pre-registration.

### 5. Calendar curation

`src/lib/skills/economic-events.ts` is the source of truth for the scout event
blackout, the drafter expiry clamp, the desk-review EVENTS lead and the prod prep
ping. Curate it every retro:

- Verify every future entry's date and time against the official source (BLS, the
  Fed, the central bank, company IR) — never from memory. Fix any date that moved.
  Resolve any entry marked "date unconfirmed" once the official date exists.
- Top up the horizon: the next CPI and FOMC prints must be in, and the calendar must
  never go structurally exhausted before the NEXT retro (`calendarExhausted` turns the
  event blackout fail-open). NFP, PCE and PPI go in as awareness-only entries.
- Remove entries that printed before the previous retro. This is safe: the straddle
  shadow replay matches legs by the print timestamp in each ladder's thesis, not by
  this list.
- Conventions: only FOMC and CPI are straddle classes. They get `straddleCoin: 'BTC'`
  + `prepLeadMinutes: 30`. The 2026-10-26 catalyst-class study rejected NFP, PCE and
  PPI, and the HIP-3 earnings study failed
  ([PREREGISTRATION_catalyst-classes.md](../../../docs/scout/PREREGISTRATION_catalyst-classes.md),
  [PREREGISTRATION_hip3-earnings-straddle.md](../../../docs/scout/PREREGISTRATION_hip3-earnings-straddle.md)).
  Everything else that can gate risk (NFP/PCE/PPI, BoJ-class decisions, bellwether
  earnings) is awareness-only with `prepLeadMinutes: 0` and no `straddleCoin` (it
  feeds the desk read, the blackout and the clamp, and never pings). Add a new
  straddle class only through a new pre-registration that passes.
- Add sparingly: each entry costs scout dark time ([print−48h, print+4h]) and a
  drafter dead zone (expiry clamp at print−72h). An event earns its entry by being
  a genuine binary vol risk, not by existing.
- The calendar is a TS const compiled into the prod cron bundle — a change reaches
  production only with the commit + push (step 6 carries it). A calendar code
  change means the commit needs `pnpm validate`, unlike a markdown-only retro.

### 6. Close the loop

- Append the dated retro entry to `docs/scout/playbook.md` (step 1 usually carries
  it; fold in anything steps 2-5 changed). Commit + push so the daemons' hosts see it.
- If a number moved a LEVER'S VERDICT (graduation, a kill, a cost or capture
  finding), update `docs/DESK_PROFITABILITY.md` with a dated entry — that file is
  the durable answer to "how do we get more profitable" and must never silently
  drift from the ledger.
- The durable reminder is the systemd user timer `desk-retro-reminder.timer` on the
  operator's PC (`ops/systemd/`, Mondays 12:57 local, a Discord ping). Check that it is
  active: `systemctl --user list-timers desk-retro-reminder.timer`. A session reminder
  (CronCreate) is optional on top: it is lost when the session or the machine restarts.
- Report to the operator in a few lines: verdicts, playbook changes, discard-vet
  summary, and anything that changes next week's desk behaviour.

## Discipline

- **Never trade, arm, or disarm here.** The retro only reads and edits markdown.
  (desk-review owns the disarm authority; the ACTION skills own entries/exits.)
- **Frozen rules stay frozen.** A mid-test tweak resets a lane's clock; any
  redesign is a NEW pre-registration, never an edit prompted by one week's look.
- **Don't second-guess deterministic scorecards.** Interpret; never re-litigate
  the math or rationalize a KILL.
- **Attribute before you conclude.** Every "miss" (shadow replay or discard vet)
  gets a cause check against the decision ledgers before it becomes a lesson.

## When NOT to use

- A mid-week "how are we doing" → `desk-review` (the wide-angle situational read).
- One ladder's grade → `review-ladder`. One lane's deep dive → `scout-review` alone.
