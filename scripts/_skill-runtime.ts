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

export interface ConfirmOptions {
  /** Trading mode. In 'live' the argv `--confirm yes` bypass is REFUSED — a real
   *  order always requires the interactive, typed confirmation (extra friction). */
  mode?: 'paper' | 'live';
  /** In live mode the user must type this exact phrase (e.g. "ETH 1.5") rather
   *  than just "yes", so a real order can't fire on a reflexive keystroke. */
  liveConfirmPhrase?: string;
}

/**
 * Block until the user explicitly confirms. The HARD PRINCIPLE: action skills
 * NEVER auto-fire. Returns true ONLY when the user confirms explicitly.
 *
 * PAPER: `--confirm yes` on argv is accepted (lets a skill pass a confirmed
 * decision through), else an interactive y/N prompt that defaults to NO.
 *
 * LIVE: the argv bypass is REFUSED. The user must interactively type the exact
 * `liveConfirmPhrase` (defaults to "yes" if none supplied). This guarantees a
 * real order carries more friction than a paper one.
 */
export async function requireConfirmation(
  args: Record<string, string | boolean>,
  proposalSummary: string,
  opts: ConfirmOptions = {},
): Promise<boolean> {
  const live = opts.mode === 'live';
  header('CONFIRM ACTION (the user decides — nothing fires without an explicit yes)');
  line(proposalSummary);

  const expected = (live && opts.liveConfirmPhrase ? opts.liveConfirmPhrase : 'yes')
    .trim()
    .toLowerCase();

  const flag = args['confirm'];
  if (typeof flag === 'string') {
    if (live) {
      // No non-interactive bypass for REAL orders — fall through to the prompt.
      line('LIVE mode: --confirm is ignored; you must type the confirmation phrase interactively.');
    } else {
      const confirmed = flag.trim().toLowerCase() === expected;
      line(`--confirm ${flag} → ${confirmed ? 'CONFIRMED' : `NOT confirmed (must be exactly "${expected}")`}`);
      return confirmed;
    }
  }

  // Interactive fallback — default NO.
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const prompt = live
      ? `LIVE ORDER — type exactly "${expected}" to execute, anything else to abort: `
      : 'Type "yes" to execute, anything else to abort: ';
    const answer = await rl.question(prompt);
    return answer.trim().toLowerCase() === expected;
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
