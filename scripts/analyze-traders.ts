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

import { parseArgs, optionalNumber, header, line, run } from './_skill-runtime';
import { loadRatedWallets, findRatedWallet, type RatedWallet } from '@/lib/hyperliquid/rated-wallets-service';
import { fetchClearinghouseState, fetchAllFills } from '@/lib/hyperliquid/hyperliquid-info-service';
import { gradeCandidate, rankCandidates } from '@/lib/skills/analyze-traders-business-logic';
import { writeAnalysisLog } from '@/lib/cockpit/analysis-log-service';

run(async () => {
  const args = parseArgs(process.argv.slice(2));
  // --session is OPTIONAL: you analyze traders to DECIDE whether to open a
  // session (chicken-and-egg). When provided, the shortlist is logged to it;
  // when absent, the analysis still runs read-only and just isn't logged.
  const sessionId = typeof args['session'] === 'string' && args['session'].trim() !== '' ? args['session'] : null;
  // Clamp to a sane max so `--top 100000` can't fan out a huge concurrent
  // Promise.all of HL fetches (self-inflicted rate-limit / resource hazard).
  const top = Math.max(1, Math.min(50, Math.floor(optionalNumber(args, 'top', 10))));
  // Deep-fetch bound per wallet so a run can't fan out unbounded.
  const maxFills = Math.max(2000, Math.floor(optionalNumber(args, 'max-fills', 12000)));

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

  const sinceMs = Date.now() - 365 * 24 * 60 * 60 * 1000;
  const candidates = await Promise.all(
    wallets.map(async (w) => {
      // Deep-paginate the full fill history (pages are sequential within a wallet;
      // wallets still process concurrently). The completeness gate then sees real
      // depth + an authoritative truncation signal instead of one capped page.
      const [state, fillsRes] = await Promise.all([
        fetchClearinghouseState(w.address),
        fetchAllFills(w.address, { sinceMs, maxFills }),
      ]);
      return gradeCandidate(w, state, fillsRes.fills, fillsRes.truncated);
    }),
  );

  const ranked = rankCandidates(candidates);

  header('Ranked candidates (you pick — this is advisory only)');
  ranked.forEach((c, i) => {
    line(`${i + 1}. [${c.grade}] ${c.short} ${c.displayName ? `(${c.displayName})` : ''}`);
    line(`    fills seen: ${c.fillsSeen} (deep-fetched)`);
    line(`    completeness: ${c.completeness} — ${c.completenessReason}`);
    line(`    ${c.rationale}`);
  });

  const cleanAs = ranked.filter((c) => c.grade === 'A').length;
  const gated = ranked.filter((c) => c.completeness === 'INSUFFICIENT_HISTORY').length;
  const summary = `analyze-traders: ${ranked.length} graded, ${cleanAs} clean A, ${gated} gated INSUFFICIENT_HISTORY. Top: ${ranked[0]?.short ?? 'none'} [${ranked[0]?.grade ?? '-'}].`;

  if (sessionId) {
    await writeAnalysisLog({ sessionId, source: 'analyze-traders', message: summary });
    header('Wrote analysis_log row');
  } else {
    header('Summary');
    line('(no --session — analysis not logged to a session)');
  }
  line(summary);
  line('\nPick a candidate to follow, then run analyze-market-timeframes for the coin.');
});
