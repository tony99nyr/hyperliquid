/**
 * Scout exit enforcement (I/O) — the daemon-side executor of the FROZEN lane exits
 * (Tier-2, 08-20). Each producer tick it loads the scout's open paper positions and
 * closes, mechanically, any that hit their pre-registered exit:
 *   every tick        → the hard stop (mark vs positions.stop_px — needs only mids);
 *   lane-scan ticks   → htf-trend 10d-channel close-through, compression BB-mid
 *                       close-through (daily/4h candle scans, run on the caller's
 *                       subcadence), leader-follow 72h time-stop.
 * Execution reuses `pnpm scout:trade --exit` as a CHILD PROCESS so every close gets
 * the full bookkeeping path (hypothesis resolution, session hygiene, fills ledger,
 * paper-mode hard guard) with zero duplication — the same pattern as the embedded
 * consumer. The model no longer has to obey exit rules; the daemon executes them.
 *
 * HONEST LIMITS (documented, deliberate):
 *  - leader-follow's "leader exited/flipped" leg stays MODEL-side: position rows don't
 *    record WHICH leader was followed, and "any leader" would silently change the
 *    frozen rule. The daemon enforces its stop + 72h time-stop. (Future: store the
 *    leader address at open, then enforce.)
 *  - rubric lanes (GO-drop exit) stay model-side pending a rubric read here.
 *  - NO event-flatten: the running forward tests were frozen without one (see the
 *    business-logic header — changing exits mid-test is the p-hack we forbid).
 * Fail-soft everywhere: an enforcement error logs and never breaks the daemon tick.
 * A decided exit that fails to EXECUTE retries next tick (positions stay open until
 * scout-trade actually closes them — idempotent by construction).
 */

import { execFile } from 'node:child_process';
import { getServiceRoleClient } from '@/lib/cockpit/supabase-server';
import { fetchAllMids } from '@/lib/hyperliquid/hyperliquid-info-service';
import {
  decideEnforcedExit,
  type EnforceablePosition,
  type ExitDecision,
} from './scout-exit-enforcement-business-logic';
import { scanHtfTrend } from './htf-trend-scan-service';
import { scanCompressionSqueezes } from './compression-scan-service';
import type { HtfTrendRead } from './htf-trend-signal-business-logic';
import type { CompressionRead } from './compression-squeeze-signal-business-logic';

export interface EnforcementResult {
  checked: number;
  /** Exits DECIDED this tick (execution is async-verified by the position closing). */
  exits: Array<{ coin: string; lane: string | null; reason: ExitDecision['reason']; detail: string }>;
  /** Coins whose lane scan was unavailable (held safe — a missing read never exits). */
  scanGaps: string[];
  errors: string[];
}

/** In-flight closes keyed `${sessionId}:${coin}` → spawn epoch-ms. A Map (not a Set)
 *  so a HUNG child can be aged out: execFile's timeout SIGTERMs only the pnpm wrapper —
 *  a surviving tsx grandchild keeps the stdio pipes open, the 'close' callback never
 *  fires, and a Set entry would pin that position's enforcement dead until restart
 *  (review 08-20 H). SIGKILL + the age-out below close both halves of that. */
const inFlight = new Map<string, number>();
const IN_FLIGHT_MAX_AGE_MS = 10 * 60_000;

/** Consecutive-failure backoff per position: a permanently-failing close is the
 *  dead-enforcement signature (e.g. a mode misconfig) — retrying every 120s tick
 *  forever spawns heavy pnpm+tsx children and buries the signal in warns. Backoff
 *  grows with the count; ≥3 straight failures escalates to console.error. */
const failState = new Map<string, { count: number; nextRetryAtMs: number }>();

const EXIT_CHILD_TIMEOUT_MS = 120_000;

/** Spawn `pnpm scout:trade --exit` for one position. Resolves true on exit-code 0.
 *  TRADING_MODE is pinned to 'paper' EXPLICITLY: the child otherwise inherits the
 *  daemon env + .env.local, and enforcement worked only while BOTH happened to lack
 *  TRADING_MODE (the repo's own docs say local is 'live' — one env:pull would have
 *  killed every enforced exit at assertScoutPaperMode; review 08-20 H1). The scout
 *  is paper BY DEFINITION — pinning it here is the definition, not an override.
 *  (systemd note: 'pnpm' rides the daemon's PATH — use an absolute path when the
 *  daemon moves under a supervisor with a minimal environment.) */
function executeExit(sessionId: string, coin: string, note: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = execFile(
      'pnpm',
      ['--silent', 'scout:trade', '--', '--exit', '--session', sessionId, '--coin', coin, '--note', note],
      {
        cwd: process.cwd(),
        timeout: EXIT_CHILD_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        env: { ...process.env, TRADING_MODE: 'paper' },
      },
      (err) => resolve(!err),
    );
    child.on('error', () => resolve(false));
  });
}

interface PosRow {
  session_id: string;
  coin: string;
  side: string;
  sz: unknown;
  avg_entry_px: unknown;
  stop_px: unknown;
  lane: string | null;
  opened_at: string | null;
}

/** Open scout paper positions with everything the enforcer needs. Fail-soft []. */
async function loadEnforceablePositions(): Promise<EnforceablePosition[]> {
  const db = getServiceRoleClient();
  const { data, error } = await db
    .from('positions')
    .select('session_id, coin, side, sz, avg_entry_px, stop_px, lane, opened_at, sessions!inner(mode)')
    .eq('sessions.mode', 'paper')
    .in('side', ['long', 'short'])
    .gt('sz', 0);
  if (error) throw new Error(`enforcement position read failed: ${error.message}`);
  return ((data ?? []) as unknown as PosRow[]).map((r) => ({
    sessionId: r.session_id,
    coin: r.coin.toUpperCase(),
    side: r.side === 'short' ? 'short' : 'long',
    lane: r.lane ? r.lane.toLowerCase() : null,
    entryPx: Number(r.avg_entry_px) || 0,
    stopPx: r.stop_px != null && Number(r.stop_px) > 0 ? Number(r.stop_px) : null,
    openedAtMs: r.opened_at ? Date.parse(r.opened_at) : null,
  }));
}

/**
 * Run one enforcement pass. `runLaneScans` gates the candle-scan exits (the caller
 * runs them on a subcadence — stop checks are every-tick, scans every ~15min).
 */
export async function runExitEnforcement(now: number, runLaneScans: boolean): Promise<EnforcementResult> {
  const result: EnforcementResult = { checked: 0, exits: [], scanGaps: [], errors: [] };

  let positions: EnforceablePosition[];
  try {
    positions = await loadEnforceablePositions();
  } catch (e) {
    result.errors.push(e instanceof Error ? e.message : String(e));
    return result;
  }
  if (positions.length === 0) return result;
  result.checked = positions.length;

  // Marks for the stop checks — fail-soft null (a missing mark skips the stop check
  // for that coin this tick, never exits blind).
  const mids = await fetchAllMids().catch(() => null);

  // Lane scans only when due AND a position needs them (no idle candle load).
  const htfByCoin = new Map<string, HtfTrendRead>();
  const compByCoin = new Map<string, CompressionRead>();
  if (runLaneScans) {
    const htfCoins = [...new Set(positions.filter((p) => p.lane === 'htf-trend').map((p) => p.coin))];
    const compCoins = [...new Set(positions.filter((p) => p.lane === 'compression-straddle').map((p) => p.coin))];
    if (htfCoins.length > 0) {
      const scan = await scanHtfTrend(htfCoins, now).catch(() => null);
      for (const r of scan?.reads ?? []) htfByCoin.set(r.coin, r);
    }
    if (compCoins.length > 0) {
      const scan = await scanCompressionSqueezes(compCoins, now).catch(() => null);
      for (const r of scan?.reads ?? []) compByCoin.set(r.coin, r);
    }
  }

  for (const pos of positions) {
    const key = `${pos.sessionId}:${pos.coin}`;
    const startedAt = inFlight.get(key);
    if (startedAt != null) {
      if (now - startedAt < IN_FLIGHT_MAX_AGE_MS) continue;
      // Aged out: the child hung past every timeout — reclaim so enforcement retries.
      inFlight.delete(key);
      console.warn(`[exit-enforcer] ${key} in-flight close aged out after ${Math.round((now - startedAt) / 60_000)}min — reclaiming`);
    }
    const fs = failState.get(key);
    if (fs && now < fs.nextRetryAtMs) continue; // backing off a failing close
    const mark = mids ? Number(mids[pos.coin]) || null : null;
    if (runLaneScans && ((pos.lane === 'htf-trend' && !htfByCoin.has(pos.coin)) || (pos.lane === 'compression-straddle' && !compByCoin.has(pos.coin)))) {
      result.scanGaps.push(pos.coin);
    }
    const decision = decideEnforcedExit(
      pos,
      mark,
      {
        htf: htfByCoin.get(pos.coin) ?? null,
        compression: compByCoin.get(pos.coin) ?? null,
        // leader-gone stays model-side (see header); the pure layer only time-stops.
        leaderFollow: pos.lane === 'leader-follow' ? { leaderStillHolding: null } : null,
      },
      now,
    );
    if (!decision) continue;

    result.exits.push({ coin: pos.coin, lane: pos.lane, reason: decision.reason, detail: decision.detail });
    inFlight.set(key, now);
    const note = `AUTO-EXIT (daemon-enforced frozen rule): ${decision.reason} — ${decision.detail}`;
    void executeExit(pos.sessionId, pos.coin, note)
      .then((ok) => {
        if (ok) {
          failState.delete(key);
          return;
        }
        const prev = failState.get(key);
        const count = (prev?.count ?? 0) + 1;
        // Linear backoff, capped ~16min: retries persist but stop hammering.
        failState.set(key, { count, nextRetryAtMs: Date.now() + Math.min(count, 8) * 120_000 });
        if (count >= 3) {
          console.error(`[exit-enforcer] ${pos.coin} ${decision.reason} close FAILED ${count}x IN A ROW — enforcement may be dead (mode misconfig? scout-trade error?); investigate`);
        } else {
          console.warn(`[exit-enforcer] ${pos.coin} ${decision.reason} close FAILED (attempt ${count}) — backing off then retrying`);
        }
      })
      .finally(() => inFlight.delete(key));
  }

  return result;
}
