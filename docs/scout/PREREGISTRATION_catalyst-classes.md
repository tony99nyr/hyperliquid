# Pre-registration: `catalyst-classes`

Registered 2026-10-26, before any outcome statistic is computed. This study alters no live behaviour. It does not arm, trade or change the event calendar. The orchestrator and the operator decide any calendar or build change.

Two independent measurements. Each has its own bar. Do not move a bar after the data is read.

## Part A: which catalyst classes move enough for the straddle to pay

### Question

Which scheduled catalyst classes move BTC (and ETH, as a secondary coin) by enough, and with enough follow-through, for the event straddle to pay?

### Classes and event times

FOMC decision, CPI, NFP, PPI, PCE, ECB rate decision, Deribit monthly expiry (last Friday of the month, 08:00 UTC), and the HYPE team unlock (the measured coin for this class is HYPE, not BTC or ETH).

Event times come from official schedules only (BLS, BEA, the Fed, the ECB, Deribit rules, the Hyperliquid unlock schedule). They cover 2024-01 to 2026-10 and all sit in the tracked file `data/events/catalyst-class-dates.json`, with one source per class. The file holds public data only. A date that cannot be confirmed from an official source is left out and counted in a "dropped" note. Known gaps, fixed before running: the HYPE unlock has no official schedule page, so its dates (the 6th of each month from 2026-01-06) come from press reports and its 00:00 UTC time is an assumption; it has at most 10 events and so cannot pass n of 15 whatever the time. ECB 2026-09-10 is dropped (no official page text). No date is added or removed after outcomes are seen.

An event after the data end (not yet printed, or its T+24h candle not yet closed) is excluded for that horizon.

### Reference price and move

The template (`scripts/event-straddle-prep.ts`) takes the live mid at build time, and the prep alert fires 30 minutes before the print (`prepLeadMinutes` default 30). The nearest candle form of that rule is the one the brief names: the 15m close at T-30 minutes. This study uses it.

Candle intervals are generalised by one grid rule so coarser data stays comparable:

- Reference time = the largest grid boundary at or before T-30 min. The reference price is the close of the candle that ends there.
- Outcome time for horizon h = the smallest grid boundary at or after T+h. The outcome price is the close of the candle that ends there.
- On the 15m grid every event time is on the grid, so the reference is exactly T-30 and each horizon is exactly T+h.
- The actual elapsed minutes are recorded per event.

Move = outcome / reference - 1. Absolute move = its absolute value. Horizons: T+15m, T+2h, T+24h.

### Data and its limit (disclosed before running)

The Hyperliquid `candleSnapshot` endpoint returns only the most recent 5000 candles per interval. A probe on 2026-10-26 (a data-availability call, no outcome read) returned nothing for 15m and 1h at 2024 and 2025 start times. So the 15m grid reaches back about 52 days and the 1h grid about 208 days. The 4h grid reaches back to roughly mid-2024.

Only the HL info endpoint is permitted. No other venue is used. The study therefore reports three tiers:

- **Tier 15m** (the brief's exact rule): events inside the 15m window.
- **Tier 1h** (coarse): events inside the 1h window. The reference lags T-30 by up to 59 min and each outcome overshoots T+h by up to 59 min. Verdict-eligible because that error is under 1 hour.
- **Tier 4h** (descriptive only): grid error up to 4 hours. Never used for a verdict.

### Metrics

Per class, per coin, per tier: n, median and 80th percentile (linear interpolation) of the absolute move at T+15m, T+2h and T+24h (T+15m on the 15m tier only), and the 24h continuation rate.

24h continuation = the share of events where the T+24h move has the same sign as the T+2h move AND its absolute size is at least the absolute T+2h move. An event with a zero T+2h move counts as not continued.

### Control

For each class and tier, a control uses random non-event times with the same UTC hour and minute and the same weekday as each event. For each event, draw 20 control times from the same weekday and the same time of day, from the data window of that tier, excluding any day within 24 hours of any event in any class. Use a seeded generator (seed 20261026). Compute the same metrics on the pooled control set. The control shows whether events beat ordinary noise. It has no bar.

### Bar and verdict (BTC; HYPE for the unlock class)

A class joins the calendar only if BOTH hold:

1. median absolute move at T+2h is above 1.0%, and
2. the 24h continuation rate is above 50%.

Verdict per class, using the finest verdict-eligible tier (15m, then 1h) that has n at or above 15 for the class:

- **JOIN**: both conditions hold.
- **REJECT**: n at or above 15 and at least one condition fails.
- **INSUFFICIENT**: no verdict-eligible tier has n at or above 15. The numbers still print.

ETH is reported with the same metrics and has no verdict.

### Kill rule

If the study cannot reach n at or above 15 for a class on a verdict-eligible tier, the class stays INSUFFICIENT. Do not loosen the bar, merge classes or switch coin to raise n. Merging classes would need a new pre-registration.

### Amendment 1 (2026-10-26): Binance 15m history for BTC and ETH

Written before any Binance data was fetched. The first run left every class INSUFFICIENT because HL candle history is capped at 5000 bars. The study measures the market move after a print, which is venue-agnostic for BTC and ETH. So, for BTC and ETH only:

- Historical event moves also use Binance Vision public 15m klines (`data.binance.vision`, USD-M perpetual `BTCUSDT` and `ETHUSDT`). Monthly zip archives cover 2024-01 to the last complete month. Daily zip archives cover the current month up to the last published day. Files are cached under `data/backups/hyperliquid-study/` and fetched with `politeFetch`.
- New tier `bin15m`: the exact 15m rule above (reference = close at T-30, outcomes at T+15m, T+2h, T+24h on the 15m grid), range 2024-01 to 2026-10. It is verdict-eligible and the finest tier, so it is the first one tried.
- The bar is unchanged: BTC T+2h median absolute move above 1.0% AND 24h continuation above 50%, with n at or above 15. The seeded control (seed 20261026, 20 controls per event, same weekday and time of day, 24 h exclusion around any event) is unchanged and uses the same tier window.
- HYPE is not on Binance for the whole window. The HYPE unlock class stays on the HL tiers and is reported as before.
- The HL tiers (15m, 1h, 4h) stay in the output for BTC and ETH as a cross-check. They no longer decide the BTC verdict when `bin15m` has n at or above 15.
- Kill rule unchanged: a class with n below 15 on `bin15m` stays INSUFFICIENT. Do not merge classes or change the bar.

## Part B: entry overshoot in R

### Question

How much expectancy does the fill lag cost the event lane? Ladder triggers evaluate on completed 15m candles, so a fill can land well past the trigger.

### Data (Supabase, SELECT only)

- `ladder_fires` with status `filled`, joined to `ladder_rungs` (trigger price, stop) and `ladders` (mode, title, OCO group).
- Schema (migrations 0023, 0025, 0034): `ladder_rungs.trigger_px`, `stop_px`, `stop_frac`, `side`, `action`; `ladder_fires.detail` holds JSON with `entryOid` (set by `ladder-fire-service.ts`).
- The fill price: the `fills` row whose `hl_order_id` equals `entryOid`. Amendment, 2026-10-26, made after a count-only check found `ladder_fires.detail` null on every filled open fire and before any overshoot value was read: when `entryOid` is absent, use the same time-window rule as `ladder-outcome-business-logic.ts` (`ENTRY_MATCH_WINDOW_MS` 10 s, 1 s early jitter): the live, non-reduce-only `fills` row with the same coin and side (buy for long, sell for short) with `filled_at` in [fired_at - 1 s, fired_at + 10 s]. If that window holds zero or more than one distinct order, exclude the fire and count it as unmatched.
- Scope: live ladders, rung action `open`, fire status `filled`.

### Metrics

For each filled open rung:

- Adverse distance = fill price minus trigger for a long, trigger minus fill price for a short. A negative value is price improvement and stays in the mean.
- Overshoot in bps = adverse distance / trigger x 10,000.
- Planned stop distance = |trigger - stop_px|; if `stop_px` is null, trigger x `stop_frac`. A rung with neither is excluded and counted.
- Overshoot in nominal R = adverse distance / planned stop distance.

Report, for all fills and for event-straddle legs separately: n, mean, median and 80th percentile of the overshoot in bps and in R, plus the mean with negative values clipped to zero (secondary). Counts of fires with no matching `fills` row are reported as exclusions.

Event-straddle legs use the existing rule `isEventStraddle` in `src/lib/performance/lane-performance-business-logic.ts`: live, title matches `/straddle/i`, and an OCO group shared by at least two ladders.

### Bar and verdict

Build native resting entry triggers for straddle legs only if the mean overshoot (signed, in nominal R) on event-straddle legs exceeds 0.2R.

- **BUILD**: at least 5 event legs and mean above 0.2R.
- **DO-NOT-BUILD**: at least 5 event legs and mean at or below 0.2R.
- **INSUFFICIENT**: fewer than 5 event legs (numbers still print).

### Kill rule

If fewer than 5 event legs have a usable fill price and stop distance, the verdict is INSUFFICIENT. Do not lower the 5-leg floor. Do not add paper or non-straddle legs to the event count.

### Privacy

Account data (fills, sizes, ladder ids, balances) stays in the scratchpad output. The tracked files hold only the public date list, code and this document.

## Output

Run `pnpm study:catalyst-classes`. The real-data output goes to the session scratchpad `studies/catalyst-classes.real.txt`.
