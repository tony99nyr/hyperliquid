import { defineConfig } from 'vitest/config';
import ui from './vitest.config.ui';

// Storyboard harness: renders real cockpit components with fixture data into
// storyboard-out/. Run with `pnpm storyboard`. Not part of `pnpm test`.
export default defineConfig({ ...ui, test: { ...ui.test, include: ['tests/ui-storyboard/**/*.storyboard.tsx'] } });
