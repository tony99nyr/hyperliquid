import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const sourceRoot = path.resolve(process.cwd(), 'src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(fullPath) : /\.(ts|tsx)$/.test(entry.name) ? [fullPath] : [];
  });
}

describe('trading seam static pins', () => {
  it('keeps fill source decisions inside the fill source modules', () => {
    const violations: string[] = [];
    const sourceBranch = /\bfill\.source\s*!==?\s*['"](?:paper|live)['"]|\bfill\.source\s*===\s*['"](?:paper|live)['"]|switch\s*\(\s*fill\.source\s*\)/;
    for (const file of sourceFiles(sourceRoot)) {
      const relative = path.relative(sourceRoot, file).replaceAll('\\', '/');
      if (relative.startsWith('lib/trading/fill-source')) continue;
      if (sourceBranch.test(readFileSync(file, 'utf8'))) violations.push(relative);
    }
    expect(violations).toEqual([]);
  });

  it('keeps direct TRADING_MODE environment reads in env/mode.ts', () => {
    const violations: string[] = [];
    for (const file of sourceFiles(sourceRoot)) {
      const relative = path.relative(sourceRoot, file).replaceAll('\\', '/');
      if (relative === 'lib/env/mode.ts') continue;
      if (/process\.env\.TRADING_MODE|process\.env\[['"]TRADING_MODE['"]\]/.test(readFileSync(file, 'utf8'))) {
        violations.push(relative);
      }
    }
    expect(violations).toEqual([]);
  });
});
