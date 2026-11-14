# Pre-registration: `htf-trend` live expression (auto-drafted low-size ladders)

Drafted 2026-11-14. **Status: DRAFTED, NOT in effect.** This registration takes effect, and its count starts at zero, on the date the operator enables `HTF_TREND_ALERT_ENABLED` in production. Record that date here when it happens: `Enabled on: ____-__-__ (UTC)`.

The paper lane is [PREREGISTRATION_htf-trend.md](PREREGISTRATION_htf-trend.md). It stays frozen and keeps its own count and its own graduation rule. Graduation is a conversation, never an auto-promotion. This document does not change either.

## What it is, and why

The paper lane `htf-trend` trades daily 20-day channel breakouts on BTC, ETH, SOL and HYPE. It caught the Nov 12-14 2026 selloff on paper while the live desk had no expression of it. The live expression is a drafter. For each new breakout it creates one low-size LIVE ladder in `draft` status. The operator arms it in the cockpit. The code never arms, fires or closes anything.

The drafter sits behind `HTF_TREND_ALERT_ENABLED`. The flag is OFF by default everywhere. Only the operator turns it on, in the Vercel dashboard, at the graduation conversation.

## The frozen rules of the live expression

- **Signal.** The signal is identical to the paper lane. The drafter calls the same function, `htfTrendRead`, on completed daily candles only. The drafter does not edit that function.
- **Stop.** The stop is the lane's frozen `stopFrac = min(2 x ATR20 / entry, 0.12)`.
- **Exit.** The exit is a daily close through the opposite 10-day channel, or the hard stop. There is no fixed target and no breakeven move.
- **Expression.** One `open` rung is gated on the 20-day channel level. A short uses `price_below don20Low`. A long uses `price_above don20High`. The watcher evaluates the gate on completed 15m closes. One `close` rung uses the indicator `htf-channel-exit-<side>`.
- **Size.** Risk is `min($10, $400 x stopFrac)`. Leverage is 2. Mode is `live`. The notional never exceeds $400.
- **Timing.** The daily bar closes at 00:00 UTC. The drafting window runs from 00:01 to 03:00 UTC. The entry deadline is 04:00 UTC (`triggerMeta.entryDeadlineMs`). After the deadline the open rung cannot enter. The ladder expires 90 days after the signal close. The operator has until 04:00 UTC to arm. The window from 00:00 to 04:00 UTC is 19:00 to 23:00 US Eastern on the prior evening in standard time (EST), and 20:00 to 00:00 in daylight time (EDT).
- **Instant-fire.** The price is normally already beyond the channel at draft time. The arm route therefore shows the INSTANT-FIRE confirmation. That is expected for this lane. The operator confirms it.

### Selection

- The cycle drafts at most one ladder per coin per signal day. An archived or disarmed draft still counts, so "not this one" holds for the whole day.
- The cycle drafts nothing for a coin that has any open position.
- The cycle drafts nothing for a coin that has any draft or armed ladder on it. The ladder can come from any drafter and can be in any entry state (skip reason `vehicle`).
- The same-direction cap is 2. It counts open positions on universe coins plus htf ladders that can still enter.
- The cycle drafts at most 2 ladders per run.
- The event blackout runs from 48 h before a calendar print to 4 h after it. It mirrors the scout.
- When the positions cannot be read fresh, the cycle drafts nothing and touches no ladder.
- An account response is usable only when it is not stale, has no error, and carries the positions list (`positionsListed === true`). A response without the list is unreadable. This applies to the first read and to the second confirming read. When a read is unusable, the cycle drafts nothing and disarms nothing.

### Housekeeping

Housekeeping runs on every full cron tick, whether the flag is on or off. The flag gates DRAFTING only. With the flag off, the cycle drafts nothing and reads no draft ladders. It therefore archives no stale draft: archive a leftover draft by hand. It still lists armed ladders and still disarms a spent htf-trend ladder. The rules and the Discord note stay the same. With the flag off the cycle reports `skipped: 'drafting-off'`. With the flag on and the drafting window closed, it reports `skipped: 'outside-window'`. A full tick runs twice per 10 minutes, at minutes x0 and x1. Drafting still runs only inside the drafting window.

The cycle archives its own drafts whose entry deadline has passed. A stale draft is archived soon after 04:00 UTC. The cycle recognises its own ladders by the exact full title. A ladder with an edited title leaves housekeeping.

The cycle disarms its own ARMED ladders with reason `htf-trend-spent`. The check waits 15 minutes past the entry deadline (`HTF_SPENT_GRACE_MS`). Two cases apply:

- **Never entered.** The entry rung is not `fired` and has no `ladder_fires` row of any status. The cycle disarms the ladder at about 04:20 UTC, the first full tick after the 15-minute wait.
- **Entered.** The entry rung is `fired`, or it has a `ladder_fires` row of any status. A `failed` row can be an unknown outcome with a late fill, so it counts as entered. The cycle disarms the ladder only when the account shows no position of its side on the coin and a second, independent account read confirms it. If the second read does not confirm, the cycle reports it and disarms nothing.

If the cycle cannot read the fire record, it disarms nothing. A disarm moves no money and leaves the exchange stop in place. Every housekeeping disarm sends a Discord note from `HL HTF Trend Desk`.

### Ownership residual

Hyperliquid holds one position per coin. The close rung closes the whole position of its side. If the operator or another ladder adds to the same side while the htf position is open, the channel exit closes all of it. After an htf stop-out the ladder stays armed for up to about 10 minutes, until housekeeping disarms it. A same-side position opened in that interval keeps the ladder armed and shares its exit. Do not open a manual same-side position on a coin with an armed htf-trend ladder unless you want the channel exit to manage it.

### Frozen-rule discipline

Any change to these rules is a NEW pre-registration and resets the count. This covers the timing, the size rule, the stop, the exit, the universe and the selection rules. Do not tune them during the test.

## Differences from the paper lane

The live expression is not the paper lane. The differences are:

1. **Arm latency.** The operator must arm. An unarmed signal is recorded, not traded.
2. **Fill price.** The live fill is a 15m close beyond the channel level. The paper lane fills at the daily close.
3. **Entry window.** The live entry gate closes 4 h after the signal close. The live rule is a 15m close inside a 4 h window. The study used a delayed entry with a 24 h fill allowance. The study fill rate is therefore a guide, not a forecast. The closest match to a 4 h window is the 1h panel at 1 to 3 h delay (fill rate 94% to 97%). The unfilled trades are a selected set, not a random one.
4. **Real costs.** Fees and funding are real.
5. **Funding refusal.** The arm-time funding fold-in refuses a ladder when the estimated funding over 90 days breaks the loss cap. The cap allows about 30% APR against the side.
6. **Size cap.** Notional is capped at $400.
7. **Flat coin.** Drafting needs a flat coin. The paper lane has no such rule across systems.
8. **BTC straddle conflict.** When an htf-trend BTC position is open at an FOMC or CPI print, the operator does not arm the BTC event straddle. The operator records a no-fire with that reason.
9. **Housekeeping disarm.** The drafter disarms a spent ladder: a never-entered ladder about 20 minutes after the deadline, an entered ladder once the account is flat on two reads. The paper lane has no equivalent. Ownership residual: see Housekeeping.

## Evidence at registration (in-sample, context only)

Source: `scripts/analysis/htf-entry-delay-study.ts`, run 2026-11-14. Fees are 4.5 bps per side. A delayed entry must fill before the signal close + 24 h. The study replays the paper rule with a delayed entry. It is not a live result.

**4h-bar panel, Aug 2024 to Nov 2026.** The baseline enters at the daily close: n = 145 (4 open trades are excluded), mean +0.108R, stop share 33%. Hold days: median 11, p75 19, p90 29, p95 37.6, maximum 63. The table shows the paired difference against the baseline. The paired difference covers FILLED signals only. For the 4 h row, a no-fill counted as 0R gives +0.080R per signal against the +0.1075R baseline. The cost is about 0.027R per signal.

| Entry delay | Paired difference | Fill rate |
|---|---|---|
| 4 h | -0.069R (95% interval -0.158 to -0.001) | 92% |
| 8 h | -0.118R | 90% |
| 12 h | -0.205R | 85% |
| 16 h | -0.201R | 77% |
| 20 h | -0.287R | 72% |

**1h-bar panel, Apr 21 to Nov 14 2026.** The baseline is n = 33, mean +0.414R.

| Entry delay | Paired difference |
|---|---|
| 1 h | -0.130R |
| 2 h | -0.122R |
| 3 h | -0.124R |
| 6 h | -0.127R |
| 12 h | -0.203R |

The fill rate on this panel falls from 97% to 88% as the delay grows.

How to read it:

- The delay cost rises with the delay. On the 4h panel, the replay expectancy at 12 h or later is about zero.
- The bootstrap interval treats same-day signals as independent. The four coins often signal on the same day, so the true interval is wider.
- The study fills the stop exactly at the stop price (no gap slippage). The study charges no funding.
- A 4 h deadline keeps most of the edge.
- The long-sample baseline (+0.108R) is far below the forward paper mean (+0.409R at n = 18). The live expression therefore has a thin margin.
- Two decisions follow from the study. The entry deadline is 4 h. The expiry is 90 days, which is above the 63-day maximum hold.
- The study chose the deadline after seeing the data. It cannot validate the rule.

Paper forward ledger at the time of writing: 18 closed trades, mean +0.409R.

## Unit of count

The unit is one FIRED entry: the operator armed the ladder and the open rung filled. The entry closes by the stop or by the channel exit. The result is net of fees and funding. It is measured in R against the planned $ risk of the open rung.

The ledger family names are `htf-trend-long` and `htf-trend-short`. The `ladder-expectancy` skill reads them from the ladder title.

Also log these, beside the count:

- Every draft, as armed or not armed.
- Every armed draft, as filled or not filled.

The arm rate and the fill rate are reported at every weekly retro. They are not bars.

## Bars (confirmed by the operator 2026-11-14)

The operator confirmed these bars on 2026-11-14. They take effect on the enable date, with the count.

- **KILL.** Set `HTF_TREND_ALERT_ENABLED` off when the mean net R is below 0 after 12 closed fired entries. The action stops new drafts. Housekeeping of already armed ladders keeps running.
- **REVIEW at 20 closed fired entries.** The operator considers a size increase only if the mean net R is at or above +0.25R.
- **Size.** Size stays at the $10 risk rule until that review.

Judge on expectancy in R, never on win rate. The paper lane has the same caveat: a low win rate with large winners is the shape of the lane.

## Not built: the pre-close variant (milestone 2, operator decision 2026-11-14)

A pre-close variant would draft before the daily close when the price is already beyond the channel. Its entry window would run from 00:00 to 00:14 UTC. The entry delay would be zero.

The variant is not built. It needs its own pre-registration. Its costs are:

- More arm taps on days that do not close as a breakout.
- The ATR is not final at draft time.
- A two-phase rule: a draft phase before the close and a confirm phase after it.

## Related

- [PREREGISTRATION_event-straddle-entry-deadline.md](PREREGISTRATION_event-straddle-entry-deadline.md): the straddle conflict rule above applies to its FOMC and CPI episodes.
- Operator steps: the "htf-trend drafts" section of [LADDER_OPERATOR_RUNBOOK.md](../LADDER_OPERATOR_RUNBOOK.md).
- Code: `src/lib/ladder/htf-trend-alert-*.ts` and `src/lib/ladder/ladder-htf-exit-*.ts`.
