/** Reconcile the outcome ledger. Dry-run by default; --write requires --backup PATH. */
import { writeFileSync } from 'node:fs';
import { listLaddersWithRungs } from '@/lib/ladder/ladder-service';
import { outcomeFires } from '@/lib/ladder/ladder-outcome-service';
import { attributeLadderFills, attributionInvariantFailures } from '@/lib/ladder/ladder-outcome-business-logic';
import { resolveLadderOutcome } from '@/lib/skills/ladder-expectancy-business-logic';
import { resolveArmRung } from '@/lib/ladder/ladder-arm-business-logic';
import { computeLadderRisk } from '@/lib/ladder/ladder-risk-business-logic';
import { fetchAllFills, fetchClearinghouseState } from '@/lib/hyperliquid/hyperliquid-info-service';
import { getHlAccountAddress } from '@/lib/auto-exit/auto-exit-config';
import { getServiceRoleClient } from '@/lib/cockpit/supabase-server';

try { process.loadEnvFile('.env.local'); } catch { /* Environment may already be set. */ }

function option(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

async function main(): Promise<void> {
  const write = process.argv.includes('--write');
  const backup = option('--backup');
  if (write && !backup) throw new Error('--write requires --backup PATH');
  const address = getHlAccountAddress();
  if (!address) throw new Error('HL_ACCOUNT_ADDRESS is required');
  const db = getServiceRoleClient();
  const [{ data: oldRows, error }, active, archived] = await Promise.all([
    db.from('ladder_outcomes').select('*'), listLaddersWithRungs(),
    listLaddersWithRungs(undefined, { archived: true }),
  ]);
  if (error) throw new Error(error.message);
  const all = [...active, ...archived];
  const old = oldRows ?? [];
  const byId = new Map(all.map((ladder) => [ladder.id, ladder]));
  // Positions first: a fill landing between the two reads then fails the inventory check (safe).
  const state = await fetchClearinghouseState(address, { uncached: true });
  if (state.error || state.stale) throw new Error(`Account state unavailable: ${state.error ?? 'stale'}`);
  const finalPositions = new Map(state.positions.map((position) => [position.coin.toUpperCase(), position.szi]));
  const fillsResult = await fetchAllFills(address, { sinceMs: 0, maxFills: 100_000 });
  if (fillsResult.error || fillsResult.truncated) throw new Error(`Incomplete HL fill history: ${fillsResult.error ?? 'truncated'}`);
  const fires = await outcomeFires(all.map((ladder) => ladder.id));
  const attribution = attributeLadderFills(all, fires, fillsResult.fills, { finalPositions });
  const failures = attributionInvariantFailures(attribution);
  for (const check of attribution.conservation) {
    console.log(`${check.coin} conservation ${check.passed ? 'PASS' : 'FAIL'}: closed P&L $${check.attributedClosedPnl.toFixed(2)}/$${check.accountClosedPnl.toFixed(2)}, fees $${check.attributedFees.toFixed(2)}/$${check.accountFees.toFixed(2)}`);
  }
  const now = Date.now();
  const updates: { id: string; fields: Record<string, number | string | null> }[] = [];
  let oldTotal = 0;
  let newTotal = 0;
  for (const row of old) {
    const ladder = byId.get(String(row.ladder_id));
    if (!ladder) throw new Error(`Missing ladder ${String(row.ladder_id)}`);
    const risk = computeLadderRisk(ladder.rungs.map(resolveArmRung), {
      maxTotalNotionalUsd: ladder.maxTotalNotionalUsd, maxTotalLossUsd: ladder.maxTotalLossUsd,
    });
    const plannedRiskUsd = risk.worstCaseLossWithFundingUsd;
    const nominalRiskUsd = ladder.rungs.filter((rung) => rung.action === 'open' || rung.action === 'add')
      .reduce((sum, rung) => sum + (rung.riskUsd ?? 0), 0);
    const entryStatuses = fires.filter((fire) => fire.ladderId === ladder.id
      && ladder.rungs.some((rung) => rung.id === fire.rungId && rung.action === 'open')).map((fire) => fire.status);
    const next = resolveLadderOutcome({ ladder, fireStatuses: entryStatuses,
      hlFills: fillsResult.fills, ownerLedger: attribution.byLadder.get(ladder.id),
      plannedRiskUsd, nominalRiskUsd, positionStillOpen: false,
      signalScore: row.signal_score as number | null, timingScore: row.timing_score as number | null, now });
    const fields = { realized_pnl_usd: next.realizedPnlUsd, fees_usd: next.feesUsd,
      realized_r: next.realizedR, outcome: next.outcome, notes: next.notes };
    updates.push({ id: ladder.id, fields });
    oldTotal += Number(row.realized_pnl_usd ?? 0);
    newTotal += next.realizedPnlUsd ?? 0;
    console.log(`${ladder.id} ${ladder.title}: old ${JSON.stringify({ pnl: row.realized_pnl_usd, fees: row.fees_usd, r: row.realized_r, outcome: row.outcome })} new ${JSON.stringify({ pnl: next.realizedPnlUsd, fees: next.feesUsd, r: next.realizedR, nominalR: next.nominalR, outcome: next.outcome })}`);
  }
  const manualTotal = [...attribution.manual.values()].reduce((sum, owner) => sum + owner.closedPnl - owner.fees, 0);
  const ladderTotal = [...attribution.byLadder.values()].reduce((sum, owner) => sum + owner.closedPnl - owner.fees, 0);
  console.log(`Totals: old outcome $${oldTotal.toFixed(2)}, new closed outcome $${newTotal.toFixed(2)}, ladder fills $${ladderTotal.toFixed(2)}, manual fills $${manualTotal.toFixed(2)}, unmatched entries ${attribution.unmatchedEntryCount}, historical entry matches ${attribution.fallbackCount}; funding excluded`);
  for (const check of attribution.inventory) {
    console.log(`${check.coin} inventory ${check.passed ? 'PASS' : 'FAIL'}: lots ${check.lotPosition}, replay ${check.replayedPosition}, account ${check.accountPosition}`);
  }
  for (const failure of failures) console.log(`INVARIANT FAIL ${failure}`);
  if (failures.length) throw new Error(`Refusing write: ${failures.length} attribution invariant failure(s)`);
  if (!write) return;
  writeFileSync(backup!, JSON.stringify(old, null, 2), { flag: 'wx', mode: 0o600 });
  for (const update of updates) {
    const { error: updateError } = await db.from('ladder_outcomes').update(update.fields).eq('ladder_id', update.id);
    if (updateError) throw new Error(`Update ${update.id} failed: ${updateError.message}`);
  }
  console.log(`Updated ${updates.length} rows. Backup: ${backup}`);
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
