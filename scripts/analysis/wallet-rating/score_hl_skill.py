#!/usr/bin/env python3
"""Apply the PERSISTENT-SKILL / ANTICIPATION config to the cached Hyperliquid
population and emit a shortlist for MANUAL review.

Self-contained, offline, no deps. Loads:
  data/backups/hyperliquid-study/{windows,persistence-stats,persistent-set,anticipation}.json
applies configs/wallet-selection-hl-skill-v0.1.0.json, prints the shortlist.

Philosophy: surface the rare genuinely-skilled trader (persistent rank +
anticipation + regime-robustness + deflated-Sharpe survival), NOT lottery winners.
Run: python3 scripts/analysis/wallet-rating/score_hl_skill.py
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
# Repo root = HERE/../../.. (HERE is <repo>/scripts/analysis/wallet-rating).
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))
DATA = os.path.join(ROOT, "data", "backups", "hyperliquid-study")
CONFIG_DIR = os.path.join(HERE, "configs")


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


CFG = active_config_path("skill", "wallet-selection-hl-skill-v0.1.0.json")

cfg = json.load(open(CFG))
windows = json.load(open(os.path.join(DATA, "windows.json")))
pset = json.load(open(os.path.join(DATA, "persistent-set.json")))
antic = json.load(open(os.path.join(DATA, "anticipation.json")))

# ---------------------------------------------------------------------------
# 1. Per-window decile cutoffs over the usable cross-section (raw return rank).
#    Forward windows are w1..w5 (indices 1..5). Top decile = top 10% by return.
# ---------------------------------------------------------------------------
usable = [a for a in windows["accounts"] if a["status"] == "usable"]


def pctl(sorted_vals, q):
    if not sorted_vals:
        return None
    k = (len(sorted_vals) - 1) * q
    f = int(k)
    c = min(f + 1, len(sorted_vals) - 1)
    return sorted_vals[f] + (sorted_vals[c] - sorted_vals[f]) * (k - f)


# top-decile cutoff and full sorted list per window (for percentile rank)
win_sorted = {}
top_decile_cut = {}
for w in range(6):
    vals = sorted(a["returns"][w] for a in usable if a["returns"][w] is not None)
    win_sorted[w] = vals
    top_decile_cut[w] = pctl(vals, 0.90) if vals else None


def pct_rank(val, w):
    """Cross-sectional percentile (0..1) of val within window w."""
    vals = win_sorted[w]
    if not vals or val is None:
        return None
    lo = sum(1 for v in vals if v < val)
    return lo / len(vals)


# enrich lookups for the 43 (sharpe, maxDD, concentration, studyReturn) and 20 (anticipation)
pset_by_addr = {d["address"]: d for d in pset["diagnostics"]}
antic_by_addr = {d["address"]: d for d in antic}

# ---------------------------------------------------------------------------
# 2. Metric extraction per account.
# ---------------------------------------------------------------------------
WITHIN_REGIME_FWD = [2, 3, 5]   # window indices reached by within-regime transitions w1->w2,w2->w3,w4->w5
REGIME_BREAK_FWD = [1, 4]       # w1 (post Oct cascade), w4 (Feb-Apr downturn)
FWD_WINDOWS = [1, 2, 3, 4, 5]


def extract(acct):
    addr = acct["address"]
    rets = acct["returns"]

    # topDecileForwardCount: forward windows in the top decile
    tdc = 0
    for w in FWD_WINDOWS:
        if rets[w] is not None and top_decile_cut[w] is not None and rets[w] >= top_decile_cut[w]:
            tdc += 1

    # forwardRankStability: mean cross-sectional percentile over within-regime fwd windows
    wr_pcts = [pct_rank(rets[w], w) for w in WITHIN_REGIME_FWD if rets[w] is not None]
    wr_pcts = [p for p in wr_pcts if p is not None]
    rank_stability = sum(wr_pcts) / len(wr_pcts) if wr_pcts else 0.0

    # regimeBreakSurvival: of the 2 break windows, how many stayed > -0.5
    rb = [rets[w] for w in REGIME_BREAK_FWD if rets[w] is not None]
    regime_break_survival = sum(1 for r in rb if r > -0.5)
    # if a break window is null, treat as "not measured" -> count toward neither survive nor fail,
    # but cap survival at number measured
    regime_break_measured = len(rb)

    worst_window = min(r for r in rets if r is not None)

    # enrich from persistent set (sharpe, maxDD, concentration, studyReturn)
    ps = pset_by_addr.get(addr)
    sharpe = ps["sharpeAnnual"] if ps else None
    max_dd = ps["maxDrawdownFrac"] if ps else None
    concentration = ps["best5StepsShare"] if ps else None
    study_return = ps["studyPeriodReturn"] if ps else None
    study_pnl = ps["studyPeriodPnlUsd"] if ps else None

    # anticipation
    an = antic_by_addr.get(addr)
    label = an["label"] if an else "unmeasured"
    edge24_lo = None
    edge4_lo = None
    meme_share = None
    if an:
        edges = {e["horizonH"]: e for e in an["fills"]["edges"]}
        if edges.get(24) and edges[24]["lo"] is not None:
            edge24_lo = edges[24]["lo"]
        if edges.get(4) and edges[4]["lo"] is not None:
            edge4_lo = edges[4]["lo"]
        # crude meme/new-listing share: fraction of analyzed coins that are meme/new tickers
        coins = an["fills"].get("coinsAnalyzed", [])
        meme_tickers = ("TRUMP", "BERA", "FARTCOIN", "POPCAT", "PENGU", "PUMP", "WLFI",
                        "LAUNCHCOIN", "MET", "VVV", "kPEPE", "kBONK", "MOODENG", "ZEREBRO",
                        "BRETT", "SPX", "AI16Z", "VIRTUAL", "WIF", "MON", "ASTER", "AVNT")
        tot = 0
        meme = 0
        for c in coins:
            # format "TICKER(count)"
            tk = c.split("(")[0]
            try:
                ct = int(c.split("(")[1].rstrip(")"))
            except Exception:
                ct = 1
            tot += ct
            if tk in meme_tickers or tk.startswith("k"):
                meme += ct
        meme_share = (meme / tot) if tot else 0.0

    return {
        "address": addr,
        "addressShort": addr[:8],
        "displayName": acct.get("displayName") or (ps and ps.get("displayName")) or (an and an.get("displayName")),
        "leaderboardTop": acct.get("leaderboardTop", False),
        "inPersistentSet": addr in pset_by_addr,
        "topDecileForwardCount": tdc,
        "forwardRankStability": round(rank_stability, 4),
        "regimeBreakSurvival": regime_break_survival,
        "regimeBreakMeasured": regime_break_measured,
        "worstWindowReturn": round(worst_window, 4),
        "sharpeAnnual": sharpe,
        "maxDrawdownFrac": max_dd,
        "pnlConcentration": concentration,
        "studyPeriodReturn": study_return,
        "studyPeriodPnlUsd": study_pnl,
        "anticipationLabel": label,
        "edge24hLowerCI": edge24_lo,
        "edge4hLowerCI": edge4_lo,
        "memeShare": meme_share,
    }


# ---------------------------------------------------------------------------
# 3. Grading. Letter -> points; threshold dicts use direction-aware mapping.
# ---------------------------------------------------------------------------
LETTERS = ["A", "B", "C", "D", "F"]
PTS = {"A": 4.0, "B": 3.0, "C": 2.0, "D": 1.0, "F": 0.0}


def grade_higher_better(val, th, keys=("gradeA", "gradeB", "gradeC", "gradeD")):
    if val is None:
        return None
    for letter, k in zip("ABCD", keys):
        if val >= th[k]:
            return letter
    return "F"


def grade_lower_better(val, th, keys=("gradeA", "gradeB", "gradeC", "gradeD")):
    if val is None:
        return None
    for letter, k in zip("ABCD", keys):
        if val <= th[k]:
            return letter
    return "F"


def grade_account(m):
    rc = cfg
    badges = []
    dq_rules = []

    # ---- auto-disqualifiers (thresholds from config; JSON is source of truth) ----
    dqt = rc["ratingRubric"]["autoDisqualifiers"].get("thresholds", {})
    dq_sret = dqt.get("studyPeriodReturnBelow", 0)
    dq_maxdd = dqt.get("maxDrawdownFracAbove", 5.0)
    dq_worst = dqt.get("worstWindowReturnBelow", -3.5)
    dq_tdc = dqt.get("topDecileForwardCountBelow", 1)
    dq_lot_sharpe = dqt.get("lotterySharpeBelow", 0.5)
    dq_lot_conc = dqt.get("lotteryConcentrationAbove", 2.5)
    dq_fragile_tdc = dqt.get("fragileTopDecileBelow", 3)
    if m["studyPeriodReturn"] is not None and m["studyPeriodReturn"] < dq_sret:
        dq_rules.append(f"studyPeriodReturn < {dq_sret} (blew up over study year)")
        badges.append("BLEW_UP")
    if m["maxDrawdownFrac"] is not None and m["maxDrawdownFrac"] > dq_maxdd:
        dq_rules.append(f"maxDrawdownFrac > {dq_maxdd}")
        badges.append("BLEW_UP")
    if m["worstWindowReturn"] < dq_worst:
        dq_rules.append(f"worstWindowReturn < {dq_worst}")
        badges.append("REGIME_FRAGILE")
    if m["topDecileForwardCount"] < dq_tdc:
        dq_rules.append(f"topDecileForwardCount < {dq_tdc} (not persistent)")
    if (m["sharpeAnnual"] is not None and m["sharpeAnnual"] < dq_lot_sharpe
            and m["pnlConcentration"] is not None and m["pnlConcentration"] > dq_lot_conc):
        dq_rules.append(f"sharpe < {dq_lot_sharpe} AND concentration > {dq_lot_conc} (lottery profile)")
        badges.append("LOTTERY_PROFILE")
    if m["regimeBreakSurvival"] == 0 and m["regimeBreakMeasured"] >= 1 and m["topDecileForwardCount"] < dq_fragile_tdc:
        dq_rules.append("inverted at both regime breaks AND not deeply persistent")
        badges.append("REGIME_FRAGILE")

    # ---- persistence category ----
    pc = rc["persistenceCore"]
    sw = pc.get("subWeights", {"topDecileForwardCount": 0.65, "forwardRankStability": 0.35})
    g_tdc = grade_higher_better(m["topDecileForwardCount"], pc["topDecileForwardCount"])
    g_stab = grade_higher_better(m["forwardRankStability"], pc["forwardRankStability"])
    persistence_pts = (PTS[g_tdc] * sw["topDecileForwardCount"] + PTS[g_stab] * sw["forwardRankStability"])
    if m["inPersistentSet"]:
        badges.append("PERSISTENT_SET")
        membership_bonus = pc.get("persistentSetMembership", {}).get("membershipBonusGradePoints", 0.25)
        persistence_pts = min(4.0, persistence_pts + membership_bonus)  # membership bonus

    # ---- anticipation category ----
    ac = rc["anticipation"]
    lbl = m["anticipationLabel"]
    if lbl == "anticipating":
        g_lbl = "A"
    elif lbl == "insufficient-data (anticipating)":
        g_lbl = "B"
    elif lbl == "reacting/riding":
        g_lbl = "D"
        badges.append("REACTS_NOT_ANTICIPATES")
    else:  # unmeasured / insufficient-data (unclear)
        g_lbl = "C"
        badges.append("ANTICIPATION_UNMEASURED")
    # edge refinement
    g_edge = None
    if m["edge24hLowerCI"] is not None:
        g_edge = grade_higher_better(m["edge24hLowerCI"], ac["edge24hLowerCI"])
    elif m["edge4hLowerCI"] is not None and m["edge4hLowerCI"] >= ac["edge4hLowerCIFallback"]["gradeBThreshold"]:
        g_edge = "B"
    if g_edge is not None:
        anticipation_pts = PTS[g_lbl] * 0.6 + PTS[g_edge] * 0.4
    else:
        anticipation_pts = PTS[g_lbl]
    if m["memeShare"] is not None and m["memeShare"] > ac["thinMarketImpactFlag"]["memeOrNewListingShareAbove"] and lbl == "anticipating":
        badges.append("THIN_MARKET_IMPACT")

    # ---- regime robustness ----
    rr = rc["regimeRobustness"]
    g_surv = grade_higher_better(m["regimeBreakSurvival"], rr["regimeBreakSurvival"])
    g_worst = grade_higher_better(m["worstWindowReturn"], rr["worstWindowReturn"])
    regime_pts = PTS[g_surv] * 0.5 + PTS[g_worst] * 0.5
    if m["regimeBreakSurvival"] < 2 and m["regimeBreakMeasured"] == 2:
        if "REGIME_FRAGILE" not in badges and m["regimeBreakSurvival"] == 0:
            badges.append("REGIME_FRAGILE")

    # ---- deflated sharpe ----
    ds = rc["deflatedSharpe"]
    g_sharpe = grade_higher_better(m["sharpeAnnual"], ds["sharpeAnnual"]) if m["sharpeAnnual"] is not None else "C"
    g_conc = grade_lower_better(m["pnlConcentration"], ds["pnlConcentration"]) if m["pnlConcentration"] is not None else "C"
    deflated_pts = PTS[g_sharpe] * 0.6 + PTS[g_conc] * 0.4
    # best-of-N hurdle
    if m["sharpeAnnual"] is not None and m["sharpeAnnual"] <= ds["bestOfNHurdleSharpe"]["value"]:
        deflated_pts = min(deflated_pts, 2.0)  # cannot exceed C if below the luck hurdle

    # ---- blow-up safety ----
    bg = rc["blowUpGuard"]
    g_dd = grade_lower_better(m["maxDrawdownFrac"], bg["maxDrawdownFrac"]) if m["maxDrawdownFrac"] is not None else "C"
    blowup_pts = PTS[g_dd]
    clean_book_at_or_below = bg["maxDrawdownFrac"].get("cleanBookFlagAtOrBelow", 0.6)
    if m["maxDrawdownFrac"] is not None and m["maxDrawdownFrac"] <= clean_book_at_or_below:
        badges.append("CLEAN_BOOK")

    cats = {
        "persistence": persistence_pts,
        "anticipation": anticipation_pts,
        "regimeRobustness": regime_pts,
        "deflatedSharpe": deflated_pts,
        "blowUpSafety": blowup_pts,
    }
    weights = {k: rc["ratingRubric"]["categories"][k]["weight"] for k in cats}
    overall_pts = sum(cats[k] * weights[k] for k in cats)

    disqualified = len(dq_rules) > 0
    if disqualified:
        overall_pts = 0.0

    bands = rc["overall"]["gradeBands"]
    def to_letter(p):
        for L in LETTERS[:-1]:
            if p >= bands[L]:
                return L
        return "F"

    return {
        **m,
        "categories": {k: round(v, 2) for k, v in cats.items()},
        "overallScore0to10": round(overall_pts / 4.0 * 10, 2),
        "overallPts": round(overall_pts, 3),
        "overallGrade": "F" if disqualified else to_letter(overall_pts),
        "disqualified": disqualified,
        "disqualifyRules": dq_rules,
        "badges": sorted(set(badges)),
    }


# ---------------------------------------------------------------------------
# 4. Score everything eligible.
# ---------------------------------------------------------------------------
elig = [a for a in usable if sum(1 for r in a["returns"] if r is not None) >= 3]
scored = [grade_account(extract(a)) for a in elig]
scored.sort(key=lambda x: x["overallPts"], reverse=True)

# ---------------------------------------------------------------------------
# 5. Report.
# ---------------------------------------------------------------------------
total_eligible = len(scored)
n_dq = sum(1 for s in scored if s["disqualified"])
by_grade = {}
for s in scored:
    by_grade[s["overallGrade"]] = by_grade.get(s["overallGrade"], 0) + 1

in_set = [s for s in scored if s["inPersistentSet"]]
set_grades = {}
for s in in_set:
    set_grades[s["overallGrade"]] = set_grades.get(s["overallGrade"], 0) + 1

print(f"=== HL PERSISTENT-SKILL / ANTICIPATION rating ===")
print(f"Eligible scored: {total_eligible} of 1063 usable (of 2437 universe)")
print(f"Grade distribution: {dict(sorted(by_grade.items()))}")
print(f"Auto-disqualified: {n_dq}")
print(f"Persistent-set (43) survival by grade: {dict(sorted(set_grades.items()))}")
shortlist = [s for s in scored if s["overallGrade"] in ("A", "B")][:15]
print(f"\n=== SHORTLIST (top {len(shortlist)} by overall score, grade A/B) ===")
hdr = f"{'rank':>4} {'addr':<9} {'grade':<5} {'0-10':>5} {'tdc':>3} {'rkStab':>6} {'rbSurv':>6} {'sharpe':>6} {'maxDD':>6} {'conc':>5} {'antic':<22} {'setQ':>4}"
print(hdr)
for i, s in enumerate(shortlist, 1):
    print(f"{i:>4} {s['addressShort']:<9} {s['overallGrade']:<5} {s['overallScore0to10']:>5} "
          f"{s['topDecileForwardCount']:>3} {s['forwardRankStability']:>6.2f} {s['regimeBreakSurvival']:>6} "
          f"{(s['sharpeAnnual'] if s['sharpeAnnual'] is not None else float('nan')):>6.2f} "
          f"{(s['maxDrawdownFrac'] if s['maxDrawdownFrac'] is not None else float('nan')):>6.2f} "
          f"{(s['pnlConcentration'] if s['pnlConcentration'] is not None else float('nan')):>5.2f} "
          f"{s['anticipationLabel'][:22]:<22} {('Y' if s['inPersistentSet'] else '-'):>4}")
    if s["badges"]:
        print(f"       badges: {', '.join(s['badges'])}")

# sanity targets
print("\n=== SANITY TARGETS ===")
for tgt in ("0x6d6d7c", "0x5559da", "0xc4643e", "0xe4d1fa"):
    hit = next((s for s in scored if s["addressShort"] == tgt), None)
    if hit:
        print(f"{tgt}: {hit['overallGrade']} ({hit['overallScore0to10']}/10) "
              f"dq={hit['disqualified']} {hit['disqualifyRules']} badges={hit['badges']}")
    else:
        print(f"{tgt}: NOT in eligible set")

# dump full JSON for the UI/ingest layer
out = os.path.join(HERE, "hl-skill-shortlist.json")
json.dump({
    "config": cfg["name"] + " " + cfg["version"],
    "philosophy": cfg["philosophy"],
    "totalEligible": total_eligible,
    "gradeDistribution": dict(sorted(by_grade.items())),
    "autoDisqualified": n_dq,
    "persistentSetSurvivalByGrade": dict(sorted(set_grades.items())),
    "shortlist": shortlist,
}, open(out, "w"), indent=2)
print(f"\nFull shortlist JSON -> {out}")
