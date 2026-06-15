/**
 * Zod-validated environment. Centralizes every env var the cockpit reads so a
 * misconfiguration fails loudly at the edge instead of mysteriously downstream.
 *
 * TRADING_MODE itself is read via env/mode.ts (the single mode switch); it is
 * mirrored into the schema here so `validateEnv()` can sanity-check the whole
 * set together. The service-role Supabase key is server-only and MUST NOT be
 * referenced from client code (ADR-0002).
 */

import { z } from 'zod';

const envSchema = z.object({
  TRADING_MODE: z.enum(['paper', 'live']).default('paper'),

  // Supabase (public — safe in the browser bundle).
  NEXT_PUBLIC_SUPABASE_URL: z.string().url().optional(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1).optional(),

  // Supabase service role (SERVER ONLY — never ship to client).
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),

  // Admin gate (vendored auth).
  ADMIN_SECRET: z.string().min(1).optional(),
  ADMIN_PIN: z.string().min(1).optional(),
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
    NEXT_PUBLIC_SUPABASE_URL: source.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: source.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: source.SUPABASE_SERVICE_ROLE_KEY,
    ADMIN_SECRET: source.ADMIN_SECRET,
    ADMIN_PIN: source.ADMIN_PIN,
  });
}
