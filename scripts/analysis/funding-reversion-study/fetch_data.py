#!/usr/bin/env python3
"""Funding-extreme REVERSION study — data fetcher (cached, deterministic).

DISTINCT from the funding HARVEST study (scripts/analysis/funding-study): that
one is delta-neutral carry (long spot + short perp to EARN funding). THIS study
tests funding as a CONTRARIAN DIRECTIONAL signal — when funding reaches a
statistical extreme (crowded positioning), does price mean-revert against the
crowd? Fading a crowded-long (high positive funding) with a short ALSO collects
the funding, so the two effects compound if the reversion is real.

Pulls and caches to data/backups/funding-reversion-study/:
  - HL hourly funding history (BTC, ETH, SOL) from 2024-06-01 to now
  - HL 1h perp candles (BTC, ETH, SOL), same span (paginated, 5000/req cap)

All pulls are cached: an existing target file is NOT re-fetched (delete to
refresh). analyze.py runs fully offline against the cache.

Usage: python3 scripts/analysis/funding-reversion-study/fetch_data.py
"""

import json
import os
import time
import urllib.request
from datetime import datetime, timezone

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
CACHE_DIR = os.path.join(REPO_ROOT, "data", "backups", "funding-reversion-study")

START_MS = 1717200000000  # 2024-06-01T00:00:00Z
HL_API = "https://api.hyperliquid.xyz/info"
ASSETS = ["BTC", "ETH", "SOL"]


def now_ms() -> int:
    return int(time.time() * 1000)


def hl_post(payload: dict, retries: int = 5):
    body = json.dumps(payload).encode()
    for attempt in range(retries):
        try:
            req = urllib.request.Request(HL_API, data=body, headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.loads(resp.read())
        except Exception as exc:  # noqa: BLE001
            if attempt == retries - 1:
                raise
            wait = 2**attempt
            print(f"  retry {attempt + 1} after error: {exc} (sleep {wait}s)")
            time.sleep(wait)
    return None


def fetch_funding(coin: str) -> None:
    out_path = os.path.join(CACHE_DIR, f"hl_funding_{coin}.json")
    if os.path.exists(out_path):
        print(f"[cache] {out_path} exists, skipping")
        return
    print(f"Fetching HL funding history for {coin} ...")
    all_rows: list[dict] = []
    cursor = START_MS
    end = now_ms()
    page = 0
    while cursor < end:
        rows = hl_post({"type": "fundingHistory", "coin": coin, "startTime": cursor})
        page += 1
        if not rows:
            break
        all_rows.extend(rows)
        last_t = rows[-1]["time"]
        if len(rows) < 500:
            break
        cursor = last_t + 1
        time.sleep(0.3)
    seen: set[int] = set()
    deduped = []
    for r in all_rows:
        if r["time"] not in seen:
            seen.add(r["time"])
            deduped.append(r)
    deduped.sort(key=lambda r: r["time"])
    with open(out_path, "w") as f:
        json.dump(deduped, f)
    first = datetime.fromtimestamp(deduped[0]["time"] / 1000, timezone.utc)
    last = datetime.fromtimestamp(deduped[-1]["time"] / 1000, timezone.utc)
    print(f"  saved {len(deduped)} hourly funding rows ({first:%Y-%m-%d} .. {last:%Y-%m-%d})")


def fetch_candles_1h(coin: str) -> None:
    out_path = os.path.join(CACHE_DIR, f"hl_candles_1h_{coin}.json")
    if os.path.exists(out_path):
        print(f"[cache] {out_path} exists, skipping")
        return
    print(f"Fetching HL 1h candles for {coin} (windowed) ...")
    # HL candleSnapshot returns the MOST-RECENT ≤5000 candles for the range regardless
    # of startTime, so a naive startTime=START,endTime=now pull only yields the last
    # ~7 months. Request in explicit forward windows of <5000 hours instead.
    HOUR_MS = 3600_000
    WINDOW_H = 4000  # < 5000 cap, with headroom
    all_rows: list[dict] = []
    cursor = START_MS
    end = now_ms()
    while cursor < end:
        win_end = min(end, cursor + WINDOW_H * HOUR_MS)
        rows = hl_post({"type": "candleSnapshot", "req": {"coin": coin, "interval": "1h", "startTime": cursor, "endTime": win_end}})
        if rows:
            all_rows.extend(rows)
        cursor = win_end + 1
        time.sleep(0.8)  # gentle: SOL got 429-throttled on tighter spacing
    seen: set[int] = set()
    deduped = []
    for r in all_rows:
        if r["t"] not in seen:
            seen.add(r["t"])
            deduped.append(r)
    deduped.sort(key=lambda r: r["t"])
    with open(out_path, "w") as f:
        json.dump(deduped, f)
    first = datetime.fromtimestamp(deduped[0]["t"] / 1000, timezone.utc)
    last = datetime.fromtimestamp(deduped[-1]["t"] / 1000, timezone.utc)
    print(f"  saved {len(deduped)} 1h candles ({first:%Y-%m-%d} .. {last:%Y-%m-%d})")


def fetch_candles_1d(coin: str) -> None:
    # Daily candles serve the FULL 2yr span in one request (HL retains 1d far longer
    # than 1h). Funding-extreme reversion is a multi-day positioning unwind, so a daily
    # grid is the appropriate — and fully regime-covered — resolution.
    out_path = os.path.join(CACHE_DIR, f"hl_candles_1d_{coin}.json")
    if os.path.exists(out_path):
        print(f"[cache] {out_path} exists, skipping")
        return
    print(f"Fetching HL 1d candles for {coin} ...")
    rows = hl_post({"type": "candleSnapshot", "req": {"coin": coin, "interval": "1d", "startTime": START_MS, "endTime": now_ms()}})
    rows = sorted(rows, key=lambda r: r["t"])
    with open(out_path, "w") as f:
        json.dump(rows, f)
    first = datetime.fromtimestamp(rows[0]["t"] / 1000, timezone.utc)
    last = datetime.fromtimestamp(rows[-1]["t"] / 1000, timezone.utc)
    print(f"  saved {len(rows)} daily candles ({first:%Y-%m-%d} .. {last:%Y-%m-%d})")
    time.sleep(0.8)


def main() -> None:
    os.makedirs(CACHE_DIR, exist_ok=True)
    for coin in ASSETS:
        fetch_funding(coin)
        fetch_candles_1d(coin)
    print("Done. Run analyze.py.")


if __name__ == "__main__":
    main()
