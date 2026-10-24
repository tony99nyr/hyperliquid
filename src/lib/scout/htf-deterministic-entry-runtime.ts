/** Real I/O adapter for daemon-owned HTF paper entries. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getTradingMode } from '@/lib/env/mode';
import { getServiceRoleClient } from '@/lib/cockpit/supabase-server';
import { scanHtfTrend } from './htf-trend-scan-service';
import { runDeterministicHtfEntries, type HtfEntry } from './htf-deterministic-entry-service';

const execFileAsync = promisify(execFile);

async function openPaperCoins(): Promise<Set<string>> {
  const { data, error } = await getServiceRoleClient()
    .from('positions')
    .select('coin, sessions!inner(mode)')
    .eq('sessions.mode', 'paper')
    .gt('sz', 0);
  if (error) throw new Error(`HTF open-position read failed: ${error.message}`);
  return new Set((data ?? []).map((row) => String(row.coin).toUpperCase()));
}

async function executePaperEntry(entry: HtfEntry): Promise<void> {
  const thesis = `Frozen daily 20-close breakout on ${entry.coin}; 10-close channel exit, 2x ATR20 stop capped at 12%. Rule ${entry.ruleVersion}.`;
  const { stdout } = await execFileAsync('pnpm', [
    '--silent', 'scout:trade', '--', '--coin', entry.coin, '--side', entry.side,
    '--risk', String(entry.riskUsd), '--stop-frac', String(entry.stopFrac),
    '--lane', entry.lane, '--setup-type', entry.setupType, '--regime', 'trend',
    '--thesis', thesis, '--deterministic-htf',
  ], { timeout: 120_000, maxBuffer: 1024 * 1024 });
  if (!stdout.includes('Filled (paper):')) {
    throw new Error(`scout:trade returned without a paper fill: ${stdout.trim().slice(-300)}`);
  }
}

async function modelVeto(entry: HtfEntry): Promise<string | null> {
  const prompt = `PAPER scout veto review only. Frozen HTF rule proposes ${entry.side} ${entry.coin}, breakout daily close ${entry.entryPx}, stop fraction ${entry.stopFrac}. You cannot change or open the entry. Reply with exactly one JSON object: {"veto":false} or {"veto":true,"reason":"specific hard disqualifier"}.`;
  const { stdout } = await execFileAsync(process.env.CLAUDE_BIN ?? 'claude',
    ['-p', prompt, '--model', 'sonnet'], { timeout: 90_000, maxBuffer: 16_384 });
  const answer = JSON.parse(stdout.trim()) as { veto?: unknown; reason?: unknown };
  if (answer.veto === false) return null;
  if (answer.veto === true && typeof answer.reason === 'string' && answer.reason.trim().length >= 8) {
    return answer.reason.trim().slice(0, 500);
  }
  throw new Error('invalid model veto reply');
}

export async function runConfiguredDeterministicHtfEntries(now: number, log: (message: string) => void): Promise<void> {
  const enabled = process.env.SCOUT_HTF_DETERMINISTIC === 'true';
  await runDeterministicHtfEntries(enabled, getTradingMode(), now, {
    scan: scanHtfTrend,
    openCoins: openPaperCoins,
    execute: executePaperEntry,
    log: async (message) => {
      log(message);
      const veto = /^HTF deterministic veto ([A-Z]+): (.+)$/.exec(message);
      if (!veto) return;
      const { error } = await getServiceRoleClient().from('scout_decisions').insert({
        kind: 'stand-down', coin: veto[1], lane: 'htf-trend',
        reasoning: `daemon-v1 model veto: ${veto[2]}`, executed: false,
      });
      if (error) log(`WARN HTF veto ledger write failed: ${error.message}`);
    },
    ...(process.env.SCOUT_HTF_VETO_ENABLED === 'true' ? { veto: modelVeto } : {}),
  });
}
