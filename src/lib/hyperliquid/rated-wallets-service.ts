/**
 * Loads the consolidated rated-wallets dataset for the Wallet Copy-Monitor.
 *
 * Source: data/backups/wallet-rating/rated-wallets.json
 * Regenerate with: node scripts/analysis/wallet-rating/consolidate-rated-wallets.mjs
 *
 * Server-only (reads the filesystem). Read-only — never mutated.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface PhilosophyGrade {
  grade: string;
  score10: number | null;
}

export interface RatedWalletMetrics {
  sharpe?: number;
  maxDrawdownFrac?: number;
  winRate?: number;
  profitFactor?: number;
  worstLossVsMedianWin?: number;
  aggregatePnlUsd?: number;
  totalReturn?: number;
  majorsShare?: number;
  medianHoldHours?: number;
  maxAddDepth?: number;
  medianAddDepth?: number;
  reserveMultiple?: number;
  liquidations?: number;
  nFills?: number;
  distinctCoins?: number;
  subMinuteFrac?: number;
  openPeakVsMedianPeak?: number;
  avgAccountValue?: number;
  accountAgeDays?: number;
  memeShare?: number;
}

/** EDT-bucketed trading-hours profile, derived from cached fills. */
export interface TradingActivity {
  /** Share of fills per EDT hour (length 24, index = hour 0-23). Sums to ~1. */
  hourHistogramEdt: number[];
  /** Share of fills inside the configured watch window (0-1). */
  daytimeActivePct: number;
  /** Share of fills outside the watch window (0-1). */
  overnightPct: number;
  /** Top EDT hours by fill share (most active first). */
  peakHoursEdt: number[];
  nFillsAnalyzed: number;
}

export interface WatchWindowEdt {
  startHour: number;
  endHour: number;
}

export interface RatedWallet {
  address: string;
  short: string;
  displayName: string | null;
  grades: Record<string, PhilosophyGrade>;
  composite: number | null;
  flags: string[];
  metrics: RatedWalletMetrics;
  sources: string[];
  /** EDT trading-hours profile, or null when the wallet has no cached fills. */
  tradingActivity: TradingActivity | null;
  leaderboardTop?: boolean;
  anticipationLabel?: string;
  topCoins?: string[];
  worstOpen?: { coin: string; peakNotionalUsd: number; adds: number };
}

export interface RatedWalletsDataset {
  schemaVersion: number;
  generatedAt: string;
  description: string;
  philosophies: string[];
  /** The watch window (America/New_York) daytimeActivePct is computed against. */
  watchWindowEdt: WatchWindowEdt;
  knownFlags: string[];
  count: number;
  wallets: RatedWallet[];
}

let cached: RatedWalletsDataset | null = null;

const DATA_PATH = join(
  process.cwd(),
  'data',
  'backups',
  'wallet-rating',
  'rated-wallets.json',
);

/** Risk flags the UI should color red. */
export const RISK_FLAGS = new Set([
  'DISQUALIFIED', 'NO_STOPS', 'DEEP_MARTINGALE', 'DEEP_DRAWDOWN', 'FAT_WORST_LOSS',
  'LIVE_UNDERWATER', 'RIDE_OR_LIQUIDATE', 'BLOW_UP_RISK', 'LIVE_DEEP_STACK',
  'EXTREME_WIN_RATE', 'THIN_ALT_TRADER', 'SUB_MINUTE_SCALPER', 'TRADES_OVERNIGHT_EDT',
]);

/** Load (and cache) the full dataset. */
export function loadRatedWallets(): RatedWalletsDataset {
  if (cached) return cached;
  try {
    const raw = readFileSync(DATA_PATH, 'utf8');
    cached = JSON.parse(raw) as RatedWalletsDataset;
  } catch {
    cached = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      description: 'rated-wallets.json not found — run the consolidation script.',
      philosophies: [],
      watchWindowEdt: { startHour: 8, endHour: 22 },
      knownFlags: [],
      count: 0,
      wallets: [],
    };
  }
  return cached;
}

/** Find a single rated wallet by address (case-insensitive). */
export function findRatedWallet(address: string): RatedWallet | null {
  const target = address.trim().toLowerCase();
  return loadRatedWallets().wallets.find((w) => w.address === target) ?? null;
}
