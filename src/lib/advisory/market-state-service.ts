/**
 * Advisory market-state (I/O) — the cockpit's half of the cross-system bridge.
 *
 * Serves the FAST Hyperliquid picture the 8h-candle iamrossi system is blind
 * to: 15m momentum-stall composites (the SAME numbers the ladder engine
 * trades on), the recent whale/leader action flow, and the curated macro event
 * window. READ-ONLY and fail-soft PER SECTION: a failed section returns null
 * with the rest intact, so a consumer can never be blocked — only informed.
 * Never exposes session ids, ladder internals, or anything writable.
 */

import 'server-only';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { getServiceRoleClient } from '@/lib/cockpit/supabase-server';
import { fetchCandles } from '@/lib/hyperliquid/candle-service';
import { computeMomentumIndicators } from '@/lib/ladder/ladder-momentum-service';
import { MOMENTUM_STALL_LONG, MOMENTUM_STALL_SHORT } from '@/lib/ladder/ladder-types';
import {
  parseCalendar,
  eventWindowState,
  type EventWindowState,
} from './market-state-business-logic';

export interface CoinAdvisory {
  coin: string;
  /** Momentum-stall flip counts 0–3 (2+ = stalling). null = data unavailable. */
  momentumStallLong: number | null;
  momentumStallShort: number | null;
}

export interface LeaderFlowSummary {
  /** Rated-leader actions in the window, net by coin: positive = net opens/adds long. */
  windowHours: number;
  byCoin: Record<string, { opens: number; closes: number; adds: number; reduces: number }>;
}

export interface MarketStateAdvisory {
  generatedAt: number;
  coins: CoinAdvisory[];
  eventWindow: EventWindowState;
  leaderFlow: LeaderFlowSummary | null;
  note: string;
}

/** 15m candles over 4h — the same window the ladder momentum publisher uses. */
const CANDLE_LOOKBACK_MS = 4 * 60 * 60 * 1000;
const LEADER_WINDOW_HOURS = 24;

async function coinAdvisory(coin: string, now: number): Promise<CoinAdvisory> {
  try {
    const res = await fetchCandles(coin, '15m', now - CANDLE_LOOKBACK_MS, now);
    if (res.stale) return { coin, momentumStallLong: null, momentumStallShort: null };
    const indicators = await computeMomentumIndicators(coin, res.candles, now);
    return {
      coin,
      momentumStallLong: indicators?.[MOMENTUM_STALL_LONG] ?? null,
      momentumStallShort: indicators?.[MOMENTUM_STALL_SHORT] ?? null,
    };
  } catch {
    return { coin, momentumStallLong: null, momentumStallShort: null };
  }
}

async function loadEventWindow(now: number): Promise<EventWindowState> {
  try {
    const raw = await readFile(path.join(process.cwd(), 'data', 'events', 'macro-calendar.json'), 'utf8');
    return eventWindowState(parseCalendar(JSON.parse(raw)), now);
  } catch {
    // A missing/corrupt calendar means NO window — consumers fail open (no
    // warning), never a wrong block.
    return { next: null, hoursToPrint: null, inWindow: false };
  }
}

async function loadLeaderFlow(coins: string[], now: number): Promise<LeaderFlowSummary | null> {
  try {
    const client = getServiceRoleClient();
    const since = new Date(now - LEADER_WINDOW_HOURS * 3_600_000).toISOString();
    const { data, error } = await client
      .from('leader_actions')
      .select('coin, kind')
      .gte('detected_at', since)
      .in('coin', coins)
      .limit(1000);
    if (error) return null;
    const byCoin: LeaderFlowSummary['byCoin'] = {};
    for (const r of data ?? []) {
      const row = r as { coin: string; kind: string };
      const c = (byCoin[row.coin] ??= { opens: 0, closes: 0, adds: 0, reduces: 0 });
      if (row.kind === 'open') c.opens++;
      else if (row.kind === 'close') c.closes++;
      else if (row.kind === 'add') c.adds++;
      else if (row.kind === 'reduce') c.reduces++;
    }
    return { windowHours: LEADER_WINDOW_HOURS, byCoin };
  } catch {
    return null;
  }
}

/** Build the advisory snapshot for the requested coins. Fail-soft per section. */
export async function buildMarketStateAdvisory(coins: string[], now = Date.now()): Promise<MarketStateAdvisory> {
  const normalized = coins.map((c) => c.trim().toUpperCase()).filter(Boolean).slice(0, 6);
  const [coinStates, eventWindow, leaderFlow] = await Promise.all([
    Promise.all(normalized.map((c) => coinAdvisory(c, now))),
    loadEventWindow(now),
    loadLeaderFlow(normalized, now),
  ]);
  return {
    generatedAt: now,
    coins: coinStates,
    eventWindow,
    leaderFlow,
    note:
      'ADVISORY ONLY (read-only bridge). momentumStall 0-3 flips on 15m HL data; 2+ = stalling. ' +
      'eventWindow.inWindow = within 12h before / 1h after the next macro print. ' +
      'null sections = data unavailable — consumers must fail open.',
  };
}
