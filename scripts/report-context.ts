/**
 * skill:report-context-budget entrypoint (thin I/O). Single-purpose, tiny.
 *
 * Writes Claude's approximate self-reported context-usage percent + the
 * classified zone (pure classifyContextZone) to the context_gauge table so the
 * cockpit ContextGauge can warn the user before Claude runs low mid-trade. This
 * is a safety cue, not a meter — the percent is approximate and self-reported.
 *
 * Usage:
 *   pnpm skill:report-context --session <id> --pct 72
 */

import { parseArgs, requireString, header, line, run } from './_skill-runtime';
import { writeContextGauge } from '@/lib/cockpit/context-gauge-service';

run(async () => {
  const args = parseArgs(process.argv.slice(2));
  const sessionId = requireString(args, 'session');
  const pctRaw = requireString(args, 'pct');
  const approxPct = Number(pctRaw);
  if (!Number.isFinite(approxPct)) throw new Error('--pct must be a number 0–100');

  const zone = await writeContextGauge({ sessionId, approxPct });

  header('report-context-budget');
  line(`approx context: ${approxPct}%  →  zone: ${zone.toUpperCase()}`);
  if (zone !== 'ok') {
    line(zone === 'critical'
      ? 'CRITICAL: wrap up the current step and consider a fresh session before acting.'
      : 'WARN: getting full — finish the in-flight decision soon.');
  }
});
