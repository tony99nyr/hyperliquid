#!/usr/bin/env python3
"""Apply the SURVIVOR / TAIL-SAFETY config to the cached Hyperliquid population.

Reads:
  data/backups/hyperliquid-study/{persistent-set.json, universe.json, portfolios.jsonl, fills/*.json}
  scripts/analysis/wallet-rating/configs/wallet-selection-hl-survivor-v0.1.0.json

Computes per-account:
  - round-trip stats from fills (closedPnl by coin): winRate, profitFactor,
    worstLossVsMedianWin, stopRate, maxAdverseExcursion-proxy, liquidation inference
  - equity drawdown from portfolio accountValueHistory (allTime window):
    maxDrawdownFromPeakPct, longestDrawdownDays, currentDrawdownFromPeak
  - persistence diagnostics passthrough: sharpeAnnual, studyPeriodReturn,
    best5StepsShare, positiveWindowFraction

Then grades A-F per category + overall with auto-disqualifiers, and prints a shortlist.
"""
import json
import os
import statistics
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
HL = os.path.join(ROOT, "data", "backups", "hyperliquid-study")
CONFIG_DIR = os.path.join(ROOT, "scripts", "analysis", "wallet-rating", "configs")


def active_config_path(philosophy, default_file):
    """Resolve the live config file from configs/manifest.json (activeByPhilosophy)."""
    try:
        manifest = json.load(open(os.path.join(CONFIG_DIR, "manifest.json")))
        fname = (manifest.get("activeByPhilosophy") or {}).get(philosophy)
        if fname:
            return os.path.join(CONFIG_DIR, fname)
    except (OSError, ValueError):
        pass
    return os.path.join(CONFIG_DIR, default_file)


CFG = active_config_path("survivor", "wallet-selection-hl-survivor-v0.1.0.json")

cfg = json.load(open(CFG))
rd = cfg["riskDiscipline"]
perf = cfg["performance"]

GRADE_VAL = {"A": 4, "B": 3, "C": 2, "D": 1, "F": 0}
VAL_GRADE = {4: "A", 3: "B", 2: "C", 1: "D", 0: "F"}


def grade_lower_better(val, t):
    """Thresholds where SMALLER is better (drawdown, worst-loss, etc.)."""
    if val is None:
        return None
    if val <= t["gradeA"]:
        return 4
    if val <= t["gradeB"]:
        return 3
    if val <= t["gradeC"]:
        return 2
    if val <= t["gradeD"]:
        return 1
    return 0


def grade_higher_better(val, t, keyA="gradeA", keyB="gradeB", keyC="gradeC", keyD="gradeD"):
    """Thresholds where LARGER is better (stopRate, sharpe)."""
    if val is None:
        return None
    if val >= t[keyA]:
        return 4
    if val >= t[keyB]:
        return 3
    if val >= t[keyC]:
        return 2
    if val >= t[keyD]:
        return 1
    return 0


# -------------------- round-trip stats from fills --------------------
def round_trip_stats(fills):
    """Each fill with a nonzero closedPnl is a (partial) realized close.
    We treat each realized close as a round-trip unit (HL reports closedPnl
    per closing fill, net of that fill's share). Aggregate per closing event."""
    closes = []
    liquidation = False
    for f in fills:
        d = f.get("dir", "") or ""
        if "Liquidat" in d:
            liquidation = True
        cp = f.get("closedPnl")
        if cp is None:
            continue
        try:
            pnl = float(cp)
            fee = float(f.get("fee", 0) or 0)
        except (TypeError, ValueError):
            continue
        # Only count fills that actually close exposure (have realized pnl context).
        if "Close" in d or "Liquidat" in d:
            closes.append(pnl - fee)
    if len(closes) < 1:
        return None

    wins = [p for p in closes if p > 0]
    losses = [p for p in closes if p < 0]
    n = len(closes)
    win_rate = len(wins) / n if n else 0.0

    gross_win = sum(wins)
    gross_loss = -sum(losses)
    pf = (gross_win / gross_loss) if gross_loss > 0 else (float("inf") if gross_win > 0 else 0.0)

    med_win = statistics.median(wins) if wins else 0.0
    worst_loss = -min(losses) if losses else 0.0  # positive magnitude
    worst_vs_med_win = (worst_loss / med_win) if med_win > 0 else (float("inf") if worst_loss > 0 else 0.0)

    # stopRate proxy: of losing round-trips, share whose loss magnitude is
    # within 2x the median win => a CONTAINED (cut) loss, not a warehoused dump.
    if losses and med_win > 0:
        contained = sum(1 for p in losses if (-p) <= 2.0 * med_win)
        stop_rate = contained / len(losses)
    elif losses:
        stop_rate = 0.0
    else:
        stop_rate = 1.0  # no losses observed — treat as fully contained (rare)

    return {
        "nRoundTrips": n,
        "roundTripWinRate": round(win_rate, 4),
        "profitFactor": (round(pf, 3) if pf != float("inf") else None),
        "medianWinUsd": round(med_win, 2),
        "worstLossUsd": round(worst_loss, 2),
        "worstLossVsMedianWin": (round(worst_vs_med_win, 2)
                                 if worst_vs_med_win != float("inf") else 999999.0),
        "stopRate": round(stop_rate, 4),
        "liquidation": liquidation,
        "grossWin": round(gross_win, 2),
        "grossLoss": round(gross_loss, 2),
    }


# -------------------- equity drawdown from portfolio --------------------
def equity_drawdown(avh):
    """avh = accountValueHistory: list of [ms, "value"]. Returns max DD from peak,
    longest underwater stretch (days), current DD from peak. Note: this includes
    deposit/withdraw noise (no flow data in cache) — a known limitation, flagged."""
    pts = []
    for t, v in avh:
        try:
            pts.append((int(t), float(v)))
        except (TypeError, ValueError):
            continue
    if len(pts) < 3:
        return None
    pts.sort()
    peak = pts[0][1]
    peak_t = pts[0][0]
    max_dd = 0.0
    longest_uw_ms = 0
    cur_uw_start = None
    for t, v in pts:
        if v >= peak:
            peak = v
            peak_t = t
            if cur_uw_start is not None:
                longest_uw_ms = max(longest_uw_ms, t - cur_uw_start)
                cur_uw_start = None
        else:
            dd = (peak - v) / peak if peak > 0 else 0.0
            max_dd = max(max_dd, dd)
            if cur_uw_start is None:
                cur_uw_start = peak_t
    if cur_uw_start is not None:
        longest_uw_ms = max(longest_uw_ms, pts[-1][0] - cur_uw_start)

    last_v = pts[-1][1]
    running_peak = max(v for _, v in pts)
    cur_dd = (running_peak - last_v) / running_peak if running_peak > 0 else 0.0

    return {
        "maxDrawdownFromPeakPct": round(max_dd, 4),
        "longestDrawdownDays": round(longest_uw_ms / 86400000.0, 1),
        "currentDrawdownFromPeakPct": round(cur_dd, 4),
        "spanDays": round((pts[-1][0] - pts[0][0]) / 86400000.0, 1),
    }


# -------------------- load data --------------------
pset = json.load(open(os.path.join(HL, "persistent-set.json")))
diag = {d["address"]: d for d in pset["diagnostics"]}

portfolios = {}
with open(os.path.join(HL, "portfolios.jsonl")) as fh:
    for line in fh:
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        portfolios[rec["address"]] = {w: payload for w, payload in rec["data"]}

fills_dir = os.path.join(HL, "fills")
fill_addrs = {f.replace(".json", "") for f in os.listdir(fills_dir) if f.endswith(".json")}


def best_avh(addr):
    p = portfolios.get(addr)
    if not p:
        return None
    for w in ("allTime", "perpAllTime", "month", "perpMonth"):
        if w in p and p[w].get("accountValueHistory"):
            return p[w]["accountValueHistory"]
    return None


# -------------------- score one account --------------------
def score(addr):
    d = diag.get(addr, {})
    flags = []
    breached = []

    rt = None
    if addr in fill_addrs:
        try:
            fills = json.load(open(os.path.join(fills_dir, addr + ".json")))
            rt = round_trip_stats(fills)
        except (json.JSONDecodeError, OSError):
            rt = None

    avh = best_avh(addr)
    eq = equity_drawdown(avh) if avh else None

    sharpe = d.get("sharpeAnnual")
    study_ret = d.get("studyPeriodReturn")
    max_dd_frac = d.get("maxDrawdownFrac")
    best5 = d.get("best5StepsShare")
    wr = [r for r in (d.get("windowReturns") or []) if r is not None]
    pos_win_frac = (sum(1 for r in wr if r > 0) / len(wr)) if wr else None
    age = d.get("accountAgeDays")
    avgval = d.get("avgAccountValue")

    provisional = rt is None

    # ---- gather metric values ----
    maxdd = eq["maxDrawdownFromPeakPct"] if eq else None
    longest_uw = eq["longestDrawdownDays"] if eq else None
    cur_dd = eq["currentDrawdownFromPeakPct"] if eq else None
    wl_vs_mw = rt["worstLossVsMedianWin"] if rt else None
    stop_rate = rt["stopRate"] if rt else None
    win_rate = rt["roundTripWinRate"] if rt else None
    pf = rt["profitFactor"] if rt else None
    liq = (rt["liquidation"] if rt else False)

    # ---- category: capitalPreservation ----
    # PRIMARY = study return-based maxDrawdownFrac (flow-clean). raw-equity DD is soft.
    cp_grades = []
    g = grade_lower_better(max_dd_frac, rd["maxDrawdownFrac"])
    if g is not None:
        cp_grades.append(g)
        cp_grades.append(g)  # double-weight the trustworthy primary signal
    g = grade_lower_better(maxdd, rd["rawEquityDrawdownFromPeakPct"]); cp_grades += [g] if g is not None else []
    g = grade_lower_better(longest_uw, rd["longestDrawdownDays"]); cp_grades += [g] if g is not None else []
    if maxdd is not None and maxdd > rd["rawEquityDrawdownFromPeakPct"]["softFlagAbove"]:
        flags.append("DEEP_DRAWDOWN")
    cap_pres = round(statistics.mean(cp_grades), 2) if cp_grades else None

    # ---- category: tailSafety ----
    ts_grades = []
    # liquidations
    ts_grades.append(4 if not liq else 0)
    g = grade_lower_better(wl_vs_mw, rd["worstLossVsMedianWin"]); ts_grades += [g] if g is not None else []
    g = grade_higher_better(stop_rate, rd["stopRate"]);          ts_grades += [g] if g is not None else []
    flag_th = cfg["ratingRubric"].get("flagThresholds", {})
    if wl_vs_mw is not None and wl_vs_mw > flag_th.get("worstLossFlagAbove", rd["worstLossVsMedianWin"]["gradeC"]):
        flags.append("FAT_WORST_LOSS")
    if stop_rate is not None and stop_rate <= flag_th.get("rideOrLiquidateStopRateAtOrBelow", 0.05):
        flags.append("RIDE_OR_LIQUIDATE")
    if stop_rate == 0:
        flags.append("NO_STOPS")
    tail = round(statistics.mean(ts_grades), 2) if ts_grades else None

    # ---- category: stability ----
    st_grades = []
    g = grade_higher_better(sharpe, rd["sharpeFloor"]); st_grades += [g] if g is not None else []
    g = grade_lower_better(best5, perf["maxBest5StepsShare"]); st_grades += [g] if g is not None else []
    stability = round(statistics.mean(st_grades), 2) if st_grades else None

    # ---- category: profitability ----
    pr_grades = []
    pfb = perf.get("profitFactorBands", {"gradeA": 2.0, "gradeB": 1.5})
    srb = perf.get("studyPeriodReturnBands", {"gradeA": 2.0, "gradeB": 1.0, "gradeC": 0.3, "gradeD": 0.0})
    if pf is not None:
        pr_grades.append(4 if pf >= pfb["gradeA"] else 3 if pf >= pfb["gradeB"]
                         else 2 if pf >= perf["minProfitFactor"] else 0)
    if study_ret is not None:
        pr_grades.append(4 if study_ret >= srb["gradeA"] else 3 if study_ret >= srb["gradeB"]
                         else 2 if study_ret >= srb["gradeC"] else 1 if study_ret >= srb["gradeD"] else 0)
    # win rate scored as bounded: penalize extreme
    if win_rate is not None:
        if win_rate > perf["roundTripWinRate"]["suspiciousAbove"]:
            pr_grades.append(1)  # penalty
            flags.append("EXTREME_WIN_RATE")
        elif win_rate < perf["roundTripWinRate"]["floor"]:
            pr_grades.append(1)
        else:
            pr_grades.append(3)
    profitability = round(statistics.mean(pr_grades), 2) if pr_grades else None

    # ---- category: consistency ----
    cons = None
    if pos_win_frac is not None:
        cc = cfg["ratingRubric"]["consistency"]
        cons = (4 if pos_win_frac >= cc["gradeA_positiveFraction"]
                else 3 if pos_win_frac >= cc["gradeB"]
                else 2 if pos_win_frac >= cc["gradeC"]
                else 1 if pos_win_frac >= cc["gradeD"] else 0)

    if liq:
        flags.append("LIQUIDATED")
    if provisional:
        flags.append("PROVISIONAL_NO_FILLS")

    # ---- soft flags ----
    if cur_dd is not None and cur_dd > rd["openExposureGuard"]["softFlagCurrentDrawdownFromPeakPct"]:
        flags.append("LIVE_UNDERWATER")

    # ---- auto-disqualifiers (thresholds from config; JSON is source of truth) ----
    dqt = cfg["ratingRubric"]["autoDisqualifiers"].get("thresholds", {})
    dq_maxdd = dqt.get("maxDrawdownFracAbove", rd["maxDrawdownFrac"]["hardReject"])
    dq_worst = dqt.get("worstLossVsMedianWinAbove", rd["worstLossVsMedianWin"]["hardReject"])
    dq_nostop_worst = dqt.get("noStopWorstLossAbove", 8)
    dq_extreme_wr = dqt.get("extremeWinRateAbove", 0.95)
    dq_sharpe = dqt.get("sharpeAnnualBelow", rd["sharpeFloor"]["hardRejectBelow"])
    if liq:
        breached.append("liquidations > 0")
    if max_dd_frac is not None and max_dd_frac > dq_maxdd:
        breached.append(f"maxDrawdownFrac > {dq_maxdd}")
    if wl_vs_mw is not None and wl_vs_mw > dq_worst:
        breached.append(f"worstLossVsMedianWin > {dq_worst}")
    if stop_rate == 0 and wl_vs_mw is not None and wl_vs_mw > dq_nostop_worst:
        breached.append(f"stopRate == 0 AND worstLossVsMedianWin > {dq_nostop_worst}")
    if win_rate is not None and win_rate > dq_extreme_wr and stop_rate == 0:
        breached.append(f"roundTripWinRate > {dq_extreme_wr} AND stopRate == 0")
    if sharpe is not None and sharpe < dq_sharpe:
        breached.append(f"sharpeAnnual < {dq_sharpe}")

    # ---- overall weighted ----
    cats = {
        "capitalPreservation": cap_pres,
        "tailSafety": tail,
        "stability": stability,
        "profitability": profitability,
        "consistency": cons,
    }
    weights = {k: v["weight"] for k, v in cfg["ratingRubric"]["categories"].items()}
    num = 0.0
    den = 0.0
    for k, gv in cats.items():
        if gv is not None:
            num += gv * weights[k]
            den += weights[k]
    overall_val = (num / den) if den > 0 else 0.0

    disqualified = len(breached) > 0
    if disqualified:
        overall_val = 0.0

    # provisional cap at B (3.0)
    if provisional and not disqualified:
        overall_val = min(overall_val, 3.0)

    bands = cfg["overall"]["gradeBands"]
    if disqualified:
        letter = "F"
    elif overall_val >= bands["A"]:
        letter = "A"
    elif overall_val >= bands["B"]:
        letter = "B"
    elif overall_val >= bands["C"]:
        letter = "C"
    elif overall_val >= bands["D"]:
        letter = "D"
    else:
        letter = "F"

    score10 = round(overall_val / 4.0 * 10, 1)

    return {
        "address": addr,
        "overallGrade": letter,
        "overallScore": round(overall_val, 2),
        "score10": score10,
        "disqualified": disqualified,
        "breached": sorted(set(breached)),
        "flags": sorted(set(flags)),
        "provisional": provisional,
        "categories": cats,
        "metrics": {
            "maxDrawdownFrac": max_dd_frac,
            "rawEquityDrawdownFromPeakPct": maxdd,
            "longestDrawdownDays": longest_uw,
            "currentDrawdownFromPeakPct": cur_dd,
            "roundTripWinRate": win_rate,
            "profitFactor": pf,
            "worstLossVsMedianWin": wl_vs_mw,
            "stopRate": stop_rate,
            "nRoundTrips": (rt["nRoundTrips"] if rt else None),
            "sharpeAnnual": sharpe,
            "studyPeriodReturn": study_ret,
            "best5StepsShare": best5,
            "positiveWindowFraction": (round(pos_win_frac, 3) if pos_win_frac is not None else None),
            "avgAccountValue": (round(avgval) if avgval else None),
            "accountAgeDays": (round(age) if age else None),
        },
    }


# -------------------- run over persistent set (the scorable population) --------------------
results = [score(a) for a in diag.keys()]

# eligibility: persistent set already passes age/windows; require min round trips
# for FULL grade, but keep provisional ones flagged.
elig = cfg["eligibility"]
eligible = []
for r in results:
    nrt = r["metrics"]["nRoundTrips"]
    age = r["metrics"]["accountAgeDays"] or 0
    if age < elig["minAccountAgeDays"]:
        continue
    if (not r["provisional"]) and (nrt or 0) < elig["minRoundTrips"]:
        # has fills but too few round-trips
        continue
    eligible.append(r)

survivors = [r for r in eligible if not r["disqualified"] and r["overallGrade"] in ("A", "B", "C")]
survivors.sort(key=lambda r: r["overallScore"], reverse=True)

print("=" * 78)
print("SURVIVOR / TAIL-SAFETY — HL scoring")
print("=" * 78)
print(f"Universe size (cached):            2437 accounts")
print(f"Persistent set (scorable):         {len(diag)}")
print(f"  of which have cached fills:       {len(fill_addrs)}")
print(f"Eligible after age/round-trip cut:  {len(eligible)}")
print(f"Disqualified:                       {sum(1 for r in eligible if r['disqualified'])}")
print(f"Survive filter (grade C or better): {len(survivors)}")
print()
grade_counts = defaultdict(int)
for r in eligible:
    grade_counts[r["overallGrade"]] += 1
print("Grade distribution (eligible):", dict(sorted(grade_counts.items())))
print()

print("SHORTLIST (top by overall score, grade C+):")
print("-" * 78)
for i, r in enumerate(survivors[:15], 1):
    m = r["metrics"]
    print(f"{i:2}. {r['address']}  {r['overallGrade']} ({r['score10']}/10)"
          + ("  [PROVISIONAL]" if r["provisional"] else ""))
    print(f"     maxDDfrac={m['maxDrawdownFrac']}  worstLoss/medWin={m['worstLossVsMedianWin']}"
          f"  winRate={m['roundTripWinRate']}  stopRate={m['stopRate']}")
    print(f"     sharpe={m['sharpeAnnual']}  studyRet={m['studyPeriodReturn']}  "
          f"nRT={m['nRoundTrips']}  avgVal=${m['avgAccountValue']}")
    if r["flags"]:
        print(f"     flags: {', '.join(r['flags'])}")
print()

# dump full results json next to script for the lead
out = os.path.join(os.path.dirname(CFG), "..", "hl-survivor-results.json")
json.dump({"config": cfg["name"], "version": cfg["version"],
           "summary": {
               "universe": 2437, "persistentSet": len(diag),
               "withFills": len(fill_addrs), "eligible": len(eligible),
               "disqualified": sum(1 for r in eligible if r["disqualified"]),
               "survivors": len(survivors)},
           "results": sorted(results, key=lambda r: r["overallScore"], reverse=True)},
          open(out, "w"), indent=2)
print(f"Full results -> {os.path.abspath(out)}")
