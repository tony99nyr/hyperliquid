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

/**
 * A 'true'/'false' feature flag that tolerates the empty string. The Vercel CLI's
 * stdin-piped `env add` has TWICE stored `""` instead of the intended value (08-01
 * REVERSION_ALERT_ENABLED, 08-19 RUNAWAY_ALERT_ENABLED) — and a bare enum REJECTS ''
 * (only `undefined` triggers .default), which makes validateEnv() throw APP-WIDE and
 * takes the watcher down with it. Treat ''/null as unset → the safe default 'false'.
 */
const warnedEmptyFlags = new Set<string>();
const boolFlag = (name: string) =>
  z.preprocess(
    (v) => {
      // Present-but-empty = the CLI bug ate an intended value. Reading it as OFF is the
      // safe default, but say so — NAMED and once per process (validateEnv re-parses on
      // every call; an anonymous per-request warn would spam and still be unactionable).
      if (v === '' && !warnedEmptyFlags.has(name)) {
        warnedEmptyFlags.add(name);
        console.warn(`[env] ${name} is set to an EMPTY string (the vercel-CLI stdin bug?) — treating as false`);
      }
      return v === '' || v == null ? undefined : v;
    },
    z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
  );

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

  // --- Household exposure read (Phase 3) — iamrossi's on-chain Base Safe wallets,
  // READ-ONLY public-chain state (no coupling). Unset ⇒ the read returns null and
  // the cockpit/scout simply show no household context. Awareness + sizing only. ---
  IAMROSSI_SAFE_ETH: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  IAMROSSI_SAFE_BTC: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  BASE_RPC_URL: z.string().url().optional(),

  // --- Cross-system stance bridge (restored 2026-07-25; the iamrossi 8h trend system's
  // read-only GET /api/trading/stance). Unset ⇒ fetchTrendStance() returns null and the
  // trend-alert lane + flip guard simply no-op. READ-ONLY consumer, contractually
  // fail-open: an iamrossi outage must never break anything here. ---
  // Deliberately loose (.min would make validateEnv THROW app-wide on a typo'd
  // optional var, taking the ladder watcher down with it): the ≥16-char contract
  // is enforced in trend-stance-service, where too-short degrades to "unconfigured".
  IAMROSSI_STANCE_URL: z.string().url().optional(),
  IAMROSSI_STANCE_TOKEN: z.string().optional(),

  // --- Layer-1 auto-exit (exit-only safety net; see docs/LIVE_AUTO_EXIT.md) ---
  // Master kill-switch. Default OFF: the risk-exit endpoint refuses to fire and
  // the detector no-ops unless this is explicitly 'true'. EXIT-ONLY when on.
  AUTO_EXIT_ENABLED: boolFlag('AUTO_EXIT_ENABLED'),
  // Dedicated bearer token for the detector/cron to call /api/cockpit/risk-exit.
  // Separate from ADMIN_SECRET so the NAS/cron never holds the admin credential.
  AUTO_EXIT_CRON_SECRET: z.string().min(1).optional(),

  // --- Armed Ladder (see docs/ARMED_LADDER_ARCHITECTURE.md) ---
  // Capability gate for LIVE ladders: a LIVE-mode ladder can be ARMED (the operator
  // authorization) only when this is 'true'. PAPER ladders work regardless. Default
  // OFF. NOTE: arming ≠ executing — this does NOT let the watcher fire autonomously;
  // that is the SEPARATE LADDER_AUTOFIRE_ENABLED switch below.
  LADDER_LIVE_ENABLED: boolFlag('LADDER_LIVE_ENABLED'),
  // The "automatic execute" kill-switch — INDEPENDENT of TRADING_MODE and
  // LADDER_LIVE_ENABLED. Only when this is 'true' may the NAS watcher / fire-rung route
  // (P1d) AUTONOMOUSLY execute a pre-armed rung while the operator is AFK. Default OFF,
  // and deliberately kept OFF even when the cockpit is fully live for MANUAL execution:
  // going live ≠ enabling AFK auto-fire. The fire route checks this as its single
  // enforcement point (invariant §4b.7 kill-switch) before any autonomous fill.
  LADDER_AUTOFIRE_ENABLED: boolFlag('LADDER_AUTOFIRE_ENABLED'),
  // Reversion-alert: when 'true', the ladder-watch cron auto-DRAFTS a low-qty LIVE
  // ladder + pings Discord on a fresh reversion-extreme candidate (the one proven-ish
  // edge). DRAFT only — it NEVER arms (the human gate holds); default OFF.
  REVERSION_ALERT_ENABLED: boolFlag('REVERSION_ALERT_ENABLED'),
  // Public base URL of the deployed cockpit — used to build clickable Discord deep-links
  // (e.g. the reversion-alert 👉 ladders-page link). Defaults to the production alias.
  COCKPIT_BASE_URL: z.string().url().default('https://hyperliquid-rouge.vercel.app'),
  // Trend-alert: when 'true', the ladder-watch cron auto-DRAFTS a low-qty LIVE trend
  // ladder + pings Discord when the iamrossi 8h system turns bullish+confident on a
  // coin it's holding (the replacement for its retired Base leverage lane). DRAFT only
  // — it NEVER arms (the human gate holds); default OFF. Needs IAMROSSI_STANCE_URL/TOKEN.
  TREND_ALERT_ENABLED: boolFlag('TREND_ALERT_ENABLED'),
  // Runaway-alert (doctrine 08-19: "strong movements ARE a catalyst"): when 'true',
  // the ladder-watch cron auto-DRAFTS a low-qty LIVE continuation ladder + pings
  // Discord on an outsized 24h move (≥5%). DRAFT only — NEVER arms; default OFF.
  RUNAWAY_ALERT_ENABLED: boolFlag('RUNAWAY_ALERT_ENABLED'),
  // Dedicated bearer token for the NAS watcher to call /api/cockpit/ladder/fire-rung
  // (P1d). Separate from ADMIN_SECRET so the watcher never holds the admin credential.
  LADDER_CRON_SECRET: z.string().min(1).optional(),
  // EXTERNAL dead-man's-switch (healthchecks.io) ping URL. The ladder-watch cron pings
  // it each tick (/start → success, /fail on error); if pings stop, the external monitor
  // alerts — catching total app/cron outages a self-hosted heartbeat can't (the alerter
  // would be dead too). Optional; when unset the watcher simply doesn't ping.
  LADDER_WATCH_HEALTHCHECK_URL: z.string().url().optional(),
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
    REVERSION_ALERT_ENABLED: source.REVERSION_ALERT_ENABLED,
    COCKPIT_BASE_URL: source.COCKPIT_BASE_URL,
    TREND_ALERT_ENABLED: source.TREND_ALERT_ENABLED,
    RUNAWAY_ALERT_ENABLED: source.RUNAWAY_ALERT_ENABLED,
    IAMROSSI_STANCE_URL: source.IAMROSSI_STANCE_URL,
    IAMROSSI_STANCE_TOKEN: source.IAMROSSI_STANCE_TOKEN,
    LADDER_CRON_SECRET: source.LADDER_CRON_SECRET,
    LADDER_WATCH_HEALTHCHECK_URL: source.LADDER_WATCH_HEALTHCHECK_URL,
  });
}
