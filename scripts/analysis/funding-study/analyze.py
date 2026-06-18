#!/usr/bin/env python3
"""Funding harvest feasibility study — pre-registered analysis (offline).

Reads cached data from data/backups/funding-study/ (run fetch_data.py first)
and evaluates the PRE-REGISTERED strategy. Nothing here was tuned after
looking at results; rules and thresholds were declared before computation:

  STRATEGY (per asset, per threshold E in {5%, 10%} APR — exactly two):
    - Long spot 1.0x notional (Base, no leverage) + short perp 1.0x notional
      on Hyperliquid at 2x margin (0.5x notional posted; ~50% buffer to liq).
    - ENTER when trailing 7-day mean of annualized hourly funding > E.
    - EXIT when trailing 3-day mean < 0% APR.
    - Signal evaluated at hour t using data through t; funding accrues from
      t+1 (no lookahead).
  COSTS (declared): HL taker 0.035% x 4 fills = 0.14% + Base spot swap
    0.30% round trip (our measured numbers) = 0.44% of notional per round
    trip, split half at entry / half at exit.
  CAPITAL BASE: deployed capital = 1.5x notional (1.0 spot + 0.5 margin).
  PRE-REGISTERED BAR: net APR (while deployed, on deployed capital) >= 10%
    with >= 30% time-deployed, OR >= 8% with >= 60% time-deployed.

Outputs: prints summary tables; writes results JSON to
data/backups/funding-study/results.json.

Usage: python3 scripts/analysis/funding-study/analyze.py
"""

import json
import os
import statistics
import sys
from datetime import datetime, timezone

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
CACHE_DIR = os.path.join(REPO_ROOT, "data", "backups", "funding-study")

ASSETS = ["ETH", "BTC"]
THRESHOLDS = [0.05, 0.10]  # entry thresholds, annualized (pre-registered)
EXIT_LEVEL = 0.0  # trailing 3d annualized < 0% -> exit (pre-registered)
ENTRY_WINDOW_H = 7 * 24
EXIT_WINDOW_H = 3 * 24
ROUND_TRIP_COST = 0.0044  # 0.14% HL taker x4 + 0.30% Base spot RT
HALF_COST = ROUND_TRIP_COST / 2
CAPITAL_MULT = 1.5  # 1.0 spot + 0.5 perp margin (2x)
LIQ_BUFFER = 0.50  # 2x margin short: ~+50% adverse move to liquidation
MOONWELL_APR = 0.05
HOURS_PER_YEAR = 24 * 365

# Regime eras (calendar mapping declared up front; 2026 eras per our live
# regime history: bull Apr-mid-May 2026, bear Feb-Mar + mid-May-Jun 2026).
ERAS = [
    ("2024H2", "2024-06-01", "2025-01-01"),
    ("2025 bear (Jan-Apr)", "2025-01-01", "2025-05-01"),
    ("2025 bull (May-Aug)", "2025-05-01", "2025-09-01"),
    ("2025 Q4", "2025-09-01", "2026-01-01"),
    ("2026 Jan (neutral)", "2026-01-01", "2026-02-01"),
    ("2026 bear (Feb-Mar)", "2026-02-01", "2026-04-01"),
    ("2026 bull (Apr-May15)", "2026-04-01", "2026-05-16"),
    ("2026 bear (May16-Jun)", "2026-05-16", "2026-12-31"),
]


def ms(date_str: str) -> int:
    return int(
        datetime.strptime(date_str, "%Y-%m-%d")
        .replace(tzinfo=timezone.utc)
        .timestamp()
        * 1000
    )


def fmt_dt(t_ms: int) -> str:
    return datetime.fromtimestamp(t_ms / 1000, timezone.utc).strftime("%Y-%m-%d %H:%M")


def load(name: str):
    with open(os.path.join(CACHE_DIR, name)) as f:
        return json.load(f)


def rolling_mean(values: list[float], window: int) -> list[float | None]:
    """rolling_mean[i] = mean(values[i-window+1 .. i]) or None if not enough."""
    out: list[float | None] = [None] * len(values)
    acc = 0.0
    for i, v in enumerate(values):
        acc += v
        if i >= window:
            acc -= values[i - window]
        if i >= window - 1:
            out[i] = acc / window
    return out


def simulate(times, rates, premiums, threshold, obs_per_day, periods_per_year):
    """Run the pre-registered harvest simulation on a funding series.

    rates are per-period funding (decimal). Returns trades + hourly PnL stream.
    """
    entry_w = 7 * obs_per_day
    exit_w = 3 * obs_per_day
    trail_entry = rolling_mean(rates, entry_w)
    trail_exit = rolling_mean(rates, exit_w)

    in_pos = False
    trades = []
    cur = None
    pnl_stream = []  # (time, cumulative net pnl per 1.0 notional)
    cum = 0.0
    n = len(rates)
    for t in range(n):
        if in_pos:
            cum += rates[t]  # short perp receives positive funding
            cur["funding"] += rates[t]
            cur["periods"] += 1
            if rates[t] < 0:
                cur["neg_run"] += rates[t]
                cur["worst_neg_run"] = min(cur["worst_neg_run"], cur["neg_run"])
            else:
                cur["neg_run"] = 0.0
        te = trail_entry[t]
        tx = trail_exit[t]
        if not in_pos and te is not None and te * periods_per_year > threshold:
            in_pos = True
            cum -= HALF_COST
            cur = {
                "entry_t": times[t],
                "entry_premium": premiums[t] if premiums else None,
                "funding": 0.0,
                "periods": 0,
                "neg_run": 0.0,
                "worst_neg_run": 0.0,
            }
        elif in_pos and tx is not None and tx * periods_per_year < EXIT_LEVEL:
            in_pos = False
            cum -= HALF_COST
            cur["exit_t"] = times[t]
            cur["exit_premium"] = premiums[t] if premiums else None
            cur["net"] = cur["funding"] - ROUND_TRIP_COST
            cur["forced"] = False
            trades.append(cur)
            cur = None
        pnl_stream.append((times[t], cum))
    if in_pos:  # force close at end of data
        cum -= HALF_COST
        cur["exit_t"] = times[-1]
        cur["exit_premium"] = premiums[-1] if premiums else None
        cur["net"] = cur["funding"] - ROUND_TRIP_COST
        cur["forced"] = True
        trades.append(cur)
        pnl_stream[-1] = (times[-1], cum)
    return trades, pnl_stream


def max_drawdown(stream, capital_base):
    """Max drawdown of cumulative income stream, as fraction of capital."""
    peak = 0.0
    mdd = 0.0
    for _, v in stream:
        peak = max(peak, v)
        mdd = max(mdd, peak - v)
    return mdd / capital_base


def summarize(trades, times, threshold_label, candles):
    total_periods = len(times)
    span_years = (times[-1] - times[0]) / (365.25 * 86400 * 1000)
    in_periods = sum(t["periods"] for t in trades)
    time_in = in_periods / total_periods
    gross = sum(t["funding"] for t in trades)
    costs = ROUND_TRIP_COST * len(trades)
    net = gross - costs
    in_years = in_periods / (total_periods / span_years) if total_periods else 0

    gross_apr_in_notional = gross / in_years if in_years > 0 else 0.0
    net_apr_in_notional = net / in_years if in_years > 0 else 0.0
    net_apr_in_capital = net_apr_in_notional / CAPITAL_MULT
    net_apr_span_capital = (net / CAPITAL_MULT) / span_years
    blended_with_moonwell = net_apr_span_capital + MOONWELL_APR * (1 - time_in)

    worst_trade = min((t["net"] for t in trades), default=0.0)
    worst_neg_run = min((t["worst_neg_run"] for t in trades), default=0.0)
    holding_days = [
        (t["exit_t"] - t["entry_t"]) / 86400000 for t in trades if "exit_t" in t
    ]

    # Liquidation analysis: max adverse (upward) price excursion per position
    breaches = 0
    max_mae = 0.0
    for t in trades:
        entry_px = px_at(candles, t["entry_t"])
        if entry_px is None:
            continue
        highs = [
            float(c["h"])
            for c in candles
            if t["entry_t"] <= c["t"] <= t.get("exit_t", times[-1])
        ]
        if not highs:
            continue
        mae = max(highs) / entry_px - 1
        max_mae = max(max_mae, mae)
        if mae >= LIQ_BUFFER:
            breaches += 1

    entry_prem = [abs(t["entry_premium"]) for t in trades if t.get("entry_premium")]
    exit_prem = [abs(t["exit_premium"]) for t in trades if t.get("exit_premium")]
    all_prem = entry_prem + exit_prem

    return {
        "threshold": threshold_label,
        "span_years": round(span_years, 2),
        "round_trips": len(trades),
        "forced_close_at_end": any(t.get("forced") for t in trades),
        "time_in_pct": round(time_in * 100, 1),
        "gross_apr_while_in_notional_pct": round(gross_apr_in_notional * 100, 2),
        "net_apr_while_in_notional_pct": round(net_apr_in_notional * 100, 2),
        "net_apr_while_in_capital_pct": round(net_apr_in_capital * 100, 2),
        "net_apr_full_span_capital_pct": round(net_apr_span_capital * 100, 2),
        "blended_apr_idle_in_moonwell_pct": round(blended_with_moonwell * 100, 2),
        "total_net_per_notional_pct": round(net * 100, 2),
        "total_costs_per_notional_pct": round(costs * 100, 2),
        "median_holding_days": round(statistics.median(holding_days), 1)
        if holding_days
        else 0,
        "worst_trade_net_notional_pct": round(worst_trade * 100, 3),
        "worst_negative_funding_run_pct": round(worst_neg_run * 100, 3),
        "liq_breaches_at_2x": breaches,
        "max_adverse_up_move_in_position_pct": round(max_mae * 100, 1),
        "mean_abs_basis_at_entry_exit_bps": round(
            statistics.mean(all_prem) * 10000, 1
        )
        if all_prem
        else None,
        "max_abs_basis_at_entry_exit_bps": round(max(all_prem) * 10000, 1)
        if all_prem
        else None,
    }


def px_at(candles, t_ms):
    for c in candles:
        if c["t"] <= t_ms <= c["T"]:
            return float(c["c"])
    return None


def era_metrics(trades, times, rates, periods_per_year):
    """Per-era: time-in %, mean funding APR (all hours), net contribution."""
    out = []
    # Build in-position flags per period
    in_flags = [False] * len(times)
    idx = {t: i for i, t in enumerate(times)}
    for tr in trades:
        i0 = idx[tr["entry_t"]]
        i1 = idx[tr.get("exit_t", times[-1])]
        for i in range(i0 + 1, i1 + 1):
            in_flags[i] = True
    for name, start, end in ERAS:
        s, e = ms(start), ms(end)
        sel = [i for i, t in enumerate(times) if s <= t < e]
        if not sel:
            continue
        n_in = sum(1 for i in sel if in_flags[i])
        mean_funding_apr = statistics.mean(rates[i] for i in sel) * periods_per_year
        in_funding = sum(rates[i] for i in sel if in_flags[i])
        era_years = len(sel) / periods_per_year
        out.append(
            {
                "era": name,
                "mean_funding_apr_pct": round(mean_funding_apr * 100, 2),
                "time_in_pct": round(n_in / len(sel) * 100, 1),
                "gross_funding_collected_notional_pct": round(in_funding * 100, 2),
                "era_gross_apr_on_capital_pct": round(
                    in_funding / era_years / CAPITAL_MULT * 100, 2
                ),
            }
        )
    return out


def flip_speeds(times, rates, periods_per_day, periods_per_year):
    """Distribution of flip speeds: hours from (24h-avg funding > +5% APR)
    to first (24h-avg < 0% APR) within each positive episode."""
    day_avg = rolling_mean(rates, periods_per_day)
    ann = [None if v is None else v * periods_per_year for v in day_avg]
    flips = []
    last_above = None
    for i, v in enumerate(ann):
        if v is None:
            continue
        if v > 0.05:
            last_above = i
        elif v < 0.0 and last_above is not None:
            flips.append((times[i] - times[last_above]) / 3600000)
            last_above = None
    if not flips:
        return None
    flips.sort()
    return {
        "n_flips": len(flips),
        "min_hours": round(flips[0], 1),
        "p10_hours": round(flips[max(0, int(len(flips) * 0.1) - 1)], 1),
        "median_hours": round(statistics.median(flips), 1),
        "max_hours": round(flips[-1], 1),
    }


def basis_blowouts(times, premiums, top_n=5):
    """Largest 24h basis (premium) moves — March-2025-style blowout check."""
    moves = []
    for i in range(24, len(premiums)):
        moves.append((abs(premiums[i] - premiums[i - 24]), times[i]))
    moves.sort(reverse=True)
    return [
        {"move_bps": round(m * 10000, 1), "at": fmt_dt(t)} for m, t in moves[:top_n]
    ]


def max_24h_up_moves(candles, top_n=3):
    """Largest 24h adverse moves for a short: daily high vs previous close."""
    moves = []
    for i in range(1, len(candles)):
        prev_close = float(candles[i - 1]["c"])
        high = float(candles[i]["h"])
        moves.append((high / prev_close - 1, candles[i]["t"]))
    moves.sort(reverse=True)
    return [
        {"up_move_pct": round(m * 100, 2), "on": fmt_dt(t)[:10]} for m, t in moves[:top_n]
    ]


def buy_hold_return(candles):
    return float(candles[-1]["c"]) / float(candles[0]["o"]) - 1


def pearson(xs, ys):
    mx, my = statistics.mean(xs), statistics.mean(ys)
    num = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    den = (
        sum((x - mx) ** 2 for x in xs) ** 0.5 * sum((y - my) ** 2 for y in ys) ** 0.5
    )
    return num / den if den else 0.0


def cross_check(hl_times, hl_rates, bn_rows):
    """Align HL hourly funding (summed into 8h buckets ending at Binance
    funding times) against Binance 8h rates; correlation + mean APRs."""
    hl_by_hour = {}
    for t, r in zip(hl_times, hl_rates):
        hl_by_hour[round(t / 3600000)] = r
    pairs = []
    for row in bn_rows:
        end_h = round(row["time"] / 3600000)
        bucket = [hl_by_hour.get(end_h - k) for k in range(8)]
        if all(v is not None for v in bucket):
            pairs.append((sum(bucket), row["fundingRate"]))
    if not pairs:
        return None
    hl_8h = [p[0] for p in pairs]
    bn_8h = [p[1] for p in pairs]
    return {
        "n_8h_obs": len(pairs),
        "correlation": round(pearson(hl_8h, bn_8h), 3),
        "hl_mean_apr_pct": round(statistics.mean(hl_8h) * 3 * 365 * 100, 2),
        "binance_mean_apr_pct": round(statistics.mean(bn_8h) * 3 * 365 * 100, 2),
        "pct_periods_positive_hl": round(
            sum(1 for v in hl_8h if v > 0) / len(hl_8h) * 100, 1
        ),
        "pct_periods_positive_binance": round(
            sum(1 for v in bn_8h if v > 0) / len(bn_8h) * 100, 1
        ),
    }


def main():
    results = {
        "generated": datetime.now(timezone.utc).isoformat(),
        "pre_registered": {
            "entry_thresholds_apr": THRESHOLDS,
            "exit_level_apr": EXIT_LEVEL,
            "entry_window_days": 7,
            "exit_window_days": 3,
            "round_trip_cost_pct": ROUND_TRIP_COST * 100,
            "capital_multiplier": CAPITAL_MULT,
            "bar": "net APR (while deployed, on deployed capital) >= 10% with "
            ">= 30% time-deployed, OR >= 8% with >= 60% time-deployed",
        },
        "assets": {},
    }

    snapshot = load("hl_meta_snapshot.json")

    for coin in ASSETS:
        funding = load(f"hl_funding_{coin}.json")
        candles = load(f"hl_candles_1d_{coin}.json")
        bn = load(f"binance_funding_{'ETHUSDT' if coin == 'ETH' else 'BTCUSDT'}.json")

        times = [r["time"] for r in funding]
        rates = [float(r["fundingRate"]) for r in funding]
        premiums = [float(r["premium"]) for r in funding]

        asset_out = {
            "span": f"{fmt_dt(times[0])} .. {fmt_dt(times[-1])} UTC",
            "n_hourly_obs": len(times),
            "mean_funding_apr_full_span_pct": round(
                statistics.mean(rates) * HOURS_PER_YEAR * 100, 2
            ),
            "pct_hours_funding_positive": round(
                sum(1 for r in rates if r > 0) / len(rates) * 100, 1
            ),
            "buy_hold_return_pct": round(buy_hold_return(candles) * 100, 1),
            "current_snapshot": {
                "funding_apr_pct": round(
                    float(snapshot["assets"][coin]["funding"]) * HOURS_PER_YEAR * 100, 2
                ),
                "open_interest": snapshot["assets"][coin]["openInterest"],
                "mark_px": snapshot["assets"][coin]["markPx"],
            },
            "strategies": {},
            "binance_cross_check": cross_check(times, rates, bn),
            "flip_speeds": flip_speeds(times, rates, 24, HOURS_PER_YEAR),
            "largest_24h_basis_moves": basis_blowouts(times, premiums),
            "largest_24h_up_moves": max_24h_up_moves(candles),
        }

        for thr in THRESHOLDS:
            label = f"{int(thr * 100)}% APR entry"
            trades, stream = simulate(times, rates, premiums, thr, 24, HOURS_PER_YEAR)
            s = summarize(trades, times, label, candles)
            s["income_stream_max_dd_capital_pct"] = round(
                max_drawdown(stream, CAPITAL_MULT) * 100, 2
            )
            s["eras"] = era_metrics(trades, times, rates, HOURS_PER_YEAR)
            # Binance generalization: same rules on 8h series, same costs
            bn_times = [r["time"] for r in bn]
            bn_rates = [r["fundingRate"] for r in bn]
            bn_trades, bn_stream = simulate(bn_times, bn_rates, None, thr, 3, 3 * 365)
            bs = {
                "round_trips": len(bn_trades),
                "time_in_pct": round(
                    sum(t["periods"] for t in bn_trades) / len(bn_rates) * 100, 1
                ),
            }
            bn_in_periods = sum(t["periods"] for t in bn_trades)
            bn_span_years = (bn_times[-1] - bn_times[0]) / (365.25 * 86400 * 1000)
            bn_in_years = (
                bn_in_periods / (len(bn_rates) / bn_span_years) if bn_rates else 0
            )
            bn_net = sum(t["funding"] for t in bn_trades) - ROUND_TRIP_COST * len(
                bn_trades
            )
            bs["net_apr_while_in_capital_pct"] = round(
                (bn_net / bn_in_years / CAPITAL_MULT * 100) if bn_in_years else 0, 2
            )
            s["binance_same_rules"] = bs
            asset_out["strategies"][label] = s

        results["assets"][coin] = asset_out

    out_path = os.path.join(CACHE_DIR, "results.json")
    with open(out_path, "w") as f:
        json.dump(results, f, indent=2)

    # ---- Print summary ----
    print(json.dumps(results, indent=2))
    print("\n==== VERDICT vs PRE-REGISTERED BAR ====")
    for coin in ASSETS:
        for label, s in results["assets"][coin]["strategies"].items():
            apr = s["net_apr_while_in_capital_pct"]
            ti = s["time_in_pct"]
            passed = (apr >= 10 and ti >= 30) or (apr >= 8 and ti >= 60)
            print(
                f"{coin} {label}: net APR (deployed) {apr}% @ {ti}% time-in "
                f"-> {'PASS' if passed else 'REJECT'}"
            )
    print(f"\nResults written to {out_path}")


if __name__ == "__main__":
    sys.exit(main())
