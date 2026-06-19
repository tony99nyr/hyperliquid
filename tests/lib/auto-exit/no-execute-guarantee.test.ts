import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * No-execute guarantee for the auto-exit DETECTION layer. `src/lib/auto-exit/**`
 * holds detection + config + the lock — but NEVER the trade path. The single
 * autonomous exit-only execution site is performRiskExit in
 * `src/lib/trading/risk-exit-service.ts` (which legitimately imports
 * executeIntent). Keeping detection execution-free, enforced statically, means
 * the decision and the firing live in exactly one auditable place.
 */

const REPO_ROOT = join(__dirname, '..', '..', '..');
const AUTO_EXIT_DIR = join(REPO_ROOT, 'src', 'lib', 'auto-exit');

const FORBIDDEN_IMPORTS = [
  '@/lib/trading/fill-source',
  '@/lib/trading/fill-source-paper',
  '@/lib/trading/fill-source-live',
  '@/lib/trading/risk-exit-service',
  '@/lib/trading/position-tracker',
];

const FORBIDDEN_CALLS = ['executeIntent', 'liveFill', 'paperFill', 'applyFillToPosition', 'performRiskExit'];

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

describe('auto-exit detection — no-execute guarantee (static)', () => {
  const files = collectTsFiles(AUTO_EXIT_DIR);

  it('found the auto-exit source files to scan', () => {
    expect(files.length).toBeGreaterThanOrEqual(3); // config, risk-inputs, lock, scan
  });

  for (const file of files) {
    it(`${file.replace(REPO_ROOT, '')} does not import or call the trade/execution path`, () => {
      const src = readFileSync(file, 'utf8');
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      for (const spec of FORBIDDEN_IMPORTS) {
        expect(code.includes(`'${spec}'`) || code.includes(`"${spec}"`), `must not import ${spec}`).toBe(false);
      }
      for (const call of FORBIDDEN_CALLS) {
        expect(new RegExp(`\\b${call}\\s*\\(`).test(code), `must not call ${call}()`).toBe(false);
      }
    });
  }
});
