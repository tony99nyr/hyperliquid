# Event-straddle exit shadow test

Registered 2026-10-24, before running the shadow comparison. This study does not alter the live template.

## Question and unit

Compare each exit policy against the current event-straddle template on the same event episode. One scheduled print is one episode, even if both BTC and ETH trigger. Count a printed event once. Group both OCO sides under that event and use only the first triggered side. An untriggered event contributes no paired outcome.

Use the event calendar and historical `ladders` / `ladder_fires` to identify prints and actual leg geometry. The calendar can omit old prints, so retain historical ladder episodes. Only an episode with one filled BTC open fire enters the decision sample. Show calendar-only replays as hypothetical. Never count a long and short leg as separate observations. Match the ETH comparison to the same event, with a 1% gate and stop at its own pre-print reference. Report missing history and unresolved positions separately.

## Frozen policies

The template expires at print +24h. It moves the stop to breakeven at +0.7R, reduces 34% of the then-open position at +1R, reduces 50% of the remainder at +2R, and starts a 0.8R trailing stop at +1.2R. The momentum-stall rung reduces 50% of the then-open position if a historical fired stall signal is available. A candle-only replay cannot reconstruct volume, CVD and order-book votes, so report missing stall history and do not invent a stall signal.

Compare four independent variants:

1. **48h expiry:** all template rungs remain active until print +48h.
2. **Trail-only:** retain the +0.7R breakeven move and +1.2R trail, but omit both profit-bank rungs. Retain the stall rung where observable.
3. **No +1R bank:** omit the 34% reduce; keep the +2R reduce and other rungs.
4. **ETH leg:** apply the unchanged 24h template to ETH with the same percentage gate and stop geometry. Pair its event return with the BTC template. This comparison includes asset selection, not only exit policy.

All exit variants reuse the template leg's trigger, stop, entry and costs. Model a completed 15-minute candle close as the rung signal, execute on the next candle open, and check the resting stop against each candle first. A gap past the stop fills at the adverse open. The entry pays 16 basis points of adverse overshoot and 4.5 basis points taker fee. Each exit pays 4.5 basis points. Use nominal R: gate-to-reference price distance times original position size. Apply the same costs to every policy.

Expiry disarms unfired rungs. It does not close the remaining position. The latest resting stop persists, but the trail stops updating after expiry. Fetch through print +7 days. Exclude open residuals from the completed paired statistics. Display their realised-plus-marked R as provisional. Do not use an expiry mark as a realised exit.

## Decision at eight events

Wait for at least eight **completed paired event episodes** for a variant. Use an event-level paired bootstrap with 10,000 resamples and a fixed seed. Report the mean variant-minus-template difference in R and the percentile 95% confidence interval. Also report the worst single-event difference. Adopt a variant only if the interval excludes zero on the positive side **and** the worst event is no worse than -1R versus the template. Otherwise keep the live template. Historical replay is supporting evidence; a live policy change still needs an operator decision. Do not select a different horizon, cost model, or subgroup after seeing results.
