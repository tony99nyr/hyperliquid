#!/usr/bin/env python3
"""Apply the COPYABILITY-AT-SCALE config to the cached HL universe -> shortlist.

Reads the config, computes copyability metrics from each cached fills file,
grades each wallet per category, applies disqualifiers + vault bonus, and prints
a ranked shortlist. Pure-stdlib, offline, reproducible from data/backups.
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from hl_copyability_metrics import extract_metrics  # noqa: E402

ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
HL = os.path.join(ROOT, "data", "backups", "hyperliquid-study")
CONFIG_DIR = os.path.join(HERE, "configs")


def active_config_path():
    """Resolve the live copyability config file from configs/manifest.json
    (activeByPhilosophy.copyability), so the JSON manifest selects the version.
    Falls back to the latest copyability file if the manifest lacks the entry."""
    manifest = json.load(open(os.path.join(CONFIG_DIR, "manifest.json")))
    fname = (manifest.get("activeByPhilosophy") or {}).get("copyability")
    if not fname:
        cands = sorted(f for f in os.listdir(CONFIG_DIR)
                       if f.startswith("wallet-selection-hl-copyability-"))
        fname = cands[-1] if cands else "wallet-selection-hl-copyability-v0.1.0.json"
    return os.path.join(CONFIG_DIR, fname)


CFG = active_config_path()


def grade_higher_better(val, A, B, C, D):
    if val >= A: return 4
    if val >= B: return 3
    if val >= C: return 2
    if val >= D: return 1
    return 0


def grade_lower_better(val, A, B, C, D):
    if val <= A: return 4
    if val <= B: return 3
    if val <= C: return 2
    if val <= D: return 1
    return 0


def letter(score10, bands):
    """Map a 0-10 score to a letter using the config's overall.gradeBands."""
    if score10 >= bands["A"]: return "A"
    if score10 >= bands["B"]: return "B"
    if score10 >= bands["C"]: return "C"
    if score10 >= bands["D"]: return "D"
    return "F"


def rate(m, cfg):
    cop = cfg["copyability"]
    # Flag + disqualifier thresholds are config-driven (the JSON is the single
    # source of truth). flagThresholds/disqualifier thresholds were added in
    # copyability v0.1.1; fall back to the v0.1.0 hardcodes if absent so the
    # scorer still runs against an older config file.
    ft = cfg["ratingRubric"].get("flagThresholds", {})
    dqt = cfg["ratingRubric"]["autoDisqualifiers"].get("thresholds", {})
    bands = cfg["overall"]["gradeBands"]
    flags = []
    dq = []

    # ---- asset mix ----
    am = cop["assetMix"]
    g_assetmix = grade_higher_better(m["majorsShare"], am["gradeA"], am["gradeB"], am["gradeC"], am["gradeD"])
    if m["liquidShare"] < am["secondaryFloor"]:
        g_assetmix = max(0, g_assetmix - 1)
    if m["majorsShare"] < ft.get("thinAltMajorsShareBelow", 0.40):
        flags.append("THIN_ALT_TRADER")

    # ---- hold time ----
    ht = cop["holdTime"]
    g_hold = grade_higher_better(m["medianHoldHours"], ht["gradeA"], ht["gradeB"], ht["gradeC"], ht["gradeD"])
    if m["subMinuteFrac"] > ht["subMinuteFracMaxForA"]:
        g_hold = min(g_hold, 3)
    if m["subMinuteFrac"] >= ft.get("subMinuteScalperFracAtOrAbove", 0.20):
        flags.append("SUB_MINUTE_SCALPER")

    # ---- net of cost return ----
    nc = cop["netOfCostReturn"]
    g_net = grade_higher_better(m["meanNetRetPerTrade"], nc["gradeA"], nc["gradeB"], nc["gradeC"], nc["gradeD"])
    if m["netWinFrac"] < nc["netWinFracFloorForC"]:
        g_net = min(g_net, 1)
    if m["aggregateNetPnlUsd"] < nc["minAggregateNetPnlUsd"]:
        g_net = min(g_net, 1)
    if m["meanNetRetPerTrade"] <= ft.get("netNegativeMeanRetAtOrBelow", 0.0):
        flags.append("NET_NEGATIVE_AFTER_COPY_COST")

    # ---- tail safety ----
    ts = cop["tailSafety"]
    wl = ts["worstLossVsMedianWin"]
    g_worst = grade_lower_better(m["worstLossVsMedianWin"], wl["gradeA"], wl["gradeB"], wl["gradeC"], wl["gradeD"])
    lq = ts["liquidations"]
    if m["liquidations"] <= lq["maxForGradeA"]:
        g_liq = 4
    elif m["liquidations"] <= lq["maxForGradeB"]:
        g_liq = 3
    elif m["liquidations"] <= lq["hardRejectAbove"]:
        g_liq = 1
    else:
        g_liq = 0
    og = ts["openPositionGuard"]
    op = m.get("openPeakVsMedianPeak", 0)
    # open guard is flag+dock only in v0.1.0 (noisy on ~3.5d fill retention)
    g_tail = round((g_worst + g_liq) / 2.0)
    if op > og["gradeDockAbove"]:
        g_tail = max(0, g_tail - 1)
    if op > og["flagAbove"]:
        flags.append("LIVE_DEEP_STACK")
    if (m["worstLossVsMedianWin"] > ft.get("blowUpRiskWorstLossVsMedianWinAbove", 20)
            or m["liquidations"] >= ft.get("blowUpRiskLiquidationsAtOrAbove", 2)):
        flags.append("BLOW_UP_RISK")

    # ---- add depth / reserve (reserveMultiple = peak dispersion) ----
    ad = cop["addDepthAndReserve"]
    g_add = grade_lower_better(m["reserveMultiple"], ad["gradeA"], ad["gradeB"], ad["gradeC"], ad["gradeD"])
    if m["reserveMultiple"] > ft.get("deepMartingaleReserveMultipleAbove", 150):
        flags.append("DEEP_MARTINGALE")

    # ---- position size ----
    ps = cop["positionSizeVsDepth"]
    g_size = grade_higher_better(m["medianPeakNotionalUsd"], ps["gradeA"], ps["gradeB"], ps["gradeC"], ps["gradeD"])

    # ---- consistency modifier on net-of-cost ----
    cm = cfg["ratingRubric"]["consistencyModifier"]
    consistency_ok = (m["positiveSubPeriodFraction"] >= cm["fullCreditPositiveFraction"]
                      and m["profitConcentration"] <= cm["maxConcentrationForFullCredit"])
    net_mult = 1.0 if consistency_ok else 0.85

    # category 0-10 scores
    cats = {
        "assetMix": g_assetmix / 4 * 10,
        "holdTime": g_hold / 4 * 10,
        "netOfCostReturn": (g_net / 4 * 10) * net_mult,
        "tailSafety": g_tail / 4 * 10,
        "addDepthReserve": g_add / 4 * 10,
        "positionSize": g_size / 4 * 10,
    }
    weights = {k: v["weight"] for k, v in cfg["ratingRubric"]["categories"].items()}
    overall10 = sum(cats[k] * weights[k] for k in cats)

    # vault bonus (no vault-led wallets in cached persistent set; forward-looking)
    leads_vault = m.get("leadsVault", False)
    if leads_vault:
        overall10 = min(10.0, overall10 + cfg["vaultBonus"]["leadsVaultBonusGradePoints"] / 4 * 10)
        flags.append("VAULT_LED")

    # disqualifiers (thresholds from config; the JSON is the source of truth)
    if m["majorsShare"] < dqt.get("majorsShareBelow", 0.10):
        dq.append(f"majorsShare<{dqt.get('majorsShareBelow', 0.10)}")
    if m["medianHoldHours"] < dqt.get("medianHoldHoursBelow", 0.1):
        dq.append(f"medianHoldHours<{dqt.get('medianHoldHoursBelow', 0.1)}")
    if m["subMinuteFrac"] >= dqt.get("subMinuteFracAtOrAbove", 0.50):
        dq.append(f"subMinuteFrac>={dqt.get('subMinuteFracAtOrAbove', 0.50)}")
    if m["meanNetRetPerTrade"] < dqt.get("meanNetRetPerTradeBelow", -0.01):
        dq.append(f"meanNetRetPerTrade<{dqt.get('meanNetRetPerTradeBelow', -0.01)}")
    if m["reserveMultiple"] > dqt.get("reserveMultipleAbove", 1000):
        dq.append(f"reserveMultiple>{dqt.get('reserveMultipleAbove', 1000)}")
    if m["liquidations"] > dqt.get("liquidationsAbove", 3):
        dq.append(f"liquidations>{dqt.get('liquidationsAbove', 3)}")
    if m["worstLossVsMedianWin"] > dqt.get("worstLossVsMedianWinAbove", 80):
        dq.append(f"worstLossVsMedianWin>{dqt.get('worstLossVsMedianWinAbove', 80)}")
    if m["medianPeakNotionalUsd"] < dqt.get("medianPeakNotionalUsdBelow", 1000):
        dq.append(f"medianPeakNotionalUsd<{dqt.get('medianPeakNotionalUsdBelow', 1000)}")

    if dq:
        overall10 = 0.0
        flags.append("DISQUALIFIED")

    return {
        "overallScore": round(overall10, 2),
        "overallGrade": "F" if dq else letter(overall10, bands),
        "categories": {k: round(v, 1) for k, v in cats.items()},
        "categoryLetters": {
            "assetMix": ["F","D","C","B","A"][g_assetmix],
            "holdTime": ["F","D","C","B","A"][g_hold],
            "netOfCostReturn": ["F","D","C","B","A"][g_net],
            "tailSafety": ["F","D","C","B","A"][g_tail],
            "addDepthReserve": ["F","D","C","B","A"][g_add],
            "positionSize": ["F","D","C","B","A"][g_size],
        },
        "flags": sorted(set(flags)),
        "disqualifiers": dq,
        "leadsVault": leads_vault,
    }


def main():
    cfg = json.load(open(CFG))
    elig = cfg["eligibility"]

    # vault leadership lookup (none in cached persistent set, but wire it up)
    vault_leaders = set()
    vaults = json.load(open(os.path.join(HL, "vaults.json")))
    for v in vaults:
        s = v.get("summary", {})
        if s.get("isClosed"): continue
        leader = (s.get("leader") or "").lower()
        if leader:
            vault_leaders.add(leader)

    pset = json.load(open(os.path.join(HL, "persistent-set.json")))
    pset_addrs = {d["address"].lower() for d in pset["diagnostics"]}

    fdir = os.path.join(HL, "fills")
    results = []
    excluded = {"not_scorable": 0, "ineligible": 0}
    for fn in sorted(os.listdir(fdir)):
        addr = fn.replace(".json", "").lower()
        fills = json.load(open(os.path.join(fdir, fn)))
        m = extract_metrics(fills)
        if not m.get("scorable"):
            excluded["not_scorable"] += 1
            continue
        # eligibility
        if (m["nClosedRoundTrips"] < elig["minClosedRoundTrips"]
                or m["activeDays"] < elig["minActiveDays"]
                or m["liquidShare"] < elig["minLiquidShare"]):
            excluded["ineligible"] += 1
            continue
        m["leadsVault"] = addr in vault_leaders
        r = rate(m, cfg)
        results.append((addr, m, r))

    results.sort(key=lambda x: x[2]["overallScore"], reverse=True)

    n_cached = len(os.listdir(fdir))
    n_pset_cached = sum(1 for fn in os.listdir(fdir) if fn.replace(".json", "").lower() in pset_addrs)
    print(f"=== COPYABILITY-AT-SCALE shortlist (config {cfg['version']}) ===")
    print(f"Cached fills available: {n_cached} wallets ({n_pset_cached} of the 43 persistent set + {n_cached - n_pset_cached} broader-universe; rest of 2,437 universe lacks fills)")
    print(f"Not scorable: {excluded['not_scorable']}  Ineligible: {excluded['ineligible']}  Scored: {len(results)}")
    passed = [r for r in results if r[2]["overallGrade"] in ("A", "B", "C")]
    print(f"Grade C or better (shortlist): {len(passed)}\n")
    print(f"{'addr':10} {'grade':5} {'score':5} {'maj%':5} {'holdH':>9} {'netRet/t':>9} {'reserveX':>9} {'worstL/medW':>11} {'liqs':>4} {'inPSet':>6} {'flags'}")
    for addr, m, r in results:
        print(f"{addr[:10]:10} {r['overallGrade']:5} {r['overallScore']:5} "
              f"{m['majorsShare']:.2f}  {m['medianHoldHours']:9.1f} {m['meanNetRetPerTrade']:+9.3f} "
              f"{m['reserveMultiple']:9.1f} {m['worstLossVsMedianWin']:11.1f} {m['liquidations']:4d} "
              f"{('Y' if addr in pset_addrs else '-'):>6} {','.join(r['flags'])}")

    out = [{"address": addr, "metrics": m, "rating": r} for addr, m, r in results]
    outpath = os.path.join(HL, "copyability-shortlist.json")
    json.dump(out, open(outpath, "w"), indent=2)
    print(f"\nFull JSON -> {outpath}")


if __name__ == "__main__":
    main()
