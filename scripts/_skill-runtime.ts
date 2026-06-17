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
import type { PendingActionProposal } from '@/types/cockpit';

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

/**
 * Is the server-side Supabase service-role client configured? Mirrors the env
 * resolution in supabase-server.ts. When false (headless scripts with no DB) the
 * approval gate falls back to the terminal confirmation so scripts still run.
 */
function isSupabaseConfigured(): boolean {
  const url =
    process.env.HL_SUPABASE_URL ??
    process.env.NEXT_PUBLIC_HL_SUPABASE_URL ??
    process.env.SUPABASE_URL ??
    process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key =
    process.env.HL_SUPABASE_SERVICE_ROLE_KEY ??
    process.env.HL_SUPABASE_SECRET_KEY ??
    process.env.SUPABASE_SERVICE_ROLE_KEY;
  return Boolean(url && key);
}

export interface RequireApprovalInput {
  /** Session the action belongs to. When absent, the terminal gate is used. */
  sessionId?: string | null;
  kind: 'entry' | 'exit' | 'generic';
  /** The proposal payload (executable intent + display) written to the row. */
  proposal: PendingActionProposal;
  mode: 'paper' | 'live';
  /** Poll timeout in ms (default 120000). */
  timeoutMs?: number;
  /** Raw argv (so the terminal fallback can honor --confirm in paper). */
  args?: Record<string, string | boolean>;
}

/**
 * THE NO-AUTO-FIRE approval gate. Resolves TRUE only on an explicit approval.
 *
 * WEB path (sessionId present AND Supabase configured): write a 'pending'
 * `pending_actions` row, then poll it until the human approves (→ true), rejects
 * (→ false), or it times out (→ marked 'expired', false). The popup is the only
 * thing that flips it to 'approved'. Default on timeout/reject/error is NO.
 *
 * TERMINAL fallback (no session / Supabase unavailable — headless scripts):
 * delegate to the existing `requireConfirmation` so scripts still run, including
 * the LIVE exact-phrase rigor.
 *
 * Decision/timeout logic is the PURE approval-gate-business-logic; this only
 * orchestrates I/O + the terminal fallback.
 */
export async function requireApproval(input: RequireApprovalInput): Promise<boolean> {
  const { sessionId, kind, proposal, mode } = input;
  const args = input.args ?? {};
  const d = proposal.display;
  const summary =
    `Execute: ${d.side.toUpperCase()} ${d.sz} ${d.coin}` +
    (d.estPx != null ? ` @≈$${d.estPx}` : '') +
    (d.stopPx != null ? `  stop=$${d.stopPx}` : '') +
    `\n${d.rationale}\n(mode=${mode} — ${mode === 'live' ? 'REAL ORDER' : 'paper fill from live book'})`;

  // No session OR Supabase not wired ⇒ terminal gate (headless scripts).
  if (!sessionId || !isSupabaseConfigured()) {
    line('No web session / Supabase not configured — using the terminal confirmation gate.');
    return requireConfirmation(args, summary, {
      mode,
      liveConfirmPhrase: `${d.side} ${d.sz} ${d.coin}`,
    });
  }

  // WEB path: write a pending row + poll. Dynamic import keeps the heavy
  // service-role module out of the load path when running headless.
  const { createPendingAction, pollPendingAction } = await import(
    '@/lib/cockpit/pending-actions-service'
  );
  header('AWAITING WEB APPROVAL (the user approves in the cockpit popup — nothing fires otherwise)');
  line(summary);
  const action = await createPendingAction({ sessionId, kind, mode, proposal });
  line(`pending_actions row ${action.id} created — open the cockpit to approve/reject.`);
  const approved = await pollPendingAction(action.id, { timeoutMs: input.timeoutMs });
  line(approved ? 'APPROVED in the cockpit.' : 'NOT approved (rejected/timeout) — nothing executed.');
  return approved;
}

/**
 * Load `.env.local` into process.env so every `pnpm skill:*` entrypoint inherits
 * Supabase/HL config. Node 24 provides process.loadEnvFile natively (no dotenv).
 * Guarded: on Vercel/CI the file is absent and env comes from the real
 * environment — loadEnvFile does NOT clobber vars already set, and a missing
 * file must not throw. Mirrors scripts/_smoke.ts.
 */
function loadEnvLocal(): void {
  try {
    process.loadEnvFile('.env.local');
  } catch {
    // .env.local may be absent (CI/Vercel) — env vars may already be set.
  }
}

/** Run an async main, printing errors and setting a non-zero exit code. */
export function run(main: () => Promise<void>): void {
  loadEnvLocal();
  main().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\n[skill error] ${msg}`);
    process.exitCode = 1;
  });
}
