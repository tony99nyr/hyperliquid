/**
 * pnpm scout:cycle — gather the decision snapshot for the (cheap-model) scout.
 *
 * NEVER trades + NEVER decides. It assembles everything the scout needs to reason in
 * ONE place: unconsumed triggers (from the ScoutTriggerSink, cursor-stamped so churn
 * doesn't re-surface), the latest rubric reads, fresh marks, funding/OI, vaults, open
 * paper positions, the circuit breaker, the hypothesis track record, and the playbook
 * pointer.
 *
 * Two renderings of the SAME snapshot:
 *   - default: human/model-readable prose (the interactive scout session).
 *   - --json:  one machine-readable JSON object on stdout (the HEADLESS contract —
 *     scripts/scout-headless.sh pipes it to a `claude -p` decision, whose output goes
 *     to `pnpm scout:trade --from-json`). See .claude/skills/scout/SKILL.md.
 *
 * Each run upserts a CONSUMER heartbeat (source 'scout-cycle') — a dead consumer is
 * visible in the cockpit instead of masquerading as "0 triggers" (the Jun-24 lesson).
 */

import { existsSync } from 'node:fs';
import { header, line, run } from './_skill-runtime';
import { getServiceRoleClient } from '@/lib/cockpit/supabase-server';
import { fetchMetaAndAssetCtxs } from '@/lib/hyperliquid/hyperliquid-info-service';
import { gatherScoutInputs, writeScoutHeartbeat } from '@/lib/scout/scout-watch-service';
import { recentTriggers, markTriggersConsumed, pruneConsumedTriggers, type SinkTrigger } from '@/lib/scout/scout-trigger-sink';
import { checkCircuitBreaker } from '@/lib/risk/circuit-breaker-service';
import { scoutPlaybookPath, summarizeHypotheses, type HypothesisSummaryRow } from '@/lib/scout/scout-cycle-business-logic';
import { gatherScoutContext } from '@/lib/scout/scout-context-service';
import { listLaddersWithRungs } from '@/lib/ladder/ladder-service';
import { fetchClearinghouseState } from '@/lib/hyperliquid/hyperliquid-info-service';
import { getHlAccountAddress } from '@/lib/auto-exit/auto-exit-config';
import { DEFAULT_REVERSION_CONFIG } from '@/lib/scout/reversion-signal-business-logic';

interface VaultRow { vault_address: string; name: string; kind: string; nav_usd: number | null; apr_annual: number | null; max_drawdown_pct: number | null; age_days: number | null; leader_fraction: number | null }

run(async () => {
  const jsonMode = process.argv.includes('--json');
  const now = Date.now();

  // 1) Read UNCONSUMED triggers (the wake reasons) — claimed AFTER the gather succeeds,
  // so a crash mid-gather leaves them for the next wake (consume-late).
  const candidates: SinkTrigger[] = await recentTriggers(12, { unconsumedOnly: true });

  // 2) Deterministic reads: rubric + marks + open paper positions (+ degradation gate).
  const inputs = await gatherScoutInputs(now);

  // 3) ATOMIC claim: only rows WE stamped are ours (a concurrent consumer gets a disjoint
  // set — no double-trade on the same signal). Unclaimed rows are dropped from THIS view.
  const claimed = await markTriggersConsumed(candidates.map((t) => t.id), now);
  const triggers = candidates.filter((t) => t.id == null || claimed.has(t.id));
  // Retention: keep the table bounded (consumed rows older than 14d), like JSONL rotation.
  await pruneConsumedTriggers(14 * 24 * 3_600_000, now);

  // 3) Funding / OI / premium context (judgment inputs, not auto-scored).
  const ctxs = await fetchMetaAndAssetCtxs().catch(() => ({} as Record<string, { fundingHourly: number; openInterest: number; premium: number }>));
  const fundingCtx = inputs.marks
    .filter((m) => ctxs[m.coin])
    .map((m) => ({ coin: m.coin, fundingHourly: ctxs[m.coin].fundingHourly, openInterest: ctxs[m.coin].openInterest, premium: ctxs[m.coin].premium }));

  // 3b) Advisory context (tape / leaders / AF / percentiles) — the same signal
  // surface the human desk uses, framed for judgment. Fail-soft per section:
  // a missing part is null/[], never a blocked cycle. NOT auto-scored.
  const db = getServiceRoleClient();
  const context = await gatherScoutContext(
    inputs.marks.map((m) => m.coin),
    new Map(fundingCtx.map((c) => [c.coin, c.fundingHourly])),
    new Map(fundingCtx.map((c) => [c.coin, c.openInterest])),
    now,
    db,
  ).catch(() => ({ tape: [], leaders: [], afHypePerDay: null, percentiles: [] }));

  // 3b-ii) REGIME + REVERSION SCAN. The reversion lane (pre-registered Jul-20)
  // fades a STATISTICALLY EXTREME 15m stretch — but ONLY in a non-trending regime
  // (today's backtest: fading a confident trend loses). Phase 1 (Jul-21) gates it
  // with the vendored iamrossi detector on 4h HL candles (the same robust brain
  // the trend system uses, run
  // coupling-free on our own data). Surfaced for the operator's insight AND used
  // as the authoritative gate on the reversion lane below (never fade a confident
  // trend). Fail-soft per coin.
  const regimeByCoin: Record<string, { regime: 'bullish' | 'bearish' | 'neutral'; confidence: number; trend: number }> = {};
  const reversionHits: Array<{ coin: string; side: 'long' | 'short'; z: number; er: number; regime: string; regimeConf: number; mark: number; stop: number; target: number; stopFrac: number }> = [];
  try {
    const { fetchCandles: fc } = await import('@/lib/hyperliquid/candle-service');
    const { reversionSignal } = await import('@/lib/scout/reversion-signal-business-logic');
    const { detectMarketRegime } = await import('@/lib/strategy/analysis/market-regime-detector');
    const scanCoins = inputs.marks.map((m) => m.coin).slice(0, 6);
    for (const coin of scanCoins) {
      try {
        // 4h regime (the vendored detector needs currentIndex ≥ 50, so ≥51 COMPLETED
        // bars ⇒ ≥52 raw after dropping the in-progress bar; below that it returns
        // neutral/0 which would silently un-gate the fade). Its own try so a 4h read
        // blip degrades to efficiency-only reversion, not a dropped coin. NOTE: this
        // runs the vendored SNAPSHOT of iamrossi's detector — faithful to that logic,
        // frozen at vendor time (it can drift from iamrossi's live tuning; that's the
        // correct coupling-free trade-off).
        let regimeGate: { regime: 'bullish' | 'bearish' | 'neutral'; confidence: number } | undefined;
        try {
          const reg4h = await fc(coin, '4h', now - 45 * 24 * 3_600_000, now);
          if (!reg4h.stale && reg4h.candles.length >= 52) {
            const completed = reg4h.candles.slice(0, -1);
            const sig = detectMarketRegime(completed, completed.length - 1);
            regimeByCoin[coin] = { regime: sig.regime, confidence: sig.confidence, trend: sig.indicators.trend };
            regimeGate = { regime: sig.regime, confidence: sig.confidence };
          }
        } catch { /* 4h read failed → efficiency-only reversion (never un-gates a trend) */ }
        // 15m reversion, GATED by the 4h regime.
        const res = await fc(coin, '15m', now - 30 * 3_600_000, now);
        if (res.stale || res.candles.length < 120) continue;
        const bars = res.candles.slice(0, -1).map((c) => ({ highPx: c.high, lowPx: c.low, closePx: c.close }));
        const revSig = reversionSignal(bars, undefined, regimeGate);
        if (revSig) reversionHits.push({ coin, side: revSig.side, z: revSig.zScore, er: revSig.efficiency, regime: revSig.regimeLabel, regimeConf: revSig.regimeConfidence, mark: revSig.markPx, stop: revSig.stopPx, target: revSig.targetPx, stopFrac: revSig.stopFrac });
      } catch { /* per-coin fail-soft */ }
    }
  } catch { /* scan unavailable → section just prints empty */ }

  // 3c) READ-ONLY live book (the STEWARD lane): the scout may SEE the live positions
  // + armed ladders to PROPOSE ladder management — it can never touch them (the
  // execution path asserts paper sessions; proposals go to Discord + the log only).
  let liveBook: {
    positions: Array<{ coin: string; side: string; sz: number; entryPx: number | null; unrealizedPnl: number; momentumStallLong?: number | null; momentumStallShort?: number | null; healthScore?: number | null; healthAgeMin?: number | null }>;
    armedLadders: Array<{ id8: string; title: string; coins: string[]; rungs: Array<{ seq: number; action: string; triggerKind: string; triggerPx: number | null; status: string }> }>;
  } = { positions: [], armedLadders: [] };
  try {
    const addr = getHlAccountAddress();
    const [ch, armed] = await Promise.all([
      addr ? fetchClearinghouseState(addr) : Promise.resolve(null),
      listLaddersWithRungs('armed'),
    ]);
    liveBook = {
      positions: (ch?.positions ?? []).map((pos) => ({ coin: pos.coin, side: pos.side, sz: pos.size, entryPx: pos.entryPx, unrealizedPnl: pos.unrealizedPnl })),
      armedLadders: (armed ?? []).map((l) => ({
        id8: l.id.slice(0, 8),
        title: l.title.slice(0, 60),
        coins: [...new Set(l.rungs.map((r) => r.coin.toUpperCase()))],
        rungs: l.rungs.map((r) => ({ seq: r.seq, action: r.action, triggerKind: r.triggerKind, triggerPx: r.triggerPx, status: r.status })),
      })),
    };
    // MID-TRADE INSPECTION (Jul-17, operator ask): give the steward the SAME
    // momentum composite the ladder engine trades on + the health engine's read,
    // per live-book coin — so "turning out of favor / into favor" is evidence,
    // not vibes. READ-ONLY enrichment; every piece fail-soft to null.
    const bookCoins = [...new Set([...liveBook.positions.map((p) => p.coin.toUpperCase()), ...liveBook.armedLadders.flatMap((l) => l.coins)])].slice(0, 5);
    if (bookCoins.length > 0) {
      const { fetchCandles } = await import('@/lib/hyperliquid/candle-service');
      const { computeMomentumIndicators } = await import('@/lib/ladder/ladder-momentum-service');
      const { MOMENTUM_STALL_LONG, MOMENTUM_STALL_SHORT } = await import('@/lib/ladder/ladder-types');
      const stallByCoin: Record<string, { long: number | null; short: number | null }> = {};
      for (const coin of bookCoins) {
        try {
          const res = await fetchCandles(coin, '15m', now - 4 * 3_600_000, now);
          const ind = res.stale ? null : await computeMomentumIndicators(coin, res.candles, now);
          stallByCoin[coin] = { long: ind?.[MOMENTUM_STALL_LONG] ?? null, short: ind?.[MOMENTUM_STALL_SHORT] ?? null };
        } catch { stallByCoin[coin] = { long: null, short: null }; }
      }
      // Latest health-engine read per coin (any LIVE session — the watch daemon
      // writes these; stale/absent → null. Session ids never leave this scope.)
      const healthByCoin: Record<string, { score: number; ageMin: number }> = {};
      try {
        const { data: liveSess } = await db.from('sessions').select('id').eq('mode', 'live');
        const liveIds = (liveSess ?? []).map((x) => (x as { id: string }).id);
        if (liveIds.length > 0) {
          const { data: hs } = await db
            .from('health_snapshots')
            .select('coin, score, created_at')
            .in('session_id', liveIds)
            .order('created_at', { ascending: false })
            .limit(30);
          for (const h of hs ?? []) {
            const row = h as { coin: string; score: number; created_at: string };
            const c = row.coin.toUpperCase();
            if (!healthByCoin[c]) healthByCoin[c] = { score: Number(row.score), ageMin: (now - Date.parse(row.created_at)) / 60_000 };
          }
        }
      } catch { /* health absent → null */ }
      for (const p of liveBook.positions) {
        const c = p.coin.toUpperCase();
        p.momentumStallLong = stallByCoin[c]?.long ?? null;
        p.momentumStallShort = stallByCoin[c]?.short ?? null;
        p.healthScore = healthByCoin[c]?.score ?? null;
        p.healthAgeMin = healthByCoin[c] ? Math.round(healthByCoin[c].ageMin) : null;
      }
    }
  } catch { /* fail-soft: steward context absent → the scout just doesn't propose */ }

  // 4) Vaults (Lane A allocation candidates — newest snapshot per vault).
  const { data: vaultRows } = await db
    .from('vault_snapshots')
    .select('vault_address, name, kind, nav_usd, apr_annual, max_drawdown_pct, age_days, leader_fraction, fetched_at')
    .order('fetched_at', { ascending: false })
    .limit(50);
  const latestByVault = new Map<string, VaultRow>();
  for (const v of (vaultRows ?? []) as VaultRow[]) if (!latestByVault.has(v.vault_address)) latestByVault.set(v.vault_address, v);
  const vaults = [...latestByVault.values()];

  // 5) Circuit breaker (HALTED ⇒ no new entries; exits always allowed).
  const breaker = await checkCircuitBreaker('scout', now);

  // 6) Track record (scout sessions only — self-assessment excludes manual trades).
  // Robust identity (Jul-16 review): the archived title made this return [] — every
  // cycle ran with NO self-memory. Resolve scout sessions properly.
  const { scoutSessionIds } = await import('@/lib/scout/scout-session-service');
  const scoutIds = await scoutSessionIds(db);
  let hypRows: HypothesisSummaryRow[] = [];
  if (scoutIds.length > 0) {
    const { data } = await db
      .from('hypotheses')
      .select('statement, status, resolution_note, created_at, resolved_at')
      .eq('excluded', false) // janitorial rows poison self-memory (Jul-16 quarantine)
      .in('session_id', scoutIds)
      .order('created_at', { ascending: false })
      .limit(30);
    hypRows = (data ?? []) as HypothesisSummaryRow[];
  }
  const summary = summarizeHypotheses(hypRows);
  const playbookPath = scoutPlaybookPath();

  // CONSUMER liveness — distinct from the producer's 'scout-watch' row. A dead consumer
  // is now a stale row in the cockpit, not silence.
  await writeScoutHeartbeat(inputs.degraded ? 'degraded' : 'ok', `${triggers.length} trigger(s) consumed${inputs.degraded ? ` — ${inputs.degradedReason}` : ''}`, 'scout-cycle', now);

  if (jsonMode) {
    // The HEADLESS contract: one JSON object, stable field names. The decision model
    // replies with {action:'open'|'close'|'stand-down', ...} → scout:trade --from-json.
    const snapshot = {
      at: new Date(now).toISOString(),
      degraded: inputs.degraded,
      degradedReason: inputs.degradedReason,
      triggers: triggers.map((t) => ({ kind: t.kind, coin: t.coin, side: t.side ?? null, urgency: t.urgency, detail: t.detail, at: new Date(t.at).toISOString() })),
      rubric: inputs.rubric.map((r) => ({ coin: r.coin, side: r.side, opportunity: Math.round(r.opportunity), badge: r.badge })),
      // Higher-TF (4h) regime per scan coin — the vendored iamrossi detector, run
      // coupling-free on HL candles. Gates the reversion lane + a trend-follow input.
      regime: regimeByCoin,
      // Extreme-reversion FADE candidates (pre-registered paper lane 'reversion',
      // setupType 'reversion-extreme'). Empty in a trending tape by design.
      reversion: reversionHits,
      marks: inputs.marks,
      funding: fundingCtx,
      // Advisory context (see docs/SIGNAL_ROADMAP.md): tape flow is a POINT sample
      // (null = not measured, never 0); percentiles frame funding/OI against the
      // coin's OWN recorded history; leaders = the trader-watch whale book.
      tape: context.tape,
      leaders: context.leaders,
      afHypePerDay: context.afHypePerDay,
      percentiles: context.percentiles,
      // READ-ONLY steward context: the LIVE book. You may PROPOSE ladder changes
      // ({action:'propose', title, body, coin?}) — you can NEVER trade/touch these.
      liveBook,
      vaults,
      positions: inputs.positions,
      circuitBreaker: { halted: breaker.blockNewEntries, reason: breaker.reason, equityUsd: breaker.equityUsd, peakEquityUsd: breaker.peakEquityUsd, dayStartEquityUsd: breaker.dayStartEquityUsd, flattenRecommended: breaker.flattenRecommended },
      trackRecord: { open: summary.open, confirmed: summary.confirmed, invalidated: summary.invalidated, resolved: summary.resolved, lastResolved: summary.lastResolved },
      playbookPath: existsSync(playbookPath) ? playbookPath : null,
    };
    // Raw stdout (no header/line decoration) — this IS the machine contract.
    console.log(JSON.stringify(snapshot));
    return;
  }

  header(`scout:cycle — decision snapshot @ ${new Date(now).toISOString()}`);
  line('NEVER trades. Read this, consult the playbook, then decide per the scout skill.');

  header('TRIGGERS (unconsumed — your wake reasons; now cursor-stamped)');
  if (triggers.length === 0) line('(none — heartbeat wake; do a routine review)');
  else triggers.forEach((t) => line(`${new Date(t.at).toISOString()} [${t.urgency}] ${t.kind} ${t.coin}${t.side ? ` ${t.side}` : ''} — ${t.detail}`));

  if (inputs.degraded) {
    header('⏸ FEED DEGRADED — STAND DOWN');
    line(`Reason: ${inputs.degradedReason}. Do NOT open a trade on this snapshot.`);
    line('Manage existing positions conservatively (favor safety); wait for a fresh feed before any entry.');
  }
  header('RUBRIC (newest per coin×side)');
  inputs.rubric
    .slice()
    .sort((a, b) => b.opportunity - a.opportunity)
    .forEach((r) => line(`${r.coin} ${r.side.padEnd(5)} opp=${Math.round(r.opportunity)} ${r.badge}`));

  header('REGIME (4h, vendored iamrossi detector — TREND vs range background)');
  if (Object.keys(regimeByCoin).length === 0) line('(regime read unavailable this cycle)');
  for (const [coin, r] of Object.entries(regimeByCoin)) line(`${coin}: ${r.regime.toUpperCase()} conf=${(r.confidence * 100).toFixed(0)}% trend=${r.trend.toFixed(2)}  ${r.regime !== 'neutral' && r.confidence >= DEFAULT_REVERSION_CONFIG.maxTrendConfidence ? '→ CONFIDENT TREND (reversion lane skips; trend-follow candidate)' : '→ range/neutral (reversion lane active)'}`);

  header('REVERSION SCAN (extreme-stretch FADE candidates — PAPER lane reversion-extreme; 4h-regime-gated)');
  if (reversionHits.length === 0) line('(none — no coin is extremely stretched in a range regime; trending tape correctly yields nothing)');
  for (const h of reversionHits) line(`${h.coin} FADE ${h.side.toUpperCase()} (z=${h.z.toFixed(1)}, ER=${h.er.toFixed(2)}, 4h-regime=${h.regime}/${(h.regimeConf * 100).toFixed(0)}%)  mark=${h.mark} stop=${h.stop.toFixed(4)} target=${h.target.toFixed(4)} stopFrac=${(h.stopFrac * 100).toFixed(1)}%  -> if taken: lane 'reversion', setupType 'reversion-extreme'`);

  header('MARKS');
  inputs.marks.forEach((m) => line(`${m.coin} = ${m.markPx}`));

  header('FUNDING / OI / PREMIUM (context — for judgment, not auto-scored)');
  for (const c of fundingCtx) {
    const apr = (c.fundingHourly * 24 * 365 * 100).toFixed(1);
    const who = c.fundingHourly >= 0 ? 'longs pay / shorts earn' : 'shorts pay / longs earn';
    line(`${c.coin}  funding ${(c.fundingHourly * 100).toFixed(4)}%/h (~${apr}% APR; ${who})  OI=${Math.round(c.openInterest)}  premium=${(c.premium * 100).toFixed(3)}%`);
  }

  header('TAPE (advisory — flow is a POINT sample; null = not measured, never 0)');
  if (context.tape.length === 0) line('(unavailable)');
  else for (const t of context.tape) {
    const flow = t.takerFlow != null ? (t.takerFlow >= 0 ? '+' : '') + t.takerFlow.toFixed(2) : '—';
    const imb = t.bookImbalance != null ? (t.bookImbalance >= 0 ? '+' : '') + t.bookImbalance.toFixed(2) : '—';
    line(`${t.coin}  takerFlow=${flow}  bookImbalance=${imb} (+=bid-heavy)  spread=${t.spreadBps != null ? t.spreadBps.toFixed(1) + 'bps' : '—'}`);
  }

  header('LEADER BOOK (rated whales, trader-watch feed — decompose before trusting)');
  if (context.leaders.length === 0) line('(no leader positions in universe)');
  else for (const l of context.leaders) {
    line(`${l.coin}  long $${(l.longUsd / 1e6).toFixed(2)}M (${l.longWallets}w)  short $${(l.shortUsd / 1e6).toFixed(2)}M (${l.shortWallets}w)  top=${l.topWalletSide ?? '—'} $${(l.topWalletUsd / 1e6).toFixed(2)}M`);
  }

  header('FUNDING/OI PERCENTILES (vs the coin\'s own recorded history)');
  if (context.percentiles.length === 0) line('(series unavailable)');
  else for (const p of context.percentiles) {
    const pct = (v: number | null) => (v != null ? Math.round(v * 100) + 'th' : '— (thin series)');
    line(`${p.coin}  funding ${pct(p.fundingPctile)}  OI ${pct(p.oiPctile)}  (n=${p.sampleCount})`);
  }
  if (context.afHypePerDay != null) line(`AF buyback ≈ ${Math.round(context.afHypePerDay).toLocaleString('en-US')} HYPE/24h (procyclical — context only, never a floor)`);

  header('LIVE BOOK (READ-ONLY — steward lane: PROPOSE ladder changes, never touch)');
  if (liveBook.positions.length === 0 && liveBook.armedLadders.length === 0) line('(flat, no armed ladders)');
  for (const pos of liveBook.positions) {
    const stall = pos.momentumStallLong != null || pos.momentumStallShort != null
      ? `  stall L${pos.momentumStallLong ?? '?'}/S${pos.momentumStallShort ?? '?'} (2+ = that side's momentum dying)` : '';
    const health = pos.healthScore != null ? `  health ${Math.round(pos.healthScore)}/100 (${pos.healthAgeMin}m old)` : '';
    line(`${pos.coin} ${pos.side} ${pos.sz} @ ${pos.entryPx ?? '?'} uPnL $${pos.unrealizedPnl.toFixed(2)}${stall}${health}`);
  }
  for (const l of liveBook.armedLadders) line(`ladder ${l.id8} "${l.title}" — ${l.rungs.map((r) => `${r.seq}:${r.action}${r.triggerPx != null ? `@${r.triggerPx}` : ''}(${r.status})`).join(' ')}`);
  if (liveBook.positions.length > 0 || liveBook.armedLadders.length > 0) {
    line('STEWARD REVIEW DUTY: for EACH live position/armed ladder above, weigh stall counts,');
    line('health, tape/percentiles: is the trade turning OUT of favor (stall 2+ against it,');
    line('health <40 and falling, tape flipped) or INTO favor (momentum clean, health rising)?');
    line('If 2+ signals agree, PROPOSE a CONCRETE amendment (tighten ratchet to X / bank early');
    line('at Y / disarm Z / widen target W) — a specific 💡 beats silence. One proposal max.');
  }

  header('VAULTS (Lane A — allocation candidates; nav = total AUM, judge on apr/return)');
  if (vaults.length === 0) line('(no vault snapshots yet — wait for the nas-watch tick / run pnpm vault-watch --once)');
  else for (const v of vaults) {
    const pct = (x: number | null, d = 2) => (x != null ? `${(x * 100).toFixed(d)}%` : '?');
    line(`${v.name} [${v.kind}]  NAV $${v.nav_usd != null ? Math.round(v.nav_usd).toLocaleString('en-US') : '?'}  apr ${pct(v.apr_annual)}  dd ${pct(v.max_drawdown_pct, 1)}  age ${v.age_days != null ? Math.round(v.age_days) + 'd' : '?'}  leaderStake ${pct(v.leader_fraction)}`);
  }

  header('OPEN PAPER POSITIONS');
  if (inputs.positions.length === 0) line('(flat — no open positions)');
  else inputs.positions.forEach((p) => line(`${p.coin} ${p.side} health=${p.healthScore ?? '—'} mark=${p.markPx}`));

  header('CIRCUIT BREAKER');
  line(`equity=$${breaker.equityUsd.toFixed(0)} (peak $${breaker.peakEquityUsd.toFixed(0)}, dayStart $${breaker.dayStartEquityUsd.toFixed(0)})`);
  line(breaker.blockNewEntries ? `⛔ HALTED — ${breaker.reason} → NO new entries${breaker.flattenRecommended ? ' + flatten recommended' : ''}` : `✓ ${breaker.reason}`);

  header('TRACK RECORD (recent hypotheses)');
  line(`open=${summary.open}  confirmed=${summary.confirmed}  invalidated=${summary.invalidated}  resolved=${summary.resolved}`);
  if (summary.lastResolved.length > 0) {
    line('last resolved:');
    summary.lastResolved.forEach((h) => line(`  [${h.status}] ${h.statement}${h.resolutionNote ? ` — ${h.resolutionNote}` : ''}`));
  }

  header('PLAYBOOK');
  line(existsSync(playbookPath) ? `Read + apply: ${playbookPath}` : `(missing — create ${playbookPath})`);

  header('NEXT');
  line('Decide per .claude/skills/scout/SKILL.md. Trade (paper) only if a setup clears the bar; else stand down + note why.');
});
