/**
 * Deny-by-default proof for the read-only viewer role.
 *
 * The test walks every src/app/api/**\/route.ts file and checks these rules:
 *   1. Route handlers are plain `export async function METHOD(` declarations.
 *   2. A viewer-accepting auth symbol appears only inside a GET handler.
 *   3. Every non-GET handler (except the login route) calls verifyAdminAuth or
 *      verifyCronBearer.
 *   4. The set of GET handlers that accept a viewer equals READ_ENDPOINTS, so a
 *      new viewer-readable endpoint needs a deliberate edit here.
 *   5. Outside the auth module, the page gate, the login route and the HL read
 *      proxy guard, no source file uses a viewer-accepting symbol (no wrapper can
 *      smuggle it into a POST). guardHlRoute counts as a viewer symbol, so it too
 *      may appear only inside a GET handler.
 * A behavioural check then calls every non-GET handler with a real viewer
 * session cookie and expects 401.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { issueViewerSessionToken, ADMIN_AUTH_COOKIE_CONFIG } from '@/lib/infrastructure/auth/auth';

const SRC = path.resolve(__dirname, '../../../src');
const API = path.join(SRC, 'app/api');

const VIEWER_SYMBOLS = [
  'verifyReadAuth',
  'getRequestAuthRole',
  'verifyViewerSessionToken',
  'verifyViewerPin',
  'issueViewerSessionToken',
  'roleForCookieToken',
  'getPageAuthRole',
  'guardHlRoute',
];

/** The only GET endpoints a viewer may read. Edit with care. */
const READ_ENDPOINTS = [
  'cockpit/account-risk',
  'cockpit/active-session',
  'cockpit/entry-trigger',
  'cockpit/ladder',
  'cockpit/ladder/[id]',
  'cockpit/lane-performance',
  'cockpit/performance',
  'cockpit/position-stop',
  'cockpit/position-tp',
  'cockpit/research-trader',
  'cockpit/scout-performance',
  'cockpit/stops',
  'cockpit/trader-positions',
  'hl/candles',
  'hl/regime',
].sort();

/** Files that may reference viewer symbols outside route GET handlers. */
const VIEWER_SYMBOL_ALLOWED_FILES = [
  'lib/infrastructure/auth/auth.ts',
  'lib/infrastructure/auth/server-auth.ts',
  'app/cockpit/page.tsx',
  'app/api/auth/login/route.ts',
  'app/api/hl/_guard.ts',
];

const UNAUTHENTICATED_NON_GET = ['auth/login'];
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const routeFiles = walk(API).filter((f) => f.endsWith('/route.ts'));
const endpointOf = (file: string) => path.relative(API, path.dirname(file)).split(path.sep).join('/');

/** Source with the import statements removed, so symbol counts ignore imports. */
const withoutImports = (src: string) => src.replace(/^import[\s\S]*?;\s*$/gm, '');

/** Each exported handler's body text: from its declaration to the next top-level declaration. */
function handlerBodies(src: string): Map<string, string> {
  const bodies = new Map<string, string>();
  const decl = /^export async function (GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\(/gm;
  const topLevel = /^(export |async function |function |const |let |var |type |interface |class )/gm;
  for (let m = decl.exec(src); m; m = decl.exec(src)) {
    topLevel.lastIndex = m.index + 1;
    const next = topLevel.exec(src);
    bodies.set(m[1], src.slice(m.index, next ? next.index : src.length));
  }
  return bodies;
}

const countSymbols = (text: string) =>
  VIEWER_SYMBOLS.reduce((n, s) => n + (text.match(new RegExp(`\\b${s}\\b`, 'g'))?.length ?? 0), 0);

describe('viewer deny-by-default (static)', () => {
  it('finds the route files', () => {
    expect(routeFiles.length).toBeGreaterThan(20);
  });

  it.each(routeFiles.map((f) => [endpointOf(f), f]))('%s declares handlers in the checked form', (_e, file) => {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of METHODS) {
      expect(src, `${m} must be "export async function ${m}("`).not.toMatch(new RegExp(`export\\s+(const|let|var)\\s+${m}\\b`));
      expect(src).not.toMatch(new RegExp(`\\bas\\s+${m}\\b`));
    }
    for (const s of VIEWER_SYMBOLS) expect(src).not.toMatch(new RegExp(`\\b${s}\\s+as\\b`));
  });

  it.each(routeFiles.filter((f) => !UNAUTHENTICATED_NON_GET.includes(endpointOf(f))).map((f) => [endpointOf(f), f]))(
    '%s: viewer symbols only inside GET; every non-GET handler is admin or cron only',
    (_e, file) => {
      const src = withoutImports(fs.readFileSync(file, 'utf8'));
      const bodies = handlerBodies(src);
      const inGet = countSymbols(bodies.get('GET') ?? '');
      expect(countSymbols(src), 'a viewer symbol sits outside the GET handler').toBe(inGet);
      for (const [method, body] of bodies) {
        if (method === 'GET') continue;
        expect(body, `${method} must call verifyAdminAuth or verifyCronBearer`).toMatch(/\b(verifyAdminAuth|verifyCronBearer)\(/);
      }
    },
  );

  it('the viewer-readable GET endpoints are exactly READ_ENDPOINTS', () => {
    const readable = routeFiles
      .filter((f) => /\b(verifyReadAuth|guardHlRoute)\(/.test(handlerBodies(fs.readFileSync(f, 'utf8')).get('GET') ?? ''))
      .map(endpointOf)
      .sort();
    expect(readable).toEqual(READ_ENDPOINTS);
  });

  it('no other source file uses a viewer-accepting symbol', () => {
    const offenders = walk(SRC)
      .map((f) => path.relative(SRC, f).split(path.sep).join('/'))
      .filter((rel) => !VIEWER_SYMBOL_ALLOWED_FILES.includes(rel))
      .filter((rel) => !(rel.startsWith('app/api/') && rel.endsWith('/route.ts')))
      .filter((rel) => countSymbols(fs.readFileSync(path.join(SRC, rel), 'utf8')) > 0);
    expect(offenders).toEqual([]);
  });
});

describe('viewer deny-by-default (behaviour)', () => {
  // Kill-switches return 403 before auth, so the test turns them on to reach the auth check.
  const ENV_KEYS = ['VIEWER_PIN', 'AUTO_EXIT_ENABLED', 'LADDER_AUTOFIRE_ENABLED', 'AGENT_ACTIONS_ENABLED'] as const;
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  let viewerCookie = '';

  beforeAll(() => {
    process.env.VIEWER_PIN = 'viewer-test-pin';
    process.env.AUTO_EXIT_ENABLED = 'true';
    process.env.LADDER_AUTOFIRE_ENABLED = 'true';
    process.env.AGENT_ACTIONS_ENABLED = 'true';
    const token = issueViewerSessionToken(60);
    if (!token) throw new Error('viewer token not issued');
    viewerCookie = `${ADMIN_AUTH_COOKIE_CONFIG.name}=${token}`;
  });
  afterAll(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  const targets = routeFiles
    .filter((f) => !UNAUTHENTICATED_NON_GET.includes(endpointOf(f)))
    .flatMap((f) => [...handlerBodies(fs.readFileSync(f, 'utf8')).keys()].filter((m) => m !== 'GET').map((m) => [endpointOf(f), m, f]));

  it.each(targets)('%s %s refuses a viewer session with 401', async (endpoint, method, file) => {
    const mod = (await import(file)) as Record<string, (req: NextRequest, ctx: unknown) => Promise<Response>>;
    const req = new NextRequest(`https://cockpit.test/api/${endpoint}`, {
      method,
      headers: { cookie: viewerCookie, origin: 'https://cockpit.test', host: 'cockpit.test', 'content-type': 'application/json' },
      body: '{}',
    });
    const res = await mod[method](req, { params: Promise.resolve({ id: 'x' }) });
    expect(res.status).toBe(401);
  });
});
