/** Manual entry to the same atomic, draft-only prep path as the production cron. */
import { readFileSync } from 'node:fs';
import { ECONOMIC_EVENTS } from '@/lib/skills/economic-events';
import { prepEventStraddle } from '@/lib/ladder/event-straddle-prep-service';
import { eventStraddlePrepDeps } from '@/lib/ladder/event-straddle-prep-io';

function loadEnv(): void {
  let raw = '';
  try { raw = readFileSync('.env.local', 'utf8'); } catch { return; }
  for (const line of raw.split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!process.env[match[1]]) process.env[match[1]] = value;
  }
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  loadEnv();
  const name = arg('event') ?? 'event';
  const rawPrint = arg('print') ?? '';
  if (!Number.isFinite(Date.parse(rawPrint))) throw new Error('--print <ISO datetime> is required');
  const print = new Date(rawPrint).toISOString();
  // A manual name may differ from the calendar label. The print time still selects
  // the same event key as the cron, so the second run cannot draft another pair.
  const listed = ECONOMIC_EVENTS.find((event) => event.atIso === print);
  const event = listed ?? { name, atIso: print, straddleCoin: arg('coin') ?? 'ETH' };
  const gateArg = arg('gate-pct');
  const riskArg = arg('risk');
  const result = await prepEventStraddle({
    event, now: Date.now(), coin: arg('coin'),
    gatePct: gateArg === undefined ? undefined : Number(gateArg) / 100,
    riskUsd: riskArg === undefined ? undefined : Number(riskArg),
    dry: process.argv.includes('--dry'),
  }, eventStraddlePrepDeps);
  console.log(result);
}

main().catch((error: unknown) => {
  console.error('straddle-prep failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
