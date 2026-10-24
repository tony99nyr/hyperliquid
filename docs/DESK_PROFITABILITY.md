# Desk profitability — the evidence and the levers

A durable, dated record of "how do we get more profitable", so the answer lives
in the repo and not in one session's scrollback. Update it at a weekly retro
whenever the numbers move a lever's verdict; never between retros. Everything
here is derived from primary records (the HL fills API, the `hypotheses` and
`scout_decisions` tables, the shadow replay) — reproduce, don't trust.

## 2026-10-13 review (first entry)

### The account's own arc (all live fills, net of fees)

| Month | Fills | Net (incl. fees) |
|---|---|---|
| 2026-06 | 89 | −$204.61 |
| 2026-07 | 32 | −$34.15 |
| 2026-08 | 18 | +$41.03 |
| 2026-09 | 12 | +$38.77 |
| 2026-10 (to 13th) | 5 | −$2.13 |

Lifetime ≈ **−$161 all-in**, of which −$239 is June-July, before the desk
discipline existed. Since August: a quarter of the fills and ≈ **+$78**, about
+4%/month in months with a trend to ride, flat in chop. The single biggest
historical P&L driver was June churn, and it is already fixed. The current
regime (few, evidence-gated trades) IS the edge this account has demonstrated.

### Cost audit (156 lifetime fills)

- 100% taker. $39.32 total fees on $87.4k notional = **4.5 bps per side**.
- Mean entry overshoot on price-triggered opens/adds ≈ **+16 bps adverse**
  (median ~+10, worst +143). This is the documented fill-at-candle-close
  design, not a leak (rule: runbook, "When a rung fires").
- Maker entries would save ~3 bps per side ≈ $2-3/month at current size.
  **Verdict: not worth the build until size scales after a graduation.** A
  max-overshoot fire guard is a candidate rung field; it must be
  pre-registered, never slipped in.

### Capture audit (htf-trend shadow replay, all 21 misses attributed)

14 position-blocks (one position per lane+coin, by design) · 4 logged
stand-downs · 2 event blackouts · 1 daemon gap (~10.5h, 2026-09-21). True
infrastructure loss ≈ 5-15%, not the raw "66% missed" headline.
**Verdict: there is no capture multiplier to build.** Details in
`docs/scout/playbook.md` (2026-10-13 addendum).

### The levers, ranked (verdicts as of 2026-10-13)

1. **Finish the pre-registered bars, then size what passes.** htf-trend:
   +0.70R at n=11 (haircut ~+0.49R, at live break-even); ~9 closes from its
   n=20 checkpoint with the cluster-robust test. Pass → graduate at $5-10
   risk, quarter-Kelly. Fail → the money was saved. This is the main lever.
2. **The event lane.** compression-straddle survived its 6th-close bar (2/7,
   +$35). Binary events are where our size does not fight fee drag. Keep the
   straddle discipline by the book.
   *2026-10-24 note:* the fixed scorecard (`pnpm scout:review`) shows
   compression-straddle at -$12.39 on 7 closes, so the registered bar has fired
   (`PROFIT_REVIEW_2026-10-24.md`, F2). The Monday 2026-10-26 retro formalises the KILL.
3. **Ops reliability.** The only real capture losses were one daemon gap and
   one degraded feed. Keep the NAS crons healthy; nothing new to build.
4. **Costs.** Deferred (see the audit) — revisit after a graduation.
5. **Capital.** The binding constraint on dollars. At $1,000 and 1% risk, a
   perfect +0.5R weekly edge earns ~$5-20/month. The account's product is a
   validated system; capital scales what is PROVEN, never what is hoped.

### Proven negative — do not revisit without a new pre-registration

More 15m mechanical lanes · funding fades (killed) · leader copying (killed at
its bar) · trend-follow at 15m/4h (killed) · daily retro tinkering · wide
conditional-ladder lattices · sizing up to "make it back".

## How to reproduce the numbers

- **Core numbers:** run `pnpm analysis:profit-review` (`scripts/analysis/profit-review/`).
  It regenerates the lifetime and since-August totals and the lane figures. Use the
  manual recipes below only for figures the bundle does not port.
- **Fills/fees/monthly arc (manual):** POST `https://api.hyperliquid.xyz/info` with
  `{"type":"userFills","user":<HL_ACCOUNT_ADDRESS>}`; sum `closedPnl` and
  `fee` per month; `crossed` = taker. Overshoot: join `ladder_fires`
  (status='filled') to `ladder_rungs.trigger_px` and compare the matched
  fill's `px`, sign-adjusted by side; exclude `stop_move` rows and
  indicator-triggered reduces (no price trigger).
- **Capture attribution:** `pnpm scout:shadow-replay --json`, then classify
  each missed episode against open `hypotheses` intervals (position-block),
  the event calendar ±48h (blackout), `scout_decisions` rows naming the coin
  (stand-down), and >2h gaps in the decision cadence (daemon gap).
- **Lane verdicts:** `pnpm scout:review` (deterministic; do not re-derive).

The weekly retro that maintains this file: the `desk-retro` skill (`.claude/skills/desk-retro/SKILL.md`).
