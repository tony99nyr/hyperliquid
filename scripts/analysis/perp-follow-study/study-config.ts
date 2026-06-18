/**
 * PERP-FOLLOW STUDY — PRE-REGISTERED CONFIG (commit-to-disk BEFORE results)
 * =========================================================================
 * Follow-up to docs/trading/HL_PERSISTENCE_STUDY_2026-06.md (Gate 1, FAILED
 * unconditional) and docs/trading/COPY_TRADING_RESEARCH_2026-06-10.md.
 *
 * THE OPEN QUESTION (verbatim from study brief):
 *   "Does gating the copy on OUR regime detector convert the failed
 *    unconditional copy into positive, costed, out-of-sample alpha?"
 *
 * All thresholds, ranking definitions, cost terms, the latency model and the
 * verdict bar are FIXED HERE before any result is computed. This file is the
 * audit trail referenced at the top of the report.
 *
 * DATA REUSE (no refetch of the 218 MB):
 *   - data/backups/hyperliquid-study/  (universe, portfolios.jsonl, fills/, candles/, leaderboard, vaults, windows)
 *   - data/backups/funding-study/      (hl_funding_{ETH,BTC}.json hourly; hl_candles_1d_{ETH,BTC}.json 743d)
 *   - scripts/analysis/hyperliquid-persistence/lib.ts (loaders, windowBounds, stats)
 *
 * KNOWN HARD CONSTRAINT (documented before results, NOT discovered after):
 *   The HL fills endpoint retains only the most recent ~12k fills per account.
 *   Cached fills exist for 20 accounts (the Gate-1 anticipation cohort = the
 *   persistent-set top + extras). Of these, only a subset have ETH/BTC entry
 *   fills spanning >1 of the six 60d windows. Part B's leader-entry replay is
 *   therefore run on the accounts whose ETH/BTC fills actually cover adjacent
 *   selection/judgment windows; this is a power limitation, declared up front.
 */

export const STUDY_NAME = 'perp-follow-study';
export const ANCHOR_ISO = '2026-06-12'; // inherited from Gate 1 (lib.ts ANCHOR_MS)
export const RNG_SEED_PARTA = 20260613; // win-rate persistence bootstrap
export const RNG_SEED_PARTB = 20260613; // latency-delay sampling + arm bootstraps
export const RNG_SEED_DISCOVERY = 20260613; // off-leaderboard block-sampling
export const BOOTSTRAP_ITERS = 1_000;

// ===========================================================================
// OFF-LEADERBOARD DISCOVERY (the corrected selection universe)
// ===========================================================================
// The leaderboard universe (universe.json) bakes in variance/survivorship bias
// (big total PnL = lottery winners). The user wants the BROAD population of
// actively-trading wallets, discovered OFF the leaderboard, then filtered by a
// PANEL of risk-aware quality metrics (below). We harvest distinct trader
// addresses from Hyperliquid L1 block data via the public explorer node RPC.
//
// SOURCE (probed 2026-06-13, works with >=2s pacing; rate-limited if hammered):
//   POST https://rpc.hyperliquid.xyz/explorer {"type":"blockDetails","height":H}
//   -> blockDetails.txs[].user = trader address; ~700-1500 txs/block.
//   Tip ~block 1.034e9 (~2026-06-12); ~13.46 blocks/sec; 1000M=2026-05-17.
//
// COVERAGE IS A SAMPLE, NOT A CENSUS (declared honestly): enumerating all ~67M
// blocks of the 60d window is infeasible against a paced/throttled endpoint.
// We SAMPLE blocks uniformly across the 60d window and union their distinct
// `user` addresses. Sample size + achieved coverage fraction are LOGGED, not
// hidden. Heavy-traders are over-represented in any block sample (they appear in
// more blocks) — this is stated as a known sampling bias toward active accounts,
// which is acceptable since "actively trading" is part of the target definition.
export const DISCOVERY = {
  EXPLORER_RPC: 'https://rpc.hyperliquid.xyz/explorer',
  REQUEST_SPACING_MS: 5000,        // 5s pacing — explorer RPC hard-throttles faster (probed: 429 at 3s, clean at 5s)
  WINDOW_60D_START_ISO: '2026-04-13',
  WINDOW_60D_END_ISO: '2026-06-12',
  TARGET_BLOCK_SAMPLES: 450,       // ~450 blocks @5s ~= 38min; blocks carry 300-18k txs => tens of thousands of distinct addrs
  // Address harvested if it appears as `user` in any sampled block tx of type
  // order/cancel/etc. (any L1 action implies an active trader).
} as const;

// Active-trader filter (declared before computing):
export const ACTIVE_FILTER = {
  MIN_ROUNDTRIPS_60D: 20,          // >=20 closed round-trips in trailing 60d
  MIN_DISTINCT_DAYS: 5,            // traded on >=5 distinct days (not a one-shot)
} as const;

// --- Windows: inherited verbatim from Gate 1 (six consecutive 60d windows) ---
// w0 2025-06-17->08-16, w1 ->10-15, w2 ->12-14, w3 ->2026-02-12, w4 ->04-13, w5 ->06-12.
// Two regime breaks inside: Oct-2025 cascade (w1/w2), Feb-Apr-2026 downturn (w3/w4).

// ===========================================================================
// PART A — WIN-RATE SELECTION (the user's specific metric, untested in Gate 1)
// ===========================================================================
// Round-trip construction: per (account, coin), walk fills time-ordered; track
// signed net position. A round-trip = position goes from flat -> non-flat ->
// back to flat (or sign-flips through flat). Realized PnL per round-trip is the
// sum of `closedPnl` over the closing fills of that trip MINUS fees on all
// fills in the trip. win = realized round-trip PnL > 0.
export const PARTA = {
  MIN_ROUNDTRIPS: 20,            // accounts with <20 closed round-trips => insufficient
  // Blow-up flag fires if EITHER condition holds:
  BLOWUP_SINGLE_LOSS_X_MEDIAN_WIN: 2.0, // any single round-trip loss > 2x median win
  BLOWUP_MAX_DD_FRAC: 0.50,             // OR account maxDD > 50% of avg account value
  // Win-rate persistence: same six 60d windows. For each account compute per-window
  // win rate; test Spearman IC of winRate(N) vs winRate(N+1) AND vs PnL-return(N+1).
  MIN_TRIPS_PER_WINDOW: 5,       // a window's win rate needs >=5 round-trips to count
  TOP_DECILE_FRAC: 0.10,         // barbell check uses top decile by win rate
} as const;

// ===========================================================================
// SELECTION-METRIC PANEL + COMPOSITE (the central scientific question)
// ===========================================================================
// The user's refined target: NOT win rate alone, but "traders who handle risk
// well AND win often" — truly the best given the risk taken. We compute a PANEL
// per active wallet over the trailing 60d, rank by EACH, and ask which metric
// best identifies an edge that PERSISTS forward and is COPYABLE.
//
// Per-trade returns = realized round-trip PnL / notional-at-entry (sign by side).
// Daily returns = sum of round-trip PnL per UTC day / trailing avg account value.
export const METRICS = {
  // Descriptive panel (each becomes a ranking):
  PANEL: ['winRate', 'rawPnl', 'pnlPct', 'sharpe', 'sortino', 'calmar', 'profitFactor'] as const,
  RETURNS_BASIS_SHARPE: 'per-trade',  // Sharpe/Sortino on per-round-trip return series (declared)
  ANNUALIZE_TRADES_PER_YEAR: null,    // report raw per-trade SR; do not annualize (trade cadence varies)
  // Leverage-discipline proxy: median(entry notional / account value at entry).
  // High proxy + high win rate => "surviving on leverage + luck", penalized in composite.
  LEVERAGE_PROXY: 'median(entryNotional / accountValueAtEntry)',
  LEVERAGE_PENALTY_THRESHOLD: 5.0,    // proxy above this is flagged excessive
} as const;

// COMPOSITE "trader-quality-given-risk" score — PRE-REGISTERED, NOT tuned.
// Simple z-scored blend of the risk-aware metrics, penalized for blow-up + excess
// leverage. Computed within the active universe (z-scores use universe mean/std).
//   composite = z(winRate) + z(sortino) + z(calmar)
//               - 1.0 * blowUpFlag            (hard 1-sigma-equivalent penalty)
//               - 0.5 * (leverageProxy > LEVERAGE_PENALTY_THRESHOLD ? 1 : 0)
// Winsorize each metric at [p01,p99] before z-scoring to limit outlier dominance.
export const COMPOSITE = {
  WEIGHTS: { winRate: 1.0, sortino: 1.0, calmar: 1.0 },
  BLOWUP_PENALTY: 1.0,
  LEVERAGE_PENALTY: 0.5,
  WINSOR_LO: 0.01,
  WINSOR_HI: 0.99,
} as const;

// FORWARD-PERSISTENCE TEST (run for EACH metric ranking):
//   (a) Spearman IC metricX(N) -> metricX(N+1), pooled + per-pair
//   (b) top-quintile transition matrix + barbell (P(top->top) vs P(top->bottom))
//   (c) blow-up rate among top-quintile-by-X
//   (d) does top-quintile-by-X in N have POSITIVE pooled PnL in N+1?
// Headline: which metric has highest forward IC AND least left-tail.
export const PERSISTENCE = { TOP_QUANTILE: 0.20 } as const;

// ===========================================================================
// PART B — REGIME-GATED FOLLOWING REPLAY (the core new test)
// ===========================================================================
// Selection: at each selection window N, rank leaders on PRE-window (<= window N
// end) data ONLY by two declared methods, judged on window N+1 entry fills:
//   (1) WIN_RATE      — Part A win rate over data up to end of window N
//   (2) CONSISTENCY   — risk-adjusted score = window return / within-window daily
//                       PnL vol (Gate 1's only defensible ranker), up to window N
export const PARTB = {
  N_LEADERS: 5, // mirror the top-5 selected leaders' entries each window (3-7 band; 5 declared)

  // --- Regime gate (prod-faithful) ---
  // OUR detectMarketRegimeCached on OUR HL daily ETH/BTC candles, evaluated at the
  // daily candle whose close is the last completed candle at/just before the fill ts.
  // Prod config: regimeConfidenceThreshold = 0.10 (eth v21.13 / btc v26.8).
  REGIME_CONFIDENCE_PRIMARY: 0.10, // prod regimeConfidenceThreshold — the declared gate
  REGIME_CONFIDENCE_STRICT: 0.55,  // sensitivity: validator trendAlignment.minRegimeConfidence
  // Gate rule: mirror a LONG entry only if regime==bullish & confidence>=bar.
  //            mirror a SHORT entry only if regime==bearish & confidence>=bar.
  //            else SKIP that copy.

  // --- Costs (declared, applied net) ---
  TAKER_FEE_PER_SIDE: 0.00045, // 0.045% Hyperliquid taker, per side (entry+exit => 2x)
  SLIPPAGE_PER_SIDE: 0.0005,   // 0.05% majors, per side
  // Funding: realized hourly funding from data/backups/funding-study/hl_funding_{ETH,BTC}.json.
  // Long pays +funding when rate>0; short receives it. Applied per hour held, sign-correct.

  // --- Latency-drift model (our reaction is NOT instant) ---
  // Live cadence = 8h signal cron + relayer windows up to 6.5h. We model entry at
  // leader-fill-time + delay. Realistic case = "next-window": snap to the next 8h
  // signal boundary after the fill, plus a uniform relayer delay in [0, 6.5h].
  LATENCY_MODEL: 'next-8h-boundary-plus-uniform-relayer',
  SIGNAL_CADENCE_HOURS: 8,
  RELAYER_MAX_HOURS: 6.5,
  // Sensitivity arms reported alongside the realistic case:
  LATENCY_SENSITIVITY_HOURS: [0, 1] as const, // instant, +1h (next-window is the realistic default)

  // --- Position exit (declared which dominates) ---
  // Exit at the EARLIER of: (a) leader closes that coin's position (round-trip end),
  // or (b) OUR regime flips away from the trade direction OR decays below the gate
  // confidence. "Regime flip/decay dominates" — i.e. we do not hold a long once our
  // detector leaves bullish, even if the leader is still long (this is the whole
  // point of the gate; it must be allowed to cut as well as to admit).
  EXIT_RULE: 'min(leader_close, our_regime_flip_or_decay)',

  // --- Arms ---
  // (i)  UNCONDITIONAL — mirror every selected-leader ETH/BTC entry, exit on leader close
  // (ii) REGIME-GATED  — mirror only when our regime agrees at gate confidence; exit per EXIT_RULE
  // (iii)REGIME-ALONE  — our detector trades direction (long bullish / short bearish / flat else), no leader
  // (iv) HOLD          — buy-and-hold the asset over the same judged span
} as const;

// ===========================================================================
// VERDICT BAR (pre-registered, decisive on REAL OOS windows >=1 regime break)
// ===========================================================================
// Regime-gated copy (arm ii) PASSES only if, net of all costs+latency, on the
// realistic latency case, pooled across the testable OOS judgment windows:
//   1. arm(ii) net annualized > arm(iii) regime-alone   AND
//   2. arm(ii) net annualized > arm(iv) hold             AND
//   3. arm(ii) net annualized > arm(i)  unconditional    AND
//   4. arm(ii) Sharpe clears the DEFLATED-SHARPE hurdle for best-of-N selection:
//      expected max Sharpe under the null across the N selection trials must be
//      beaten (computed via the standard E[max] of N iid normal SR estimates).
// If win-rate selection underperforms consistency selection, SAY SO.
// If the gate does NOT add over regime-alone (leaders contribute nothing beyond
// what our own detector already knows) => REJECT. That is the likely outcome and
// the single most important thing to determine.
export const VERDICT = {
  REQUIRE_BEAT: ['regime-alone', 'hold', 'unconditional'] as const,
  REQUIRE_DEFLATED_SHARPE: true,
} as const;

// ===========================================================================
// MULTIPLE-TESTING GUARD (the real enemy of "who are the best given risk")
// ===========================================================================
// On a platform of 10^5+ traders, some show spectacular 60d risk-adjusted
// records by PURE CHANCE. A candidate counts as SKILL only if their record beats
// what the best-of-N coin-flippers would produce. We compute the luck-only
// EXPECTED MAXIMUM Sharpe across the discovered universe size N (deflated-Sharpe
// framework): for N iid zero-skill traders each with T round-trips in 60d, the
// expected max of their sample Sharpe estimates is approximately
//   E[max SR] ~ sqrt(Var(SR_hat)) * ( (1-g)*Z(1 - 1/N) + g*Z(1 - 1/(N e)) )
// with g = Euler-Mascheroni, Var(SR_hat) ~ (1 + 0.5*SR^2)/T ~ 1/T under H0:SR=0,
// Z = inverse standard normal CDF. We report every top candidate's Sharpe AGAINST
// this hurdle and state it in the verdict.
export const MULTIPLE_TESTING = {
  EULER_MASCHERONI: 0.5772156649,
  // N = size of the discovered active universe (filled in at runtime, logged).
  // T = median round-trips per active wallet in 60d (logged).
} as const;

// LEADERBOARD COMPARISON COHORT (the user's core hypothesis):
// Reuse the cached leaderboard universe (universe.json) — but for THIS comparison
// ONLY — to build a leaderboard-derived high-win-rate cohort, and contrast its
// forward persistence + blow-up tail against the off-leaderboard high-win-rate
// cohort. Question: is the off-leaderboard population actually different/better?
export const COMPARISON = { ENABLE_LEADERBOARD_COHORT: true } as const;

export const PATHS = {
  HL_DIR: '/home/tony/gitrepos/iamrossi/data/backups/hyperliquid-study',
  FUNDING_DIR: '/home/tony/gitrepos/iamrossi/data/backups/funding-study',
  OUT_DIR: '/home/tony/gitrepos/iamrossi/data/backups/perp-follow-study',
} as const;
