import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * THE no-trade guarantee for the trade-watch service. It is WATCH-ONLY: it polls
 * leaders and writes leader_positions/leader_actions, and must NEVER reach the
 * trade/execution path. We enforce this STATICALLY — no module under
 * `src/lib/trader-watch/**` (nor scripts/trader-watch.ts) may import the fill
 * source, executeIntent, the live/paper fill modules, or the position-tracker's
 * write path. A static check makes it impossible to even pull the trade code into
 * the service bundle. Mirrors tests/lib/watch/no-trade-guarantee.test.ts.
 */

const REPO_ROOT = join(__dirname, '..', '..', '..');
const SERVICE_LIB_DIR = join(REPO_ROOT, 'src', 'lib', 'trader-watch');
const SERVICE_SCRIPT = join(REPO_ROOT, 'scripts', 'trader-watch.ts');

/** Import specifiers that would constitute a trade/execution path. */
const FORBIDDEN_IMPORTS = [
  '@/lib/trading/fill-source',
  '@/lib/trading/fill-source-paper',
  '@/lib/trading/fill-source-live',
  '@/lib/trading/position-tracker',
  './fill-source',
  '../trading/fill-source',
];

/** Forbidden call expressions (defense-in-depth against a dynamic import/alias). */
const FORBIDDEN_CALLS = ['executeIntent', 'liveFill', 'paperFill', 'applyFillToPosition'];

function collectTsFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectTsFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('trade-watch service — no-trade guarantee (static)', () => {
  const files = [...collectTsFiles(SERVICE_LIB_DIR), SERVICE_SCRIPT];

  it('found the service source files to scan', () => {
    expect(files.length).toBeGreaterThanOrEqual(3); // business-logic, service, script
  });

  for (const file of files) {
    it(`${file.replace(REPO_ROOT, '')} does not import the trade/execution path`, () => {
      const src = readFileSync(file, 'utf8');
      // Strip block + line comments so a docstring mentioning executeIntent (these
      // modules document WHY they don't trade) is not a false positive.
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

      for (const spec of FORBIDDEN_IMPORTS) {
        expect(
          code.includes(`'${spec}'`) || code.includes(`"${spec}"`),
          `must not import ${spec}`,
        ).toBe(false);
      }
      for (const call of FORBIDDEN_CALLS) {
        const re = new RegExp(`\\b${call}\\s*\\(`);
        expect(re.test(code), `must not call ${call}()`).toBe(false);
      }
    });
  }
});
