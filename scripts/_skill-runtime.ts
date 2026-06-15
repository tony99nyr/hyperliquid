/**
 * Shared runtime helpers for the skill entrypoint scripts (thin I/O).
 *
 * These scripts are CLI entrypoints a Claude skill invokes (one per skill). They
 * do argv parsing, fetch live HL/Supabase data, call the PURE *-business-logic
 * modules, print a structured proposal, and — for the two ACTION skills
 * (open-position, advise-exit) — REQUIRE EXPLICIT user confirmation before
 * calling executeIntent. Confirmation gating lives here so both action scripts
 * share one auditable implementation.
 *
 * NOTHING in an advisory script may execute a trade. The action scripts execute
 * ONLY after `requireConfirmation` returns true.
 */

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

/** Parse `--key value` / `--flag` argv into a record. */
export function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith('--')) continue;
    const key = tok.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

export function requireString(args: Record<string, string | boolean>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || v.trim() === '') {
    throw new Error(`Missing required --${key} <value>`);
  }
  return v;
}

export function optionalNumber(
  args: Record<string, string | boolean>,
  key: string,
  fallback: number,
): number {
  const v = args[key];
  if (typeof v !== 'string') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Print a section header. */
export function header(title: string): void {
  console.log(`\n=== ${title} ===`);
}

/** Print a line. */
export function line(msg = ''): void {
  console.log(msg);
}

/**
 * Block until the user explicitly confirms. The HARD PRINCIPLE: action skills
 * NEVER auto-fire. Returns true ONLY when the user types `yes` (case-insensitive)
 * at the interactive prompt.
 *
 * Two non-interactive escape hatches, both EXPLICIT and surfaced in the prompt:
 *  - `--confirm yes` on argv (so a skill can pass a confirmed decision through),
 *  - otherwise an interactive y/N prompt that defaults to NO.
 */
export async function requireConfirmation(
  args: Record<string, string | boolean>,
  proposalSummary: string,
): Promise<boolean> {
  header('CONFIRM ACTION (the user decides — nothing fires without an explicit yes)');
  line(proposalSummary);

  const flag = args['confirm'];
  if (typeof flag === 'string') {
    const confirmed = flag.trim().toLowerCase() === 'yes';
    line(`--confirm ${flag} → ${confirmed ? 'CONFIRMED' : 'NOT confirmed (must be exactly "yes")'}`);
    return confirmed;
  }

  // Interactive fallback — default NO.
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await rl.question('Type "yes" to execute, anything else to abort: ');
    return answer.trim().toLowerCase() === 'yes';
  } finally {
    rl.close();
  }
}

/** Run an async main, printing errors and setting a non-zero exit code. */
export function run(main: () => Promise<void>): void {
  main().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\n[skill error] ${msg}`);
    process.exitCode = 1;
  });
}
