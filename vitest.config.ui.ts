import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/ui/**/*.test.tsx'],
    pool: 'threads',
    testTimeout: 10000,
    reporters: ['dot'],
    env: { NODE_ENV: 'test' },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@styled-system': path.resolve(__dirname, './styled-system'),
      // `server-only` throws when imported outside a React Server Component;
      // stub it to a no-op so server modules (e.g. supabase-server) are testable.
      'server-only': path.resolve(__dirname, './tests/stubs/server-only.ts'),
    },
  },
});
