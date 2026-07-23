#!/usr/bin/env python3
"""Funding-extreme REVERSION — pre-registered directional study (offline).

HYPOTHESIS (declared BEFORE looking at any result): when the perp funding rate
reaches a statistical extreme vs its own recent history, crowded positioning
unwinds and price mean-reverts AGAINST the crowd. Fading a crowded-long (funding
far above its mean) with a SHORT also EARNS that funding — the price reversion
and the carry compound if the effect is real. This is DISTINCT from the delta-
neutral funding-harvest study; here the bet is DIRECTIONAL.

PRE-REGISTERED design (nothing below was tuned after seeing output):
  Grid: DAILY (HL retains 1d candles for the full 2yr span; 1h only ~7mo). Funding
    is hourly → funding_day[d] = SUM of that day's 24 hourly rates (the real daily
    carry a position pays/earns).
  Signal at day d, using data through the CLOSE of day d (no lookahead):
    z_d = (funding_day[d] - mean(funding_day[d-W..d-1])) / std(funding_day[d-W..d-1])
    W = 7 days (trailing, excludes d).
  Entry (NON-OVERLAPPING — once in a trade, no re-entry until it exits, so trades
    are ~independent and the t-stat isn't autocorrelation-inflated):
    z_d >= +Z  -> SHORT (fade crowded longs)
    z_d <= -Z  -> LONG  (fade crowded shorts)
    executed at that day's close.
  Thresholds Z in {1.5, 2.0}  (exactly two — limits multiple testing).
  Hold H days, exit at close[d+H].  PRIMARY H = 2; secondary H in {1, 3}.
  P&L (fraction of notional, one-sided directional):
    price_pnl   = side * (close[d+H] - close[d]) / close[d]
    funding_pnl = -side * sum(funding_day[d+1..d+H])   # long pays, short earns
    cost        = 2 * 0.00035 = 0.0007                 # HL taker round trip
    net         = price_pnl + funding_pnl - cost
  Assets: BTC, ETH, SOL. Span: 2024-06 .. now (multi-regime).

PRE-REGISTERED BAR (the go/no-go for building a live lane):
  PROMISING (forward-test-worthy) requires ALL of, at PRIMARY H=2, for >=1 Z:
    (1) pooled mean net > 0
    (2) pooled t-stat >= 2.0   (note: 2 primary Z-tests → treat 2.0-2.5 as
        SUGGESTIVE, >2.5 as solid, per Bonferroni spirit)
    (3) >= 2 of 3 assets same (positive) sign
    (4) pooled n >= 30 trades
  Else KILL: no directional funding edge — do NOT build the lane.

A significantly NEGATIVE fade net is itself a finding (funding MOMENTUM, not
reversion) and is reported as such.

Usage: python3 scripts/analysis/funding-reversion-study/analyze.py
"""

import json
import math
import os
import statistics
from datetime import datetime, timezone

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
CACHE_DIR = os.path.join(REPO_ROOT, "data", "backups", "funding-reversion-study")

ASSETS = ["BTC", "ETH", "SOL"]
W = 7                      # trailing window (days) for the z-score
Z_LEVELS = [1.5, 2.0]     # pre-registered
HOLDS = [1, 2, 3]         # primary H=2
H_PRIMARY = 2
TAKER_RT = 0.0007         # 2 x 0.035%
DAY_MS = 86_400_000

# Regime eras (calendar mapping declared up front — same as the harvest study).
ERAS = [
    ("2024H2", "2024-06-01", "2025-01-01"),
    ("2025 bear (Jan-Apr)", "2025-01-01", "2025-05-01"),
    ("2025 bull (May-Aug)", "2025-05-01", "2025-09-01"),
    ("2025 Q4", "2025-09-01", "2026-01-01"),
    ("2026 Jan (neutral)", "2026-01-01", "2026-02-01"),
    ("2026 bear (Feb-Mar)", "2026-02-01", "2026-04-01"),
    ("2026 bull (Apr-May15)", "2026-04-01", "2026-05-16"),
    ("2026 bear (May16-Jul)", "2026-05-16", "2026-12-31"),
]


def load(name):
    with open(os.path.join(CACHE_DIR, name)) as f:
        return json.load(f)


def build_daily(coin):
    """Return aligned per-day arrays: t_ms (open 00:00), close, funding_day (sum of
    that day's hourly rates). Days are the daily candles; funding summed by [t, t+24h)."""
    candles = load(f"hl_candles_1d_{coin}.json")
    funding = load(f"hl_funding_{coin}.json")
    # bucket hourly funding into day = floor(time / DAY_MS)*DAY_MS
    fbyday = {}
    for r in funding:
        day = (r["time"] // DAY_MS) * DAY_MS
        fbyday[day] = fbyday.get(day, 0.0) + float(r["fundingRate"])
    days, closes, fday = [], [], []
    for c in candles:
        day = (c["t"] // DAY_MS) * DAY_MS
        if day not in fbyday:
            continue  # no funding coverage that day → skip (keeps series honest)
        days.append(day)
        closes.append(float(c["c"]))
        fday.append(fbyday[day])
    return days, closes, fday


def era_of(t_ms):
    d = datetime.fromtimestamp(t_ms / 1000, timezone.utc)
    for name, a, b in ERAS:
        if datetime.fromisoformat(a).replace(tzinfo=timezone.utc) <= d < datetime.fromisoformat(b).replace(tzinfo=timezone.utc):
            return name
    return "?"


def simulate(coin, Z, H):
    days, closes, fday = build_daily(coin)
    n = len(days)
    trades = []
    i = W  # need W history before the first signal
    while i < n - H:
        window = fday[i - W:i]
        if len(window) < W:
            i += 1
            continue
        mu = statistics.mean(window)
        sd = statistics.pstdev(window)
        if sd <= 0:
            i += 1
            continue
        z = (fday[i] - mu) / sd
        if abs(z) < Z:
            i += 1
            continue
        side = -1 if z > 0 else 1  # fade the crowd
        price_ret = (closes[i + H] - closes[i]) / closes[i]
        price_pnl = side * price_ret
        funding_accrued = sum(fday[i + 1:i + 1 + H])
        funding_pnl = -side * funding_accrued
        net = price_pnl + funding_pnl - TAKER_RT
        trades.append({
            "t": days[i], "era": era_of(days[i]), "side": "short" if side < 0 else "long",
            "z": z, "price_pnl": price_pnl, "funding_pnl": funding_pnl, "net": net,
        })
        i += H  # non-overlapping: jump past the hold
    return trades


def stats(nets):
    n = len(nets)
    if n == 0:
        return {"n": 0, "mean": 0.0, "t": 0.0, "win": 0.0}
    mean = statistics.mean(nets)
    sd = statistics.pstdev(nets) if n > 1 else 0.0
    t = (mean / (sd / math.sqrt(n))) if sd > 0 else 0.0
    win = sum(1 for x in nets if x > 0) / n
    return {"n": n, "mean": mean, "t": t, "win": win}


def main():
    results = {}
    print("=" * 78)
    print("FUNDING-EXTREME REVERSION — pre-registered directional study")
    print(f"W={W}d trailing z | Z in {Z_LEVELS} | H in {HOLDS} (primary {H_PRIMARY}) | cost {TAKER_RT*100:.2f}% RT")
    print("Fade: funding >> mean -> SHORT | funding << mean -> LONG. Span 2024-06..now, BTC/ETH/SOL.")
    print("=" * 78)

    for Z in Z_LEVELS:
        for H in HOLDS:
            pooled = []
            per_asset = {}
            for coin in ASSETS:
                tr = simulate(coin, Z, H)
                per_asset[coin] = tr
                pooled.extend(tr)
            tag = f"Z={Z} H={H}"
            results[tag] = {
                "pooled": stats([t["net"] for t in pooled]),
                "per_asset": {c: stats([t["net"] for t in per_asset[c]]) for c in ASSETS},
                "price_component": statistics.mean([t["price_pnl"] for t in pooled]) if pooled else 0.0,
                "funding_component": statistics.mean([t["funding_pnl"] for t in pooled]) if pooled else 0.0,
            }
            star = "  <<< PRIMARY" if H == H_PRIMARY else ""
            p = results[tag]["pooled"]
            print(f"\n{tag}{star}")
            print(f"  POOLED : n={p['n']:3d}  mean_net={p['mean']*100:+.3f}%  t={p['t']:+.2f}  win={p['win']*100:.0f}%"
                  f"   [price {results[tag]['price_component']*100:+.3f}% | funding {results[tag]['funding_component']*100:+.3f}%]")
            for c in ASSETS:
                s = results[tag]["per_asset"][c]
                print(f"    {c:4s}: n={s['n']:3d}  mean_net={s['mean']*100:+.3f}%  t={s['t']:+.2f}  win={s['win']*100:.0f}%")

    # Regime breakdown at the primary cell (Z with the strongest pooled t, H=primary).
    print("\n" + "=" * 78)
    print(f"REGIME BREAKDOWN @ H={H_PRIMARY} (net %, n) — is the effect regime-conditional?")
    print("=" * 78)
    for Z in Z_LEVELS:
        pooled = []
        for coin in ASSETS:
            pooled.extend(simulate(coin, Z, H_PRIMARY))
        by_era = {}
        for t in pooled:
            by_era.setdefault(t["era"], []).append(t["net"])
        print(f"\nZ={Z}:")
        for name, _, _ in ERAS:
            nets = by_era.get(name, [])
            if nets:
                s = stats(nets)
                print(f"  {name:24s}: n={s['n']:2d}  mean={s['mean']*100:+.3f}%  win={s['win']*100:.0f}%")

    # PRE-REGISTERED VERDICT
    print("\n" + "=" * 78)
    print("PRE-REGISTERED VERDICT (bar: pooled mean>0 & t>=2.0 & >=2/3 assets +, n>=30 @ H=2)")
    print("=" * 78)
    verdict = "KILL"
    detail = []
    for Z in Z_LEVELS:
        r = results[f"Z={Z} H={H_PRIMARY}"]
        p = r["pooled"]
        pos_assets = sum(1 for c in ASSETS if r["per_asset"][c]["mean"] > 0)
        passes = p["mean"] > 0 and p["t"] >= 2.0 and pos_assets >= 2 and p["n"] >= 30
        strength = "SOLID" if p["t"] >= 2.5 else ("SUGGESTIVE" if p["t"] >= 2.0 else "—")
        detail.append(f"  Z={Z}: mean={p['mean']*100:+.3f}% t={p['t']:+.2f} pos_assets={pos_assets}/3 n={p['n']} "
                      f"-> {'PASS' if passes else 'fail'} ({strength})")
        if passes:
            verdict = "PROMISING" if verdict == "KILL" else verdict
        # A strongly negative fade = funding MOMENTUM finding
        if p["mean"] < 0 and p["t"] <= -2.0:
            verdict = "MOMENTUM (fade is negative — following funding would be the edge)"
    print("\n".join(detail))
    print(f"\n>>> VERDICT: {verdict}")

    with open(os.path.join(CACHE_DIR, "results.json"), "w") as f:
        json.dump(results, f, indent=2)
    print(f"\nwrote {os.path.join(CACHE_DIR, 'results.json')}")


if __name__ == "__main__":
    main()
