/** Daemon-owned paper entries for the frozen daily Donchian rule. */
import type { TradingMode } from '@/types/fill';
import type { HtfTrendScanResult } from './htf-trend-scan-service';
import { assertScoutPaperMode } from './scout-execution-guard';
import { volNormalizedRiskUsd } from './scout-sizing-business-logic';

export const HTF_DETERMINISTIC_RULE_VERSION = 'htf-trend-donchian-20-10-daemon-v1';

export function assertHtfEntryAuthority(lane: string, enabled: boolean, daemonEntry: boolean): void {
  if (lane === 'htf-trend' && enabled && !daemonEntry) {
    throw new Error('htf-trend entry is daemon-owned while SCOUT_HTF_DETERMINISTIC=true');
  }
}

export interface HtfEntry {
  coin: string;
  side: 'buy' | 'sell';
  entryPx: number;
  stopFrac: number;
  riskUsd: number;
  lane: 'htf-trend';
  setupType: 'donchian-20-10';
  ruleVersion: typeof HTF_DETERMINISTIC_RULE_VERSION;
}

export interface HtfEntryDeps {
  scan: (coins: string[], now: number) => Promise<HtfTrendScanResult>;
  openCoins: () => Promise<Set<string>>;
  execute: (entry: HtfEntry) => Promise<void>;
  log: (message: string) => Promise<void>;
  /** Optional model review. A non-empty reason vetoes; it cannot modify an entry. */
  veto?: (entry: HtfEntry) => Promise<string | null>;
}

export async function runDeterministicHtfEntries(
  enabled: boolean,
  mode: TradingMode,
  now: number,
  deps: HtfEntryDeps,
): Promise<Array<{ coin: string; outcome: 'opened' | 'vetoed' | 'failed' }>> {
  if (!enabled) return [];
  assertScoutPaperMode(mode);
  const open = await deps.openCoins();
  const scan = await deps.scan(['BTC', 'ETH', 'SOL', 'HYPE'], now);
  const outcomes: Array<{ coin: string; outcome: 'opened' | 'vetoed' | 'failed' }> = [];
  for (const read of scan.reads) {
    const breakout = read.breakout;
    if (!breakout || open.has(read.coin)) continue;
    const entry: HtfEntry = {
      coin: read.coin,
      side: breakout.side === 'long' ? 'buy' : 'sell',
      entryPx: breakout.entryPx,
      stopFrac: breakout.stopFrac,
      riskUsd: volNormalizedRiskUsd(read.atr / read.latestClose),
      lane: 'htf-trend',
      setupType: 'donchian-20-10',
      ruleVersion: HTF_DETERMINISTIC_RULE_VERSION,
    };
    try {
      const reason = await deps.veto?.(entry);
      if (reason) {
        await deps.log(`HTF deterministic veto ${entry.coin}: ${reason}`);
        outcomes.push({ coin: entry.coin, outcome: 'vetoed' });
        continue;
      }
      await deps.execute(entry);
      open.add(entry.coin);
      await deps.log(`HTF deterministic entry ${entry.coin} ${entry.side} rule=${entry.ruleVersion}`);
      outcomes.push({ coin: entry.coin, outcome: 'opened' });
    } catch (error) {
      await deps.log(`HTF deterministic entry failed ${entry.coin}: ${error instanceof Error ? error.message : String(error)}`);
      outcomes.push({ coin: entry.coin, outcome: 'failed' });
    }
  }
  return outcomes;
}
