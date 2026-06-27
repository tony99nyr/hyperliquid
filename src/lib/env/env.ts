/**
 * Zod-validated environment. Centralizes every env var the cockpit reads so a
 * misconfiguration fails loudly at the edge instead of mysteriously downstream.
 *
 * TRADING_MODE itself is read via env/mode.ts (the single mode switch); it is
 * mirrored into the schema here so `validateEnv()` can sanity-check the whole
 * set together. The service-role Supabase key is server-only and MUST NOT be
 * referenced from client code (ADR-0002).
 *
 * Expected Supabase env var names. The Vercel Supabase Marketplace integration
 * for this project auto-injects every var with an `HL_` prefix, so those are the
 * canonical names; the unprefixed names are accepted as fallbacks for local /
 * portable setups.
 *   - HL_SUPABASE_URL / SUPABASE_URL                       server-only project URL
 *   - NEXT_PUBLIC_HL_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_URL  public project URL (browser bundle)
 *   - NEXT_PUBLIC_HL_SUPABASE_ANON_KEY / NEXT_PUBLIC_SUPABASE_ANON_KEY  public anon key (RLS select-only)
 *   - NEXT_PUBLIC_HL_SUPABASE_PUBLISHABLE_KEY              public publishable key (anon fallback)
 *   - HL_SUPABASE_SERVICE_ROLE_KEY / SUPABASE_SERVICE_ROLE_KEY  SERVER ONLY (bypasses RLS)
 *   - HL_SUPABASE_SECRET_KEY                               SERVER ONLY service-role fallback
 * The server client (supabase-server.ts) reads the HL_-prefixed URL + service
 * role first, falling back to the unprefixed names; the browser client reads the
 * NEXT_PUBLIC_HL_* pair first, then the unprefixed NEXT_PUBLIC_* pair.
 */

import { z } from 'zod';

const envSchema = z.object({
  TRADING_MODE: z.enum(['paper', 'live']).default('paper'),

  // Supabase project URL — server-only. The Vercel integration injects the
  // HL_-prefixed name; the unprefixed name is accepted as a fallback.
  HL_SUPABASE_URL: z.string().url().optional(),
  SUPABASE_URL: z.string().url().optional(),

  // Supabase (public — safe in the browser bundle). HL_-prefixed names first.
  NEXT_PUBLIC_HL_SUPABASE_URL: z.string().url().optional(),
  NEXT_PUBLIC_HL_SUPABASE_ANON_KEY: z.string().min(1).optional(),
  NEXT_PUBLIC_HL_SUPABASE_PUBLISHABLE_KEY: z.string().min(1).optional(),
  NEXT_PUBLIC_SUPABASE_URL: z.string().url().optional(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1).optional(),

  // Supabase service role (SERVER ONLY — never ship to client).
  HL_SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
  HL_SUPABASE_SECRET_KEY: z.string().min(1).optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),

  // Admin gate (vendored auth).
  ADMIN_SECRET: z.string().min(1).optional(),
  ADMIN_PIN: z.string().min(1).optional(),

  // HL live execution (Phase 3 — SERVER ONLY, used only when TRADING_MODE=live).
  // The AGENT/API wallet key: trade-only, cannot withdraw, revocable on HL.
  // NEVER the main account key; never exposed to the browser.
  HL_AGENT_PRIVATE_KEY: z.string().min(1).optional(),
  // Which HL network to sign + submit against. Default mainnet; set 'testnet' to
  // rehearse live execution safely first.
  HL_NETWORK: z.enum(['mainnet', 'testnet']).default('mainnet'),

  // Master account address (PUBLIC — the account the agent trades for). Used to
  // read clearinghouseState (liquidation price + margin) for the auto-exit liq
  // guard. Not a secret. Without it, the liq + margin-pct triggers are disabled
  // and auto-exit relies on the (always-computable) loss + health triggers.
  HL_ACCOUNT_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'expected a 0x-prefixed 20-byte address').optional(),

  // --- Layer-1 auto-exit (exit-only safety net; see docs/LIVE_AUTO_EXIT.md) ---
  // Master kill-switch. Default OFF: the risk-exit endpoint refuses to fire and
  // the detector no-ops unless this is explicitly 'true'. EXIT-ONLY when on.
  AUTO_EXIT_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  // Dedicated bearer token for the detector/cron to call /api/cockpit/risk-exit.
  // Separate from ADMIN_SECRET so the NAS/cron never holds the admin credential.
  AUTO_EXIT_CRON_SECRET: z.string().min(1).optional(),

  // --- Armed Ladder (see docs/ARMED_LADDER_ARCHITECTURE.md) ---
  // Capability gate for LIVE ladders: a LIVE-mode ladder can be ARMED (the operator
  // authorization) only when this is 'true'. PAPER ladders work regardless. Default
  // OFF. NOTE: arming ≠ executing — this does NOT let the watcher fire autonomously;
  // that is the SEPARATE LADDER_AUTOFIRE_ENABLED switch below.
  LADDER_LIVE_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  // The "automatic execute" kill-switch — INDEPENDENT of TRADING_MODE and
  // LADDER_LIVE_ENABLED. Only when this is 'true' may the NAS watcher / fire-rung route
  // (P1d) AUTONOMOUSLY execute a pre-armed rung while the operator is AFK. Default OFF,
  // and deliberately kept OFF even when the cockpit is fully live for MANUAL execution:
  // going live ≠ enabling AFK auto-fire. The fire route checks this as its single
  // enforcement point (invariant §4b.7 kill-switch) before any autonomous fill.
  LADDER_AUTOFIRE_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  // Dedicated bearer token for the NAS watcher to call /api/cockpit/ladder/fire-rung
  // (P1d). Separate from ADMIN_SECRET so the watcher never holds the admin credential.
  LADDER_CRON_SECRET: z.string().min(1).optional(),
  // Vercel's native cron secret (auto-injected as `Authorization: Bearer $CRON_SECRET`
  // on cron invocations). Accepted as a fallback so setting only CRON_SECRET (the
  // Vercel convention) still authenticates the backup detector.
  CRON_SECRET: z.string().min(1).optional(),
});

export type CockpitEnv = z.infer<typeof envSchema>;

/**
 * Parse + validate `process.env`. Optional fields are tolerated in Phase 0
 * (Supabase/HL keys land when the project is provisioned); the shape is fixed so
 * Phase 1 can tighten `.optional()` to required as each integration comes online.
 */
export function validateEnv(source: NodeJS.ProcessEnv = process.env): CockpitEnv {
  return envSchema.parse({
    TRADING_MODE: source.TRADING_MODE,
    HL_SUPABASE_URL: source.HL_SUPABASE_URL,
    SUPABASE_URL: source.SUPABASE_URL,
    NEXT_PUBLIC_HL_SUPABASE_URL: source.NEXT_PUBLIC_HL_SUPABASE_URL,
    NEXT_PUBLIC_HL_SUPABASE_ANON_KEY: source.NEXT_PUBLIC_HL_SUPABASE_ANON_KEY,
    NEXT_PUBLIC_HL_SUPABASE_PUBLISHABLE_KEY: source.NEXT_PUBLIC_HL_SUPABASE_PUBLISHABLE_KEY,
    NEXT_PUBLIC_SUPABASE_URL: source.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: source.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    HL_SUPABASE_SERVICE_ROLE_KEY: source.HL_SUPABASE_SERVICE_ROLE_KEY,
    HL_SUPABASE_SECRET_KEY: source.HL_SUPABASE_SECRET_KEY,
    SUPABASE_SERVICE_ROLE_KEY: source.SUPABASE_SERVICE_ROLE_KEY,
    ADMIN_SECRET: source.ADMIN_SECRET,
    ADMIN_PIN: source.ADMIN_PIN,
    HL_AGENT_PRIVATE_KEY: source.HL_AGENT_PRIVATE_KEY,
    HL_NETWORK: source.HL_NETWORK,
    HL_ACCOUNT_ADDRESS: source.HL_ACCOUNT_ADDRESS,
    AUTO_EXIT_ENABLED: source.AUTO_EXIT_ENABLED,
    AUTO_EXIT_CRON_SECRET: source.AUTO_EXIT_CRON_SECRET,
    CRON_SECRET: source.CRON_SECRET,
    LADDER_LIVE_ENABLED: source.LADDER_LIVE_ENABLED,
    LADDER_AUTOFIRE_ENABLED: source.LADDER_AUTOFIRE_ENABLED,
    LADDER_CRON_SECRET: source.LADDER_CRON_SECRET,
  });
}
