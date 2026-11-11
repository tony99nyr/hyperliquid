# Pre-registration: `event-straddle` with an entry deadline and class sub-counts

Registered 2026-11-10. The CPI (Oct data) leg had resolved. The next event is the FOMC of 2026-12-09 19:00 UTC. This document succeeds [PREREGISTRATION_event-straddle.md](PREREGISTRATION_event-straddle.md) for every event from that FOMC. The earlier document stays frozen and is not edited.

## What changed, and why it is a new registration

1. **Entry deadline.** The open rung of each leg may enter only while `now < print + 120 minutes`. The ladder still expires at print + 24h, so a leg that fired in time keeps its management rungs.
2. **Class sub-counts.** FOMC and CPI episodes are counted separately inside the one lane bar.
3. **Draft size.** The cron drafts each leg at $12 risk (it used $4). Size does not change R, so this item needs no bar.

The first item changes which events fire. A changed entry rule is a redesign, so the earlier count cannot continue.

## The rule

- The template is unchanged except for the deadline: BTC, 1% gate each side of the pre-print reference, stop at the reference, hot from print − 15 min, expiry print + 24h, plain OCO, the same six rungs per leg.
- The deadline sits on the open rung as `triggerMeta.entryDeadlineMs`. The value is the print time plus `EVENT_STRADDLE_ENTRY_DEADLINE_MS` (`src/lib/ladder/event-straddle-prep-service.ts`).
- The deadline is restrictive only. It can prevent an entry. It cannot cause one, and it never gates a reduce, a close or a stop move.
- The gate closes AT the deadline. Triggers evaluate on completed 15-minute candles. For a print on a quarter-hour, the last candle that can open a leg closes at print + 105 min.
- The check uses the start time of the watcher tick, as the expiry check does. A tick that starts before the deadline can place its order a few seconds after it.
- A deadline that is present but not a valid time (null included) closes the gate. Only an absent key means no deadline.
- After the deadline an unfired pair stays `armed` until expiry, but it cannot enter. The watcher does not evaluate the open rung and the fire path refuses it (`past-entry-deadline`).
- Do not re-present the sibling leg after the deadline. Arm validation refuses a draft whose entry deadline has passed.
- Do not tune the 120 minutes during the test. A different value is a new pre-registration.

## Episode unit and count

- One scheduled event with a fired leg is one episode. Both OCO legs of one print count as one episode.
- An event where no leg fired is not an episode. Record it beside the count as a no-fire, with its class, so the fire rate stays visible.
- **The count starts at zero with the FOMC of 2026-12-09.**
- The earlier registration closes at two episodes with no verdict (under its 10-episode minimum): FOMC Oct 28 (−0.98R) and CPI Nov 10 (−0.69R). Both stay in the ledger and in the lane's all-time P&L. Both fired after print + 120 min, so the new rule would have refused them. Do not add them to the new count, and do not count them as avoided losses.

## Sub-counts

- Keep two sub-counts inside the count: **FOMC** and **CPI**. Each records fired episodes, no-fire events and mean nominal R.
- Report both sub-counts at every weekly retro (desk-retro step 4b) and at the verdict.
- The sub-counts are descriptive. They have no bar of their own, because one class cannot reach a useful sample inside the lane's 10 episodes.
- A class change (for example FOMC to awareness-only) needs a new pre-registration. Do not make it from a sub-count read.

## Pass, kill and size-up bars (unchanged)

- Collect at least **10 fresh episodes** before a pass decision.
- **Pass** for review only when mean nominal expectancy is at least **+0.15R** across those episodes.
- **Kill** when mean nominal expectancy is **≤ −0.05R** after 10 fresh episodes.
- Size up by one risk tier only after the pass bar and when mean realised gap-past-stop is below **0.10R**. Missing gap evidence blocks size-up.

Nominal R is net realised P&L divided by the open rung's planned `risk_usd`. Show slip-aware R beside it. This bar is a review bar. It is not permission to arm or trade.

## Evidence at registration (in-sample, context only)

Every fired live straddle leg, with the delay from the print to the fire:

| Event | Leg | Print to fire | Result | Under a 120 min deadline |
|---|---|---|---|---|
| PPI, 2026-07-15 (ETH) | long | print time not recorded on the ladder | −$4.23 (−1.06R) | not assessed |
| Retail Sales, 2026-07-16 (ETH) | short | 661 min | +$4.88 (+1.22R) | refused |
| FOMC, 2026-07-29 (hand-built v3, re-centred for the press conference) | short | about 150 min after the statement | −$26.87 (−1.00R) | refused |
| Jackson Hole, 2026-08-28 | short | 121 min | +$17.94 (+0.66R) | refused |
| CPI (Aug data), 2026-09-11 | long | 31 min | +$25.40 (+0.94R) | allowed |
| CPI (Sep data), 2026-10-14 | short | 91 min | +$8.68 (+0.72R) | allowed |
| FOMC, 2026-10-28 | long | 121 min | −$11.76 (−0.98R) | refused |
| CPI (Oct data), 2026-11-10 | short | 136 min | −$2.77 (−0.69R, from exchange fills; ledger row pending) | refused |

Read this table with care:

- The sample is eight legs. The deadline was chosen after seeing them. The table cannot validate the rule.
- A 120-minute deadline would have refused three losses and two wins. The refused legs sum to −0.79R (−$18.58). That margin is small.
- A 180-minute deadline would have refused only the Retail Sales win. It would not have refused the FOMC Oct 28 loss, which is the loss that motivated the amendment.
- Two fires sit one minute after the 120-minute mark (one win, one loss). The boundary decides them. Do not move the boundary to fit them.
- The reason for the rule is the mechanism, not the table. A fire long after the print reacts to a later catalyst. The FOMC Oct 28 leg fired on an earnings move two hours after the statement.
- The catalyst-class study (2026-10-26) measured the FOMC median move at 0.54% at T+2h, close to noise at a 1% gate. The fired FOMC record is 0 wins and 2 losses. The FOMC sub-count exists to keep that question visible.

## Related tests

- [PREREGISTRATION_straddle-exits.md](PREREGISTRATION_straddle-exits.md) continues unchanged. It pairs on legs that actually fired, so the deadline only reduces how many episodes arrive.
- [PREREGISTRATION_capital-rule.md](PREREGISTRATION_capital-rule.md) check 4 reads gap-past-stop from the ledger. Each open fire records its planned stop from the deploy of this change (2026-11-11 UTC). Older fires use a stop derived from the entry fill and the rung's `stop_frac`. The report marks derived values. The report takes each ladder's own fills from the owner attribution. When another ladder held the same coin while a ladder closed, the gap is ambiguous and the report counts it as missing evidence.
