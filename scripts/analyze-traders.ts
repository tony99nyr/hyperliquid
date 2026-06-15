/**
 * skill:analyze-traders entrypoint (thin I/O). ADVISORY ONLY — never trades.
 *
 * Discovers/grades HL traders to potentially follow. For each candidate address
 * (explicit --addresses, or the top rated wallets) it fetches live HL state +
 * fills, runs the PURE grader (which enforces the INSUFFICIENT_HISTORY gate — a
 * thin/page-capped wallet can never be a clean A), ranks them, writes an
 * analysis_log row, and prints the ranked candidates for the user to pick from.
 *
 * Usage:
 *   pnpm skill:analyze-traders --session <id> [--addresses 0x..,0x..] [--top 10]
 */

import { parseArgs, requireString, optionalNumber, header, line, run } from './_skill-runtime';
import { loadRatedWallets, findRatedWallet, type RatedWallet } from '@/lib/hyperliquid/rated-wallets-service';
import { fetchClearinghouseState, fetchRecentFills } from '@/lib/hyperliquid/hyperliquid-info-service';
import { gradeCandidate, rankCandidates } from '@/lib/skills/analyze-traders-business-logic';
import { writeAnalysisLog } from '@/lib/cockpit/analysis-log-service';

run(async () => {
  const args = parseArgs(process.argv.slice(2));
  const sessionId = requireString(args, 'session');
  const top = optionalNumber(args, 'top', 10);

  // Resolve the candidate wallet list.
  let wallets: RatedWallet[];
  if (typeof args['addresses'] === 'string') {
    wallets = args['addresses']
      .split(',')
      .map((a) => a.trim())
      .filter(Boolean)
      .map((a) => findRatedWallet(a))
      .filter((w): w is RatedWallet => w !== null);
    if (wallets.length === 0) throw new Error('None of the --addresses were found in the rated dataset.');
  } else {
    // Default: the highest-composite rated wallets (a discovery shortlist).
    wallets = [...loadRatedWallets().wallets]
      .filter((w) => w.composite !== null)
      .sort((a, b) => (b.composite ?? 0) - (a.composite ?? 0))
      .slice(0, top);
  }

  header(`analyze-traders — grading ${wallets.length} wallet(s) on FULL fill history`);
  line('Fetching live HL state + fills per wallet (read-only)…');

  const candidates = await Promise.all(
    wallets.map(async (w) => {
      const [state, fillsRes] = await Promise.all([
        fetchClearinghouseState(w.address),
        // Pull a deep window so the completeness gate sees the real tail.
        fetchRecentFills(w.address, 365 * 24 * 60 * 60 * 1000, 2000),
      ]);
      return gradeCandidate(w, state, fillsRes.fills);
    }),
  );

  const ranked = rankCandidates(candidates);

  header('Ranked candidates (you pick — this is advisory only)');
  ranked.forEach((c, i) => {
    line(`${i + 1}. [${c.grade}] ${c.short} ${c.displayName ? `(${c.displayName})` : ''}`);
    line(`    completeness: ${c.completeness} — ${c.completenessReason}`);
    line(`    ${c.rationale}`);
  });

  const cleanAs = ranked.filter((c) => c.grade === 'A').length;
  const gated = ranked.filter((c) => c.completeness === 'INSUFFICIENT_HISTORY').length;
  const summary = `analyze-traders: ${ranked.length} graded, ${cleanAs} clean A, ${gated} gated INSUFFICIENT_HISTORY. Top: ${ranked[0]?.short ?? 'none'} [${ranked[0]?.grade ?? '-'}].`;

  await writeAnalysisLog({ sessionId, source: 'analyze-traders', message: summary });
  header('Wrote analysis_log row');
  line(summary);
  line('\nPick a candidate to follow, then run analyze-market-timeframes for the coin.');
});
