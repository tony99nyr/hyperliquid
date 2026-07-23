import { describe, it, expect } from 'vitest';
import { scanReversionExtremes, type ScanCandleFetch } from '@/lib/scout/reversion-scan-service';
import type { PriceCandle } from '@/types/trading-core';

let ts = 0;
function pc(close: number): PriceCandle {
  return { timestamp: (ts++) * 900_000, open: close, high: close + 0.05, low: close - 0.05, close, volume: 1 };
}

/** Choppy range then a clean directional stretch — sized for the DEFAULT reversion
 *  config (volLookback 96, moveBars 16), which is what the scan service uses. */
function stretchSeries(baseN: number, wiggle: number, stretchFrac: number, stretchBars: number): PriceCandle[] {
  ts = 0;
  const out: PriceCandle[] = [];
  let p = 100;
  for (let i = 0; i < baseN; i++) {
    p = 100 + (i % 2 === 0 ? wiggle : -wiggle);
    out.push(pc(p));
  }
  const start = out[out.length - 1].close;
  for (let i = 1; i <= stretchBars; i++) out.push(pc(start * (1 + (stretchFrac * i) / stretchBars)));
  return out;
}

/** A monotonic climb → a confident bullish 4h regime (gate should reject the fade). */
function uptrend(n: number): PriceCandle[] {
  ts = 0;
  return Array.from({ length: n }, (_, i) => pc(100 * (1 + (0.5 * i) / n)));
}
/** A flat wiggle → neutral / low-confidence 4h regime (gate allows the fade). */
function rangey(n: number): PriceCandle[] {
  ts = 0;
  return Array.from({ length: n }, (_, i) => pc(100 + (i % 2 === 0 ? 0.4 : -0.4)));
}

const UP_STRETCH_15M = stretchSeries(112, 0.2, 0.08, 17); // fires under DEFAULT cfg: z≈4.5, eff≈0.19

/** Build a fake fetcher from a per-(coin,interval) table; unknown → empty. */
function fakeFetch(table: Record<string, Record<string, PriceCandle[]>>): ScanCandleFetch {
  return async (coin, interval) => {
    const candles = table[coin]?.[interval] ?? [];
    return { stale: false, candles };
  };
}

describe('scanReversionExtremes', () => {
  it('fires a fade hit when a 15m stretch prints under a NON-trending 4h regime', async () => {
    const fetch = fakeFetch({ SOL: { '4h': rangey(60), '15m': UP_STRETCH_15M } });
    const { hits, regimeByCoin } = await scanReversionExtremes(['SOL'], 1_000_000, fetch);
    expect(hits).toHaveLength(1);
    expect(hits[0].coin).toBe('SOL');
    expect(hits[0].side).toBe('short'); // fade an up-stretch
    expect(Math.abs(hits[0].z)).toBeGreaterThan(2.5);
    expect(regimeByCoin.SOL).toBeDefined();
  });

  it('the 4h regime gate REJECTS the fade in a confident trend (no hit, regime still recorded)', async () => {
    const fetch = fakeFetch({ SOL: { '4h': uptrend(60), '15m': UP_STRETCH_15M } });
    const { hits, regimeByCoin } = await scanReversionExtremes(['SOL'], 1_000_000, fetch);
    expect(hits).toHaveLength(0); // confident bullish 4h → never fade
    expect(regimeByCoin.SOL?.regime).toBe('bullish');
    expect(regimeByCoin.SOL?.confidence).toBeGreaterThanOrEqual(0.55);
  });

  it('is fail-soft per coin — a throwing fetch drops that coin, not the scan (+ coverage tally)', async () => {
    const good = fakeFetch({ SOL: { '4h': rangey(60), '15m': UP_STRETCH_15M } });
    const fetch: ScanCandleFetch = async (coin, interval, s, e) => {
      if (coin === 'BAD') throw new Error('candle boom');
      return good(coin, interval, s, e);
    };
    const { hits, coverage } = await scanReversionExtremes(['BAD', 'SOL'], 1_000_000, fetch);
    expect(hits.map((h) => h.coin)).toEqual(['SOL']);
    // the throwing coin is counted as skipped, not silently absent
    expect(coverage).toEqual({ requested: 2, scanned: 1, skipped: 1 });
  });

  it('skips a coin with too few 15m bars (no hit, no throw)', async () => {
    const fetch = fakeFetch({ SOL: { '4h': rangey(60), '15m': UP_STRETCH_15M.slice(0, 50) } });
    const { hits } = await scanReversionExtremes(['SOL'], 1_000_000, fetch);
    expect(hits).toHaveLength(0);
  });

  it('degrades to efficiency-only when 4h has too few bars (regime omitted, fade still evaluated)', async () => {
    const fetch = fakeFetch({ SOL: { '4h': rangey(10), '15m': UP_STRETCH_15M } });
    const { hits, regimeByCoin } = await scanReversionExtremes(['SOL'], 1_000_000, fetch);
    expect(regimeByCoin.SOL).toBeUndefined(); // <52 bars → no regime read
    expect(hits).toHaveLength(1); // efficiency-only fade still fires
    expect(hits[0].regime).toBe('unknown');
  });
});
