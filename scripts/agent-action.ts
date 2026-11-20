/**
 * skill:agent-action entrypoint (thin I/O). ACTION script (ADR-0009).
 *
 * Sends one scoped, risk-reducing action to the production cockpit:
 *   tighten-stop: move the protective stop tighter (never looser, never removed).
 *   reduce:       close a fraction of the position, reduce-only.
 *
 * HARD PRINCIPLE: this NEVER fires without `--confirm yes`. Without it the script
 * prints the request and stops, with no network call. The agent passes the flag only
 * after the operator said yes in the conversation.
 *
 * Needs AGENT_ACTION_URL (the production base URL) and AGENT_ACTION_TOKEN in the
 * environment or in .env.local. The token is never printed.
 *
 * Usage:
 *   pnpm skill:agent-action --action tighten-stop --coin HYPE --px 66.5 [--confirm yes]
 *   pnpm skill:agent-action --action reduce --coin HYPE --fraction 0.4 [--confirm yes]
 */

import { parseArgs, header, line, run } from './_skill-runtime';
import { parseAgentActionRequest } from '@/lib/agent-actions/agent-action-business-logic';

const TIMEOUT_MS = 30_000;

run(async () => {
  const args = parseArgs(process.argv.slice(2));
  const num = (key: string): number | undefined => (typeof args[key] === 'string' ? Number(args[key]) : undefined);
  const parsed = parseAgentActionRequest({ action: args['action'], coin: args['coin'], triggerPx: num('px'), fraction: num('fraction') });
  if (!parsed.ok) throw new Error(parsed.error);
  const request = parsed.request;

  header(`agent-action: ${request.action} ${request.coin}`);
  line(request.action === 'tighten-stop' ? `Move the ${request.coin} stop to ${request.triggerPx} (tighter only).` : `Close ${(request.fraction * 100).toFixed(0)}% of the ${request.coin} position, reduce-only.`);

  if (args['confirm'] !== 'yes') {
    line('NOT SENT: pass --confirm yes after the operator approves.');
    return;
  }
  const baseUrl = process.env.AGENT_ACTION_URL?.trim().replace(/\/+$/, '');
  const token = process.env.AGENT_ACTION_TOKEN?.trim();
  if (!baseUrl || !/^https:\/\//.test(baseUrl)) throw new Error('AGENT_ACTION_URL is not set to an https URL.');
  if (!token) throw new Error('AGENT_ACTION_TOKEN is not set.');

  const res = await fetch(`${baseUrl}/api/agent/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  line(`HTTP ${res.status}`);
  line(text.slice(0, 1200));
  if (!res.ok) {
    line('NOT DONE. On a 500 or a timeout the outcome is UNKNOWN: read the position before any retry.');
    process.exitCode = 1;
  }
});
