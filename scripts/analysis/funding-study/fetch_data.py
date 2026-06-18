#!/usr/bin/env python3
"""Funding harvest feasibility study — data fetcher (cached, deterministic).

Pulls and caches to data/backups/funding-study/:
  - Hyperliquid hourly funding history (ETH, BTC) from 2024-06-01 to now
  - Hyperliquid daily perp candles (ETH, BTC) for the same span
  - Binance USD-M funding rates (8h) via data.binance.vision monthly dumps
    (ETHUSDT, BTCUSDT) — cross-check venue. NOTE: fapi.binance.com is
    geo-blocked from this location; the static S3 dumps are not. Current
    partial month (2026-06) is not yet published; cross-check span ends
    at the last complete month.
  - Hyperliquid metaAndAssetCtxs snapshot (current funding/OI context)

All pulls are cached: if the target file exists, it is NOT re-fetched
(delete a file to force a refresh). Analysis (analyze.py) runs fully
offline against the cache.

Usage: python3 scripts/analysis/funding-study/fetch_data.py
"""

import csv
import io
import json
import os
import sys
import time
import urllib.request
import zipfile
from datetime import datetime, timezone

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
CACHE_DIR = os.path.join(REPO_ROOT, "data", "backups", "funding-study")

START_MS = 1717200000000  # 2024-06-01T00:00:00Z (24 months span target)
HL_API = "https://api.hyperliquid.xyz/info"
ASSETS = ["ETH", "BTC"]
BINANCE_SYMBOLS = {"ETH": "ETHUSDT", "BTC": "BTCUSDT"}
# Monthly dumps: 2024-06 .. 2026-05 (2026-06 not yet published)
BINANCE_MONTHS = [
    f"{y}-{m:02d}"
    for y in (2024, 2025, 2026)
    for m in range(1, 13)
    if (y, m) >= (2024, 6) and (y, m) <= (2026, 5)
]


def now_ms() -> int:
    return int(time.time() * 1000)


def hl_post(payload: dict, retries: int = 5):
    body = json.dumps(payload).encode()
    for attempt in range(retries):
        try:
            req = urllib.request.Request(
                HL_API, data=body, headers={"Content-Type": "application/json"}
            )
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.loads(resp.read())
        except Exception as exc:  # noqa: BLE001
            if attempt == retries - 1:
                raise
            wait = 2**attempt
            print(f"  retry {attempt + 1} after error: {exc} (sleep {wait}s)")
            time.sleep(wait)
    return None


def fetch_hl_funding(coin: str) -> None:
    out_path = os.path.join(CACHE_DIR, f"hl_funding_{coin}.json")
    if os.path.exists(out_path):
        print(f"[cache] {out_path} exists, skipping")
        return
    print(f"Fetching HL funding history for {coin} from 2024-06-01 ...")
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
        if page % 10 == 0:
            dt = datetime.fromtimestamp(last_t / 1000, timezone.utc)
            print(f"  page {page}: {len(all_rows)} rows, up to {dt:%Y-%m-%d %H:%M}")
        if len(rows) < 500:
            break
        cursor = last_t + 1
        time.sleep(0.3)
    # De-duplicate on timestamp (paginated pulls can overlap by one row)
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
    print(f"  saved {len(deduped)} hourly rows ({first:%Y-%m-%d} .. {last:%Y-%m-%d})")


def fetch_hl_candles(coin: str) -> None:
    out_path = os.path.join(CACHE_DIR, f"hl_candles_1d_{coin}.json")
    if os.path.exists(out_path):
        print(f"[cache] {out_path} exists, skipping")
        return
    print(f"Fetching HL daily candles for {coin} ...")
    rows = hl_post(
        {
            "type": "candleSnapshot",
            "req": {
                "coin": coin,
                "interval": "1d",
                "startTime": START_MS,
                "endTime": now_ms(),
            },
        }
    )
    with open(out_path, "w") as f:
        json.dump(rows, f)
    first = datetime.fromtimestamp(rows[0]["t"] / 1000, timezone.utc)
    last = datetime.fromtimestamp(rows[-1]["t"] / 1000, timezone.utc)
    print(f"  saved {len(rows)} daily candles ({first:%Y-%m-%d} .. {last:%Y-%m-%d})")


def fetch_hl_meta_snapshot() -> None:
    out_path = os.path.join(CACHE_DIR, "hl_meta_snapshot.json")
    if os.path.exists(out_path):
        print(f"[cache] {out_path} exists, skipping")
        return
    print("Fetching HL metaAndAssetCtxs snapshot ...")
    meta, ctxs = hl_post({"type": "metaAndAssetCtxs"})
    snapshot = {"fetchedAtMs": now_ms(), "assets": {}}
    for i, u in enumerate(meta["universe"]):
        if u["name"] in ASSETS:
            snapshot["assets"][u["name"]] = ctxs[i]
    with open(out_path, "w") as f:
        json.dump(snapshot, f, indent=2)
    print(f"  saved snapshot: {list(snapshot['assets'].keys())}")


def fetch_binance_funding(coin: str) -> None:
    symbol = BINANCE_SYMBOLS[coin]
    out_path = os.path.join(CACHE_DIR, f"binance_funding_{symbol}.json")
    if os.path.exists(out_path):
        print(f"[cache] {out_path} exists, skipping")
        return
    print(f"Fetching Binance Vision funding dumps for {symbol} ...")
    rows: list[dict] = []
    for month in BINANCE_MONTHS:
        url = (
            f"https://data.binance.vision/data/futures/um/monthly/fundingRate/"
            f"{symbol}/{symbol}-fundingRate-{month}.zip"
        )
        try:
            with urllib.request.urlopen(url, timeout=60) as resp:
                blob = resp.read()
        except urllib.error.HTTPError as exc:
            print(f"  {month}: HTTP {exc.code} (skipped)")
            continue
        zf = zipfile.ZipFile(io.BytesIO(blob))
        csv_bytes = zf.read(zf.namelist()[0])
        reader = csv.DictReader(io.StringIO(csv_bytes.decode()))
        n = 0
        for rec in reader:
            rows.append(
                {
                    "time": int(rec["calc_time"]),
                    "fundingRate": float(rec["last_funding_rate"]),
                    "intervalHours": int(rec["funding_interval_hours"]),
                }
            )
            n += 1
        print(f"  {month}: {n} rows")
        time.sleep(0.2)
    rows.sort(key=lambda r: r["time"])
    with open(out_path, "w") as f:
        json.dump(rows, f)
    first = datetime.fromtimestamp(rows[0]["time"] / 1000, timezone.utc)
    last = datetime.fromtimestamp(rows[-1]["time"] / 1000, timezone.utc)
    print(f"  saved {len(rows)} rows ({first:%Y-%m-%d} .. {last:%Y-%m-%d})")


def main() -> None:
    os.makedirs(CACHE_DIR, exist_ok=True)
    for coin in ASSETS:
        fetch_hl_funding(coin)
        fetch_hl_candles(coin)
        fetch_binance_funding(coin)
    fetch_hl_meta_snapshot()
    print("Done. Cache dir:", CACHE_DIR)


if __name__ == "__main__":
    sys.exit(main())
