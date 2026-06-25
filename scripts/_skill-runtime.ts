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
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
    process.env.HL_TRADERS_SUPABASE_URL ??
    process.env.HL_SUPABASE_URL ??
    process.env.NEXT_PUBLIC_HL_SUPABASE_URL ??
    process.env.SUPABASE_URL ??
    process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key =
    process.env.HL_TRADERS_SUPABASE_SERVICE_ROLE_KEY ??
    process.env.HL_TRADERS_SUPABASE_SECRET_KEY ??
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
 * The gate outcome. `approved` is the NO-AUTO-FIRE boolean (TRUE only on an
 * explicit approval). `leverage` is the OPERATOR-CHOSEN, SERVER-VALIDATED
 * leverage read back off the approved row (Item 3) — the value executeIntent
 * should run with. Undefined when not approved, or when the web popup did not
 * change it (the caller then keeps the proposal's own leverage). Terminal
 * fallback never overrides leverage (no slider there).
 */
export interface ApprovalResult {
  approved: boolean;
  leverage?: number;
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
export async function requireApproval(input: RequireApprovalInput): Promise<ApprovalResult> {
  const { sessionId, kind, proposal, mode } = input;
  const args = input.args ?? {};
  const d = proposal.display;
  const summary =
    `Execute: ${d.side.toUpperCase()} ${d.sz} ${d.coin}` +
    (d.estPx != null ? ` @≈$${d.estPx}` : '') +
    (d.stopPx != null ? `  stop=$${d.stopPx}` : '') +
    `\n${d.rationale}\n(mode=${mode} — ${mode === 'live' ? 'REAL ORDER' : 'paper fill from live book'})`;

  // No session OR Supabase not wired ⇒ terminal gate (headless scripts). No
  // slider in the terminal, so leverage is left to the proposal (undefined here).
  if (!sessionId || !isSupabaseConfigured()) {
    line('No web session / Supabase not configured — using the terminal confirmation gate.');
    const approved = await requireConfirmation(args, summary, {
      mode,
      liveConfirmPhrase: `${d.side} ${d.sz} ${d.coin}`,
    });
    return { approved };
  }

  // WEB path: write a pending row + poll. Dynamic import keeps the heavy
  // service-role module out of the load path when running headless.
  const { createPendingAction, pollPendingAction, getPendingAction } = await import(
    '@/lib/cockpit/pending-actions-service'
  );
  header('AWAITING WEB APPROVAL (the user approves in the cockpit popup — nothing fires otherwise)');
  line(summary);
  const action = await createPendingAction({ sessionId, kind, mode, proposal });
  line(`pending_actions row ${action.id} created — open the cockpit to approve/reject.`);
  const approved = await pollPendingAction(action.id, { timeoutMs: input.timeoutMs });
  line(approved ? 'APPROVED in the cockpit.' : 'NOT approved (rejected/timeout) — nothing executed.');
  if (!approved) return { approved: false };

  // Approved: read the row back so the operator's SERVER-VALIDATED leverage (the
  // approve route stamped it onto proposal.intent.leverage) flows to executeIntent.
  // Fail-soft: if the read fails, fall back to the proposal's own leverage.
  let leverage: number | undefined;
  try {
    const decided = await getPendingAction(action.id);
    leverage = decided?.proposal.intent.leverage ?? proposal.intent.leverage;
  } catch {
    leverage = proposal.intent.leverage;
  }
  return { approved: true, leverage };
}

/**
 * Load `.env.local` into process.env so every `pnpm skill:*` / daemon entrypoint
 * inherits Supabase/HL config. Node 24 provides process.loadEnvFile natively.
 *
 * CWD-INDEPENDENT (important for the NAS daemons + systemd + cron): `loadEnvFile`
 * resolves its argument relative to process.cwd(), so a bare `.env.local` only
 * works when the process starts in the repo root. The trade-watch service / watch
 * daemon run under systemd / `./start.sh` / cron where the cwd may be anything,
 * which silently left Supabase unconfigured. We instead resolve `.env.local` at
 * the REPO ROOT (this file lives in `<root>/scripts/`, so `..` is the root) and
 * fall back to a cwd-relative load.
 *
 * Guarded: on Vercel/CI the file is absent and env comes from the real
 * environment — a missing file must not throw, and loadEnvFile does NOT clobber
 * vars already set. Mirrors scripts/_smoke.ts.
 */
function loadEnvLocal(): void {
  const candidates: string[] = [];
  // Repo-root-relative (deterministic, cwd-independent). `__dirname` is available
  // under tsx's CommonJS mode (package.json has no "type":"module"); guard anyway
  // so an ESM context simply falls through to the cwd-relative attempt.
  try {
    candidates.push(resolve(__dirname, '..', '.env.local'));
  } catch {
    // __dirname unavailable — skip the repo-root candidate.
  }
  candidates.push('.env.local'); // cwd-relative fallback (original behavior)

  for (const path of candidates) {
    try {
      // existsSync avoids a noisy throw for the non-cwd candidate; the bare
      // '.env.local' still goes straight to the loader (cwd may be the root).
      if (path !== '.env.local' && !existsSync(path)) continue;
      applyEnvFile(path);
      return;
    } catch {
      // Try the next candidate; if none load, env comes from the real environment.
    }
  }
}

/**
 * Apply one `.env.local` into process.env. Prefers Node's native
 * `process.loadEnvFile` (Node ≥ 20.6), but FALLS BACK to a minimal hand parser on
 * older Node — Synology NAS / other long-LTS boxes commonly run Node 18, where
 * `process.loadEnvFile` is undefined and would otherwise silently leave Supabase
 * unconfigured (tsx still runs, so the failure looks like "missing env" even with
 * a valid file). The fallback handles `KEY=value`, `export KEY=value`, `#`
 * comments, blank lines, and matching surrounding quotes; it does not clobber
 * vars already set in the real environment.
 */
function applyEnvFile(path: string): void {
  const native = (process as { loadEnvFile?: (p: string) => void }).loadEnvFile;
  if (typeof native === 'function') {
    native.call(process, path);
    return;
  }
  const content = readFileSync(path, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    let key = line.slice(0, eq).trim();
    if (key.startsWith('export ')) key = key.slice('export '.length).trim();
    if (!key) continue;
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

/**
 * Provide a global `WebSocket` on Node < 22 (which ships no native global one).
 * `@supabase/supabase-js` builds a RealtimeClient when `createClient` runs, and
 * that constructor REQUIRES a WebSocket — even though the skill daemons + the NAS
 * trade-watch service only do REST writes and never open a realtime socket.
 * Without this, `createClient` throws "Node.js 20 detected without native
 * WebSocket support", which the preflight surfaces as "Supabase not configured".
 *
 * On Node ≥ 22 / Vercel / the browser a native WebSocket already exists, so this
 * is a no-op. It lives in the CLI runtime (scripts/), so it never touches the
 * deployed Next bundle. Runs BEFORE main() — and createClient is always lazy
 * (getServiceRoleClient), so the global is set before any client is constructed.
 */
async function ensureWebSocket(): Promise<void> {
  const g = globalThis as { WebSocket?: unknown };
  if (typeof g.WebSocket !== 'undefined') return;
  try {
    const ws = await import('ws');
    const impl =
      (ws as { WebSocket?: unknown }).WebSocket ??
      (ws as { default?: unknown }).default ??
      ws;
    g.WebSocket = impl;
  } catch {
    // `ws` unavailable (not installed) — the supabase realtime "no WebSocket"
    // error will surface. Fix: `pnpm install` (ws is a dependency) or Node ≥ 22.
  }
}

/** Run an async main, printing errors and setting a non-zero exit code. */
export function run(main: () => Promise<void>): void {
  loadEnvLocal();
  void (async () => {
    await ensureWebSocket();
    try {
      await main();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`\n[skill error] ${msg}`);
      process.exitCode = 1;
    }
  })();
}
