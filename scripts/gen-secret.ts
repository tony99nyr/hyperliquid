/**
 * gen-secret — print cryptographically-random token(s) for env secrets.
 *
 * Use the output for CRON_SECRET / AUTO_EXIT_CRON_SECRET / ADMIN_SECRET, etc.
 * Uses Node's CSPRNG (crypto.randomBytes) — safe as a bearer token / secret.
 *
 *   pnpm gen:secret              # one 32-byte hex token (64 chars)
 *   pnpm gen:secret --bytes 24   # custom length (16–64 bytes)
 *   pnpm gen:secret --count 3    # several at once
 *   pnpm gen:secret --base64     # base64url instead of hex
 */

import { randomBytes } from 'node:crypto';

const argv = process.argv.slice(2);

function num(flag: string, def: number): number {
  const i = argv.indexOf(flag);
  if (i === -1) return def;
  const n = Number(argv[i + 1]);
  return Number.isFinite(n) && n > 0 ? n : def;
}

const bytes = Math.max(16, Math.min(64, num('--bytes', 32)));
const count = Math.max(1, Math.min(50, num('--count', 1)));
const base64 = argv.includes('--base64');

for (let i = 0; i < count; i++) {
  const buf = randomBytes(bytes);
  console.log(base64 ? buf.toString('base64url') : buf.toString('hex'));
}
