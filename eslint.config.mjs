import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([
    '.next/**',
    'out/**',
    'build/**',
    'next-env.d.ts',
    '**/styled-system/**',
    '**/coverage/**',
    '**/.vercel/**',
  ]),
  {
    rules: {
      // Keep files agent-friendly (CLAUDE.md: small single-purpose files <600 lines).
      'max-lines': ['error', { max: 600, skipBlankLines: true, skipComments: true }],
      // Allow intentionally-unused `_`-prefixed args (Phase 0 skeleton signatures).
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
  // Vendored strategy/analysis files exceed 600 lines as a single cohesive unit;
  // they arrived from iamrossi as-is and are not reorganized in Phase 0.
  {
    files: [
      '**/market-regime-detector-cached.ts',
      '**/market-regime-detector-helpers.ts',
      '**/risk-reward-validator.ts',
    ],
    rules: { 'max-lines': 'off' },
  },
  // Tests can be long.
  {
    files: ['**/*.test.ts', '**/*.test.tsx'],
    rules: { 'max-lines': 'off' },
  },
]);

export default eslintConfig;
