# Plan: the HL trend-ladder lane (response to the 2026-07-25 iamrossi handoff)

**Status:** BUILT 2026-07-25 (same day) — Tony chose **Option B** (the swap leakage changed
the coupling calculus: "the systems kind of need each other"), **start small** (probe ~$10
campaign risk, no funding move yet), **telemetry-first** (the lane must earn a SIZE-UP in
the expectancy ledger's `trend-follow-8h-long` bucket). Cockpit commit `1b608a4`; stance
route restored in iamrossi (landed via their `71a2e47b`); `STANCE_READ_TOKEN` provisioned
both sides. Nothing armed — drafts always wait for the human. Companion to
[2026-07-25-eth-exposure-from-iamrossi.md](./2026-07-25-eth-exposure-from-iamrossi.md).

**Goal.** When the iamrossi 8h trend system is **bullish and confident** on ETH, add
tactical exposure via a **careful HL armed ladder** (2.5–4.5 bps/fill) instead of the
retired Base leverage loop (2–3% per round-trip). Discovery + alerting automated;
**arming stays human** (same discipline as the shipped reversion-alert lane).

## What was verified today (2026-07-25)

- **The signal contract** (iamrossi repo): 8h cron at 00:05/08:05/16:05 UTC, ETH+BTC,
  **long-or-cash, never short**. Regime = `{bullish|bearish|neutral, confidence 0–1}`.
  The retired leverage lane's gate was exactly
  `regime === 'bullish' && confidence >= 0.7` (in `yield-actions.ts::evaluateLeverageEntry`),
  with a **2h regime-flip watchdog** (`checkLeverageUnwind`: flag off / HF / regime ≠ bullish /
  price −10% from entry). That pair — 8h entry gate + 2h flip watchdog — is the contract to mimic.
- **A stance API already exists in git history**: commit `8a1c6803` (2026-07-16, reverted
  same day by `8b695261`) added `GET /api/trading/stance` — read-only, `STANCE_READ_TOKEN`
  bearer, returns `stances[{asset, enabled, position: 'holding'|'cash', regime,
  regimeConfidence, ...}]`. The env contract survived the revert in `.env.example`.
  **CAVEAT: that revert was a deliberate operator decision** (Tony wanted to think
  cross-system coupling through — see the cross-system-eth-exposure memory). Restoring it
  is Option B below, not a given.
- **A coupling-free equivalent already half-exists**: the regime gate iamrossi used for the
  leverage lane is the pure `detectMarketRegime` — the SAME function is vendored in this
  repo (`src/lib/strategy/analysis/market-regime-detector.ts`) and, run on HL candles, was
  verified (Jul 21) to reproduce iamrossi's read. Running it on HL **8h** ETH candles
  reproduces `regime + confidence` locally with zero coupling; the on-chain household read
  (once fixed) shows whether iamrossi actually expressed it (holding ETH vs cash — the
  system is long-or-cash, so wallet state ≈ signal state).
- **Cockpit template exists**: `reversion-alert` (`5dac4a6`) auto-DRAFTS a low-qty live
  ladder from the ladder-watch cron on a fresh signal, Discord-nudges, dedupes per episode,
  caps per cycle, **never arms**. The trend lane mirrors this shape exactly.
- **Desk state**: live equity **~$963** (all spot USDC, flat book); two small armed
  conditionals (BTC reclaim-long $1 risk, HYPE bounce-short $2.50). ETH ~$1,859, funding
  mildly positive. iamrossi's own ETH SELL is pending → **stance is NOT bullish today; nothing
  to draft yet.** The lane goes live at the *next* bullish+confident transition.
- **Gap found**: `pnpm household` reads **$0** while the iamrossi wallet holds ~8.5 native
  ETH + 1.4 weETH — `household-exposure-service.ts` only counts weETH/cbBTC/USDC ERC-20s;
  **native ETH is invisible**. Must fix: household stacking is a sizing input, and when this
  lane fires, HL-long stacks on iamrossi spot-long *by design* — it has to be visible.

## Architecture (3 small pieces + 1 fix)

1. **The stance source — Tony picks A or B:**
   - **Option A — coupling-free (default recommendation, honors the Jul-16 revert):**
     `trend-stance-service.ts` computes the gate locally: vendored `detectMarketRegime` on
     HL **8h** ETH candles → `{regime, confidence}` (the same pure function iamrossi's gate
     runs), cross-checked against the on-chain holding/cash read (public Base RPC). Fires
     only when BOTH agree (regime bullish ≥ 0.7 AND wallet actually holding). Drift risk vs
     iamrossi's own compute (different candle store/boundaries) is bounded by the on-chain
     confirmation. Zero tokens, zero API, nothing to restore in the other repo.
   - **Option B — exact ground truth:** restore `GET /api/trading/stance` from `8a1c6803`
     in the iamrossi repo + set `STANCE_READ_TOKEN`; cockpit polls it. Higher fidelity
     (`enabled`, config nuance, its exact confidence) but reinstates the coupling that was
     deliberately reverted — needs an explicit "yes, revive the bridge" from Tony.
   - Either way the reader is one module with one return shape, so A can be swapped for B
     later without touching the drafter. Optional in both: wire iamrossi's dead
     `sendRegimeChangeAlert` Discord hook (exported, zero callers).
2. **Cockpit — trend-alert (drafter)**: mirror reversion-alert 1:1.
   - `trend-alert-business-logic.ts` (PURE, tested): `buildTrendLadderPlan` — the playbook
     pyramiding shape (below), mode ALWAYS `'live'`, low-qty; + `trendAlertMessage`.
   - `trend-alert-service.ts` (I/O): on a **fresh transition** into
     `eth.regime==='bullish' && regimeConfidence>=0.7` → create ONE ladder DRAFT + Discord
     ping. Dedupe per bullish *episode* (no new draft while one armed/draft trend ladder for
     the coin exists or within 24h), hard cap 1/cycle, fail-soft. **NEVER arms.**
   - Wired into the existing ladder-watch cron behind `TREND_ALERT_ENABLED` (default OFF).
   - ETH first; BTC is a config addition later (stance route already returns both).
3. **Cockpit — regime-flip guard (disarm-only)**: alongside the leader guard in the cron:
   while a trend-tagged ladder is armed, if stance reads **not bullish** → auto-DISARM
   pending entry rungs + Discord alert ("regime flipped — review the open position").
   Disarm-only (precedent: leader guard); the native stop keeps protecting the position;
   closing stays human. If stance is *unreadable* while a trend ladder is armed → alert
   (fail-closed = nag, never fire).
4. **Fix the household reader**: add native ETH (`getBalance`) so `pnpm household` /
   desk-review show true cross-system stacking.

## The ladder shape (drafted at signal time with live ATR; panel-reviewed before arm)

Per the desk playbook + handoff constraints (**adds ≤ 2, no auto-adds beyond the
pre-authorized rungs, ATR/structure stops, risk-first**):

- Core `open` (~50% of campaign risk): momentumConfirm entry filter; native bracket stop
  beyond structure / ~2×ATR(8h), isolated 2×; **core alone must be a coherent trade**.
- ≤2 `add` rungs, decreasing size, `price_above` confirmation triggers — the engine's
  profit-coverage gate makes them anti-martingale by construction.
- `stop_move` → breakeven after the first add/target; `stop_move` trail on extension.
- 2 `reduce` scale-outs (`reduceFrac` ~0.4) into structural resistance.
- Expiry ~5–7 days (the 8h system holds while bullish; the flip guard is the real exit).
- Tag `setup_type: 'trend-follow-8h'` so **ladder-expectancy** can KILL/SIZE-UP this lane
  against the pre-registered bar. First 2–3 campaigns at probe size regardless of tier.

## The sizing decision (Tony's call — the plan's one open input)

The retired lane ran ~$8–16k notional (≈4.4–8.8 ETH delta). Playbook discipline
(≤~2× aggregate, 2–3% campaign risk) on **$963** supports ~**$1–2k notional ≈ 1 ETH-equiv**
— ~12–22% of the old lane. Options:

- **(a) Fund HL to ~$4–8k** → 2× aggregate replaces the old delta. Mind §6 single-venue
  concentration — don't move the whole bankroll onto HL.
- **(b) Stay at $963** → accept ~1 ETH-equiv of amplification; cheapest, proves the loop.
- **(c) Staged (recommended)**: run the first 1–2 campaigns at current equity (probe size),
  fund toward (a) only if the expectancy ledger says the lane pays.

## Build order

0. **Tony decides**: stance source A (coupling-free local detector + on-chain check) or
   B (restore the stance API — reverses the Jul-16 revert); and the funding option (a/b/c).
1. Household native-ETH fix (independent, do now; also find out why the 1.4 weETH read $0
   on Jul 25 — it should have shown ~$2.6k).
2. Cockpit: stance reader (per the chosen option) → trend-alert drafter → flip guard
   (each PURE+tested per repo conventions; `pnpm validate` green).
   *(If B: first a small PR in the iamrossi repo restoring the route + `STANCE_READ_TOKEN`.)*
3. Prod env: `TREND_ALERT_ENABLED=true` (+ stance URL/token if B) in Vercel; flag stays OFF
   until the stance read is verified live.
4. On first Discord nudge: Claude runs the 4-skeptic adversarial panel + `review-ladder`,
   Tony arms in the cockpit. Ledger closes the loop weekly.

**No-shorts note:** bearish/neutral = flat (disarm + alert), never a short ladder — the
signal system is long-or-cash and a short lane would be a different thesis entirely.
