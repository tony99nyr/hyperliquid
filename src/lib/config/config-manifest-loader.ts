/**
 * Generic versioned-config-manifest loader (the config-manifest pattern).
 *
 * A config family lives in a directory with a `manifest.json`:
 *   { "active": "0.1.0", "versions": { "0.1.0": "weights-v0.1.0.json", ... } }
 * `loadActiveConfig(dir)` reads the manifest, resolves the `active` version to
 * its file, and returns that file's parsed JSON. Bumping `active` rolls a new
 * tuning forward without code changes; old files stay for reproducibility.
 *
 * Server-side only (reads from disk via `fs`). Pure consumers should accept the
 * loaded config as a parameter rather than calling this directly.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ConfigManifest {
  active: string;
  versions: Record<string, string>;
  description?: string;
}

/** Parse + minimally validate a manifest object. */
export function parseManifest(raw: unknown): ConfigManifest {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('config manifest: not an object');
  }
  const m = raw as Record<string, unknown>;
  if (typeof m.active !== 'string') {
    throw new Error('config manifest: missing string "active"');
  }
  if (typeof m.versions !== 'object' || m.versions === null) {
    throw new Error('config manifest: missing "versions" map');
  }
  const versions = m.versions as Record<string, unknown>;
  if (typeof versions[m.active] !== 'string') {
    throw new Error(`config manifest: active version "${m.active}" has no file entry`);
  }
  return {
    active: m.active,
    versions: versions as Record<string, string>,
    description: typeof m.description === 'string' ? m.description : undefined,
  };
}

/** Read + parse the manifest in `dir`. */
export function loadManifest(dir: string): ConfigManifest {
  const raw = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  return parseManifest(raw);
}

/**
 * Load the active config JSON for a manifest directory. Returns the parsed
 * contents of the file the manifest's `active` version points at.
 */
export function loadActiveConfig<T = unknown>(dir: string): T {
  const manifest = loadManifest(dir);
  const fileName = manifest.versions[manifest.active];
  const raw = readFileSync(join(dir, fileName), 'utf8');
  return JSON.parse(raw) as T;
}
