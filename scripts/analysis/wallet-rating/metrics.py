#!/usr/bin/env python3
"""Per-wallet metric extraction from assembled Jupiter Perps cycles.

Input: a list of cycle dicts (the schema produced by the friend-wallets
`analyze_cycles.py` assembler — see data/backups/friend-wallets/*.cycles.json).
Output: a flat dict of the exact metric names the rating config thresholds key on.

This is the bridge between the cycle assembler and the rating engine. Keep the
output keys in sync with the names referenced in
configs/wallet-selection-vX.Y.Z.json (riskDiscipline / performance / rubric).

All cycle USD fields are already in dollars (the assembler divided by 1e6).
"""
import math
import statistics


def _q(arr, p):
    if not arr:
        return 0.0
    arr = sorted(arr)
    k = (len(arr) - 1) * p
    f = math.floor(k)
    c = math.ceil(k)
    if f == c:
        return float(arr[int(k)])
    return arr[f] * (c - k) + arr[c] * (k - f)


def _collateral_multiple(cycle):
    """Peak collateral / first-buy collateral within a cycle.

    The first-buy collateral is the first element of add_collateral_seq.
    Falls back to None when the starter add is unknown (e.g. cycle opened before
    the earliest reachable signature -> no captured starter)."""
    seq = cycle.get("add_collateral_seq") or []
    if not seq or seq[0] <= 0:
        return None
    peak = cycle.get("peak_collateral") or 0.0
    if peak <= 0:
        return None
    return peak / seq[0]


def _is_adverse_cycle(cycle):
    """A cycle counts as ADVERSE if it went meaningfully underwater at some point
    (max adverse excursion > a small fraction of peak collateral). Stop-usage is
    measured only over these — riding a green trade to close is not a discipline
    signal either way."""
    peak = cycle.get("peak_collateral") or 0.0
    mae = cycle.get("mae_usd") or 0.0
    if peak <= 0:
        return False
    return (mae / peak) >= 0.05


def _cut_at_loss(cycle):
    """Did the wallet CUT this adverse cycle at a realized loss (a 'stop'), vs ride
    it back to a green/flat close? net_pnl < 0 on a cleanly-closed (non-liquidated)
    cycle == took the loss voluntarily."""
    return (not cycle.get("liquidated")) and (cycle.get("net_pnl") or 0.0) < 0


def extract_metrics(cycles, subperiod_count=4):
    """Compute the full metric bundle the rating config keys on.

    Returns a dict with both the threshold inputs (maxAddDepth, stopUsage, ...)
    and descriptive fields (winRate, aggregateNetPnl, ...) for the UI.
    """
    closed = [c for c in cycles if not c.get("open") and (c.get("peak_collateral") or 0) > 0]
    openc = [c for c in cycles if c.get("open")]
    incomplete = [c for c in cycles if not c.get("open") and (c.get("peak_collateral") or 0) <= 0]

    n = len(closed)
    if n == 0:
        return {
            "scorable": False,
            "reason": "no_closed_cycles",
            "nClosedCycles": 0,
            "nOpenCycles": len(openc),
            "nIncompleteCycles": len(incomplete),
        }

    wins = [c for c in closed if (c.get("net_pnl") or 0) > 0]
    losses = [c for c in closed if (c.get("net_pnl") or 0) <= 0]
    liqs = [c for c in closed if c.get("liquidated")]

    gross_win = sum(c["net_pnl"] for c in wins)
    gross_loss = -sum(c["net_pnl"] for c in losses)
    pf = (gross_win / gross_loss) if gross_loss > 0 else float("inf")

    agg = sum(c["net_pnl"] for c in closed)
    med_roc = statistics.median(c.get("ret_on_peak_collateral") or 0.0 for c in closed)
    med_win = statistics.median([c["net_pnl"] for c in wins]) if wins else 0.0

    adds = [c.get("adds") or 0 for c in closed]
    max_add_depth = max(adds) if adds else 0

    coll_mults = [m for m in (_collateral_multiple(c) for c in closed) if m is not None]
    max_coll_mult = max(coll_mults) if coll_mults else 1.0

    peak_colls = [c.get("peak_collateral") or 0.0 for c in closed]
    median_peak = statistics.median(peak_colls) if peak_colls else 0.0
    worst_peak = max(peak_colls) if peak_colls else 0.0
    peak_vs_median = (worst_peak / median_peak) if median_peak > 0 else 1.0

    # Max adverse excursion as a fraction of that cycle's peak collateral.
    mae_fracs = []
    for c in closed:
        pk = c.get("peak_collateral") or 0.0
        if pk > 0:
            mae_fracs.append((c.get("mae_usd") or 0.0) / pk)
    max_mae_pct = max(mae_fracs) if mae_fracs else 0.0

    # Stop usage over adverse cycles only.
    adverse = [c for c in closed if _is_adverse_cycle(c)]
    cut = [c for c in adverse if _cut_at_loss(c)]
    stop_usage = (len(cut) / len(adverse)) if adverse else 0.0

    # --- Open-position guard inputs (the Wallet2 disqualifier) ---
    # Compare the worst open cycle against the wallet's closed-cycle norms.
    open_mae_vs_median_win = 0.0
    open_peak_vs_median_peak = 0.0
    worst_open = None
    if openc:
        for c in openc:
            mae = c.get("mae_usd") or 0.0
            if worst_open is None or mae > (worst_open.get("mae_usd") or 0.0):
                worst_open = c
        wmae = worst_open.get("mae_usd") or 0.0
        wpeak = worst_open.get("peak_collateral") or 0.0
        if med_win and med_win > 0:
            open_mae_vs_median_win = wmae / med_win
        elif wmae > 0:
            open_mae_vs_median_win = float("inf")
        if median_peak > 0:
            open_peak_vs_median_peak = wpeak / median_peak

    # --- Consistency: positive sub-periods + profit concentration ---
    times = sorted(c.get("end_time") or 0 for c in closed)
    t0, t1 = times[0], times[-1]
    positive_subperiods = 0
    profit_concentration = 0.0
    if t1 > t0 and subperiod_count > 0:
        span = (t1 - t0) / subperiod_count
        bucket_pnl = [0.0] * subperiod_count
        for c in closed:
            et = c.get("end_time") or 0
            idx = min(subperiod_count - 1, int((et - t0) / span)) if span > 0 else 0
            bucket_pnl[idx] += c.get("net_pnl") or 0.0
        positive_subperiods = sum(1 for b in bucket_pnl if b > 0)
        total_pos = sum(b for b in bucket_pnl if b > 0)
        if total_pos > 0:
            profit_concentration = max(b for b in bucket_pnl) / total_pos
    else:
        positive_subperiods = 1 if agg > 0 else 0
        profit_concentration = 1.0

    active_days = (t1 - t0) / 86400.0 if t1 > t0 else 0.0

    return {
        "scorable": True,
        "nClosedCycles": n,
        "nOpenCycles": len(openc),
        "nIncompleteCycles": len(incomplete),
        "activeDays": round(active_days, 1),
        "firstCycleTime": t0,
        "lastCycleTime": t1,
        "markets": sorted({c.get("market") for c in closed if c.get("market")}),

        # riskDiscipline inputs
        "maxAddDepth": max_add_depth,
        "maxCollateralMultiple": round(max_coll_mult, 2),
        "peakCollateralVsMedian": round(peak_vs_median, 2),
        "stopUsage": round(stop_usage, 4),
        "maxAdverseExcursionPct": round(max_mae_pct, 4),
        "liquidations": len(liqs),
        "nAdverseCycles": len(adverse),
        "openMaeVsMedianWin": (open_mae_vs_median_win
                               if open_mae_vs_median_win != float("inf") else 999999.0),
        "openPeakVsMedianPeak": round(open_peak_vs_median_peak, 2),
        "worstOpen": ({
            "market": worst_open.get("market"),
            "side": worst_open.get("side"),
            "adds": worst_open.get("adds"),
            "peakCollateral": worst_open.get("peak_collateral"),
            "maeUsd": worst_open.get("mae_usd"),
            "netPnlSoFar": worst_open.get("net_pnl"),
        } if worst_open else None),

        # performance inputs
        "winRate": round(len(wins) / n, 4),
        "nWins": len(wins),
        "nLosses": len(losses),
        "profitFactor": (round(pf, 3) if pf != float("inf") else None),
        "medianReturnOnCollateral": round(med_roc, 4),
        "aggregateNetPnl": round(agg, 2),
        "medianWinUsd": round(med_win, 2),

        # consistency inputs
        "positiveSubPeriodFraction": (round(positive_subperiods / subperiod_count, 3)
                                      if subperiod_count else 0.0),
        "positiveSubPeriods": positive_subperiods,
        "profitConcentration": round(profit_concentration, 3),

        # descriptive peaks for UI
        "medianPeakCollateral": round(median_peak, 2),
        "maxPeakCollateral": round(worst_peak, 2),
    }
