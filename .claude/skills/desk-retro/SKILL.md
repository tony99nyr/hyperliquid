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

## Protocol (run all four, in this order)

### 1. Scout scorecard + playbook curation

Run the `scout-review` skill (it wraps `pnpm scout:review`). Follow THAT skill's
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

### 5. Close the loop

- Append the dated retro entry to `docs/scout/playbook.md` (step 1 usually carries
  it; fold in anything steps 2-4 changed). Commit + push so the daemons' hosts see it.
- Re-arm the next Monday reminder (session reminders do not persist — schedule the
  next one-shot BEFORE finishing the retro).
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
