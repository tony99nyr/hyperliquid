#!/usr/bin/env python3
"""Copyability-at-scale metric extraction from Hyperliquid userFills.

Input: a HL `userFillsByTime` array (list of fill dicts) for one address, plus
the rating config thresholds. Output: the flat metric bundle that the
COPYABILITY philosophy config keys on.

The lens is "can we realistically and profitably MIRROR this person":
  - liquid-majors share (ETH/BTC vs thin alts)
  - median hold time per round-trip (sub-minute scalps are uncopyable)
  - position notional vs market depth (does our clip move the book)
  - net-of-cost return AFTER the documented copy tax (taker fee + slippage + funding)
  - add depth / reserve requirement (a 54-add martingale needs huge idle capital)
  - tail safety (worst-loss / median-win blow-up signature, 90% of the HL universe)

Round-trips are reconstructed by signed-size accumulation per coin: a position
opens when signed size crosses away from zero and closes when it returns to ~0
(or flips sign). closedPnl is summed over the closing fills; entry/exit times
bound the hold. This is the HL analog of the Jupiter cycle assembler.

Keep output keys in sync with the names referenced in
configs/wallet-selection-hl-copyability-vX.Y.Z.json.
"""
import json
import math
import statistics

# Liquid majors we could mirror without moving the book at our clip.
LIQUID_MAJORS = {"BTC", "ETH"}
# Secondary-liquid (acceptable but not "majors"): large caps with deep HL books.
SECONDARY_LIQUID = {"SOL", "HYPE"}

# Copy-tax model (from PERP_FOLLOW_STUDY_V2): the tax is spread+fee+funding on
# entries with near-zero directional EV. v2 measured -0.15%/trade even at zero
# latency w/ exact fill px. We model the per-side friction a copier actually pays.
TAKER_FEE_BPS = 4.5          # HL taker ~4.5 bps (pre-rebate)
SLIPPAGE_BPS_PER_SIDE = 3.0  # v2 used 3 bp/side micro-drift slippage


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


def _signed_sz(f):
    sz = float(f["sz"])
    return sz if f["side"] == "B" else -sz


def assemble_round_trips(fills):
    """Reconstruct round-trips per coin via signed-size accumulation.

    Returns list of round-trip dicts: coin, entry_time, exit_time, hold_secs,
    peak_notional, entry_notional, adds (opens after the first), closed_pnl,
    total_fee, liquidated.
    """
    fills = sorted(fills, key=lambda f: f["time"])
    by_coin = {}
    for f in fills:
        by_coin.setdefault(f["coin"], []).append(f)

    trips = []
    EPS = 1e-9
    for coin, cf in by_coin.items():
        pos = 0.0          # signed position size before this fill
        cur = None         # current open round-trip accumulator
        for f in cf:
            ssz = _signed_sz(f)
            px = float(f["px"])
            fee = float(f.get("fee") or 0.0)
            cpnl = float(f.get("closedPnl") or 0.0)
            is_liq = "Liquidat" in (f.get("dir") or "") or "Deleverag" in (f.get("dir") or "")

            if cur is None:
                # opening a fresh round-trip from flat
                cur = {
                    "coin": coin,
                    "entry_time": f["time"],
                    "exit_time": f["time"],
                    "entry_notional": abs(ssz) * px,
                    "peak_notional": abs(pos + ssz) * px,
                    "adds": 0,
                    "closed_pnl": cpnl,
                    "total_fee": fee,
                    "liquidated": is_liq,
                }
                pos = pos + ssz
            else:
                # is this fill increasing |pos| (an add) or reducing it (toward close)?
                increasing = (pos > 0 and ssz > 0) or (pos < 0 and ssz < 0)
                new_pos = pos + ssz
                cur["exit_time"] = f["time"]
                cur["total_fee"] += fee
                cur["closed_pnl"] += cpnl
                cur["peak_notional"] = max(cur["peak_notional"], abs(new_pos) * px)
                if is_liq:
                    cur["liquidated"] = True
                if increasing:
                    cur["adds"] += 1
                pos = new_pos

            # closed flat -> finalize round-trip
            if abs(pos) < EPS:
                cur["exit_time"] = f["time"]
                cur["hold_secs"] = (cur["exit_time"] - cur["entry_time"]) / 1000.0
                trips.append(cur)
                cur = None
                pos = 0.0
            # sign flip in a single fill (e.g. "Long > Short"): close old, open residual
            elif cur is not None and ((pos > 0) != ((pos - ssz) > 0)) and (pos - ssz) != 0:
                cur["exit_time"] = f["time"]
                cur["hold_secs"] = (cur["exit_time"] - cur["entry_time"]) / 1000.0
                trips.append(cur)
                cur = {
                    "coin": coin,
                    "entry_time": f["time"],
                    "exit_time": f["time"],
                    "entry_notional": abs(pos) * px,
                    "peak_notional": abs(pos) * px,
                    "adds": 0,
                    "closed_pnl": 0.0,
                    "total_fee": 0.0,
                    "liquidated": is_liq,
                }

        # leftover open position = a live (unrealized) round-trip
        if cur is not None and abs(pos) > EPS:
            cur["exit_time"] = cf[-1]["time"]
            cur["hold_secs"] = (cur["exit_time"] - cur["entry_time"]) / 1000.0
            cur["open"] = True
            trips.append(cur)
    return trips


def extract_metrics(fills, subperiod_count=4):
    if not fills:
        return {"scorable": False, "reason": "no_fills"}

    trips = assemble_round_trips(fills)
    closed = [t for t in trips if not t.get("open")]
    openc = [t for t in trips if t.get("open")]
    n = len(closed)
    if n == 0:
        return {"scorable": False, "reason": "no_closed_round_trips",
                "nOpenRoundTrips": len(openc)}

    # ---- asset mix (liquid-majors share by notional) ----
    notional_by_coin = {}
    for t in trips:
        notional_by_coin[t["coin"]] = notional_by_coin.get(t["coin"], 0.0) + t["peak_notional"]
    total_notional = sum(notional_by_coin.values()) or 1.0
    majors_notional = sum(v for c, v in notional_by_coin.items() if c in LIQUID_MAJORS)
    secondary_notional = sum(v for c, v in notional_by_coin.items() if c in SECONDARY_LIQUID)
    majors_share = majors_notional / total_notional
    liquid_share = (majors_notional + secondary_notional) / total_notional
    distinct_coins = len(notional_by_coin)

    # ---- hold times ----
    holds = [t["hold_secs"] for t in closed if t.get("hold_secs") is not None]
    median_hold_secs = statistics.median(holds) if holds else 0.0
    median_hold_hours = median_hold_secs / 3600.0
    sub_minute_frac = (sum(1 for h in holds if h < 60) / len(holds)) if holds else 1.0
    sub_5min_frac = (sum(1 for h in holds if h < 300) / len(holds)) if holds else 1.0

    # ---- add depth & reserve requirement ----
    adds = [t["adds"] for t in closed]
    max_add_depth = max(adds) if adds else 0
    median_add_depth = statistics.median(adds) if adds else 0
    # Raw peak/first-fill multiple is INFORMATIONAL ONLY: HL traders open with a
    # tiny probe then scale to size, so this runs to hundreds even for clean
    # operators (a $650 probe -> $360k position is a normal scale-in, not a
    # martingale). Keep it for context but do NOT grade on it.
    coll_mults = [
        (t["peak_notional"] / t["entry_notional"])
        for t in closed if t["entry_notional"] > 0
    ]
    max_coll_mult = max(coll_mults) if coll_mults else 1.0

    # ---- position size vs market depth ----
    peak_notionals = [t["peak_notional"] for t in closed]
    median_peak_notional = statistics.median(peak_notionals) if peak_notionals else 0.0
    p95_peak_notional = _q(peak_notionals, 0.95)
    max_peak_notional = max(peak_notionals) if peak_notionals else 0.0

    # RESERVE / ESCALATION signal a copier actually cares about: how far the
    # WORST trip's peak blows past the TYPICAL trip's peak. This is the idle
    # capital (x normal position) you must hold to survive the deepest stack.
    # Robust because it compares position-to-position, not probe-to-position.
    peak_dispersion = (max_peak_notional / median_peak_notional) if median_peak_notional > 0 else 1.0
    reserve_multiple = peak_dispersion

    # ---- gross performance ----
    pnls = [t["closed_pnl"] for t in closed]
    wins = [p for p in pnls if p > 0]
    losses = [p for p in pnls if p <= 0]
    gross_win = sum(wins)
    gross_loss = -sum(losses)
    pf = (gross_win / gross_loss) if gross_loss > 0 else (float("inf") if gross_win > 0 else 0.0)
    win_rate = len(wins) / n
    agg_pnl = sum(pnls)
    median_win = statistics.median(wins) if wins else 0.0
    worst_loss = -min(pnls) if pnls else 0.0
    worst_loss_vs_median_win = (worst_loss / median_win) if median_win > 0 else (
        float("inf") if worst_loss > 0 else 0.0)

    # ---- NET-OF-COPY-COST return (the philosophy's core metric) ----
    # Per round-trip a copier pays taker fee + slippage on BOTH sides of the
    # mirrored notional. Funding is already embedded in HL closedPnl for the
    # leader; a same-direction copier pays the same funding sign, so closedPnl
    # is a fair proxy for the directional+funding component. We subtract the
    # copier's own entry/exit friction on peak notional.
    per_side_cost_frac = (TAKER_FEE_BPS + SLIPPAGE_BPS_PER_SIDE) / 10000.0
    net_pnls = []
    net_ret_on_notional = []
    for t in closed:
        copy_cost = 2.0 * per_side_cost_frac * t["peak_notional"]
        net = t["closed_pnl"] - copy_cost
        net_pnls.append(net)
        if t["peak_notional"] > 0:
            net_ret_on_notional.append(net / t["peak_notional"])
    agg_net_pnl = sum(net_pnls)
    median_net_ret_per_trade = statistics.median(net_ret_on_notional) if net_ret_on_notional else 0.0
    mean_net_ret_per_trade = (sum(net_ret_on_notional) / len(net_ret_on_notional)) if net_ret_on_notional else 0.0
    net_win_frac = (sum(1 for x in net_pnls if x > 0) / len(net_pnls)) if net_pnls else 0.0

    # ---- liquidations ----
    liqs = sum(1 for t in trips if t.get("liquidated"))

    # ---- consistency across sub-periods (net of cost) ----
    times = sorted(t["exit_time"] for t in closed)
    t0, t1 = times[0], times[-1]
    positive_subperiods = 0
    profit_concentration = 1.0
    if t1 > t0 and subperiod_count > 0:
        span = (t1 - t0) / subperiod_count
        bucket = [0.0] * subperiod_count
        for t, npnl in zip(closed, net_pnls):
            idx = min(subperiod_count - 1, int((t["exit_time"] - t0) / span)) if span > 0 else 0
            bucket[idx] += npnl
        positive_subperiods = sum(1 for b in bucket if b > 0)
        total_pos = sum(b for b in bucket if b > 0)
        if total_pos > 0:
            profit_concentration = max(b for b in bucket) / total_pos
    else:
        positive_subperiods = 1 if agg_net_pnl > 0 else 0

    active_days = (t1 - t0) / 86400000.0 if t1 > t0 else 0.0

    # ---- open-position guard (live deep stack / underwater) ----
    worst_open = None
    open_peak_vs_median_peak = 0.0
    if openc:
        worst_open = max(openc, key=lambda t: t["peak_notional"])
        if median_peak_notional > 0:
            open_peak_vs_median_peak = worst_open["peak_notional"] / median_peak_notional

    return {
        "scorable": True,
        "nClosedRoundTrips": n,
        "nOpenRoundTrips": len(openc),
        "activeDays": round(active_days, 1),
        "nFills": len(fills),

        # asset mix
        "majorsShare": round(majors_share, 4),
        "liquidShare": round(liquid_share, 4),
        "distinctCoins": distinct_coins,
        "topCoins": sorted(notional_by_coin, key=notional_by_coin.get, reverse=True)[:5],

        # hold time
        "medianHoldHours": round(median_hold_hours, 3),
        "medianHoldSecs": round(median_hold_secs, 1),
        "subMinuteFrac": round(sub_minute_frac, 4),
        "sub5MinFrac": round(sub_5min_frac, 4),

        # add depth / reserve
        "maxAddDepth": max_add_depth,
        "medianAddDepth": median_add_depth,
        "reserveMultiple": round(reserve_multiple, 2),
        "peakDispersion": round(peak_dispersion, 2),
        "maxCollateralMultipleInfo": round(max_coll_mult, 2),

        # position size vs depth
        "medianPeakNotionalUsd": round(median_peak_notional, 0),
        "p95PeakNotionalUsd": round(p95_peak_notional, 0),
        "maxPeakNotionalUsd": round(max_peak_notional, 0),

        # net-of-cost performance (CORE)
        "aggregateNetPnlUsd": round(agg_net_pnl, 2),
        "aggregateGrossPnlUsd": round(agg_pnl, 2),
        "medianNetRetPerTrade": round(median_net_ret_per_trade, 5),
        "meanNetRetPerTrade": round(mean_net_ret_per_trade, 5),
        "netWinFrac": round(net_win_frac, 4),

        # gross / tail
        "winRate": round(win_rate, 4),
        "profitFactor": (round(pf, 3) if pf != float("inf") else None),
        "worstLossVsMedianWin": (round(worst_loss_vs_median_win, 2)
                                 if worst_loss_vs_median_win != float("inf") else 999999.0),
        "liquidations": liqs,

        # consistency
        "positiveSubPeriodFraction": round(positive_subperiods / subperiod_count, 3) if subperiod_count else 0.0,
        "profitConcentration": round(profit_concentration, 3),

        # open guard
        "openPeakVsMedianPeak": round(open_peak_vs_median_peak, 2),
        "worstOpen": ({
            "coin": worst_open["coin"],
            "peakNotionalUsd": round(worst_open["peak_notional"], 0),
            "adds": worst_open["adds"],
        } if worst_open else None),
    }


if __name__ == "__main__":
    import sys
    fills = json.load(open(sys.argv[1]))
    print(json.dumps(extract_metrics(fills), indent=2))
