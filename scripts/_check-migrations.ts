import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { line, run } from './_skill-runtime';
import { mergeMigrationInventories, parseMigrationSql } from './_migration-parser';

interface OpenApiDocument {
  paths?: Record<string, unknown>;
}

function envValue(...names: string[]): string | undefined {
  return names.map((name) => process.env[name]).find((value) => value !== undefined && value !== '');
}

async function check(): Promise<void> {
  const baseUrl = envValue('HL_TRADERS_SUPABASE_URL', 'HL_SUPABASE_URL', 'NEXT_PUBLIC_HL_SUPABASE_URL', 'SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL');
  const apiKey = envValue('HL_TRADERS_SUPABASE_SERVICE_ROLE_KEY', 'HL_TRADERS_SUPABASE_SECRET_KEY', 'HL_SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'NEXT_PUBLIC_HL_SUPABASE_ANON_KEY', 'NEXT_PUBLIC_SUPABASE_ANON_KEY');
  if (!baseUrl || !apiKey) throw new Error('Set a Supabase URL and API key in .env.local. All requests are read-only.');

  const directory = path.resolve(process.cwd(), 'supabase/migrations');
  const migrationFiles = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
  const inventory = mergeMigrationInventories(await Promise.all(migrationFiles.map(async (name) =>
    parseMigrationSql(await readFile(path.join(directory, name), 'utf8')),
  )));

  const headers = { apikey: apiKey, authorization: `Bearer ${apiKey}` };
  const openApiResponse = await fetch(`${baseUrl.replace(/\/$/, '')}/rest/v1/`, { headers });
  if (!openApiResponse.ok) throw new Error(`PostgREST schema request failed: ${openApiResponse.status}`);
  const openApi = await openApiResponse.json() as OpenApiDocument;
  const paths = openApi.paths ?? {};
  const missing: string[] = [];
  for (const [table, columns] of inventory.tables) {
    const columnsQuery = [...columns].join(',');
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/rest/v1/${encodeURIComponent(table)}?select=${encodeURIComponent(columnsQuery)}&limit=0`, {
      method: 'HEAD', headers,
    });
    if (response.ok) continue;
    // Narrow the failure to the exact columns, so drift is actionable.
    const absent: string[] = [];
    for (const column of columns) {
      const probe = await fetch(`${baseUrl.replace(/\/$/, '')}/rest/v1/${encodeURIComponent(table)}?select=${encodeURIComponent(column)}&limit=0`, { method: 'HEAD', headers });
      if (!probe.ok) absent.push(column);
    }
    missing.push(`table/columns ${table} (${response.status})${absent.length ? `: ${absent.join(', ')}` : ''}`);
  }
  for (const fn of inventory.functions) {
    if (!Object.keys(paths).some((route) => route.toLowerCase() === `/rpc/${fn}`)) missing.push(`function ${fn}`);
  }
  if (missing.length) throw new Error(`Migration objects missing from Supabase:\n${missing.map((item) => `- ${item}`).join('\n')}`);
  line(`PASS ${migrationFiles.length} migrations: ${inventory.tables.size} tables and ${inventory.functions.size} functions exist.`);
  line('PostgREST exposes tables through read-only HEAD requests and functions through its read-only OpenAPI document.');
  line('The script sends only GET and HEAD requests. Service-role access may be needed to list service-role-only functions.');
}

run(check);
