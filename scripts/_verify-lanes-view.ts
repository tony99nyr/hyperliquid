/** Browser verification for the cockpit lanes view. Run with `pnpm verify:lanes`. */
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdir } from 'node:fs/promises';
import net from 'node:net';
import { allowLanesConsoleError, endpointsMatch, hasRawIsoTimestamp, hasVisibleChartVariation, loadLanesFixture, markerLegendState, orderedUnique, pathYValues, type LanesFailureStep } from './lanes-verifier-helpers';

try { process.loadEnvFile('.env.local'); } catch { /* env can come from the shell */ }

const adminPin = process.env.ADMIN_PIN;
const strict = process.argv.includes('--strict');
const dev = process.argv.includes('--dev');
const outDir = process.env.VERIFY_OUT ?? './.verify-lanes';
function skip(reason: string): never {
  console.log(`SKIP  ${reason}`);
  process.exit(strict ? 1 : 0);
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, () => {
      const address = server.address();
      if (address && typeof address === 'object') server.close(() => resolve(address.port));
      else server.close(() => reject(new Error('Could not allocate a port')));
    });
  });
}

async function waitForServer(url: string): Promise<boolean> {
  const end = Date.now() + 60_000;
  while (Date.now() < end) {
    try { const response = await fetch(url, { redirect: 'manual' }); if (response.status) return true; } catch { /* wait */ }
    await delay(400);
  }
  return false;
}

async function main(): Promise<void> {
  if (!adminPin) skip('ADMIN_PIN not set');
  let chromium: typeof import('@playwright/test').chromium;
  try { ({ chromium } = await import('@playwright/test')); }
  catch { skip('@playwright/test is not installed'); }

  let browser;
  try { browser = await chromium.launch({ headless: true, channel: 'chrome' }); }
  catch {
    try { browser = await chromium.launch({ headless: true }); }
    catch (error) { skip(`No browser available (${String(error).split('\n')[0]})`); }
  }

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let server: ChildProcess | null = null;
  const errors: string[] = [];
  let failureStep: LanesFailureStep = null;
  try {
    if (!dev) {
      console.log('Building application…');
      const build = spawn('pnpm', ['build'], { stdio: 'inherit' });
      const buildCode = await new Promise<number>((resolve) => build.once('exit', (code) => resolve(code ?? 1)));
      if (buildCode !== 0) throw new Error('Application build failed');
    }
    server = spawn('pnpm', ['exec', 'next', dev ? 'dev' : 'start', '-p', String(port)], { stdio: 'inherit', env: { ...process.env } });
    if (!(await waitForServer(base))) throw new Error('Application server did not start within 60 seconds');

    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin: adminPin }),
    });
    if (!login.ok) throw new Error(`Admin sign-in failed with HTTP ${login.status}`);
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
    const equals = cookie.indexOf('=');
    if (equals < 1) throw new Error('Admin sign-in did not return a session cookie');

    await mkdir(outDir, { recursive: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
    await context.addCookies([{ name: cookie.slice(0, equals), value: cookie.slice(equals + 1), domain: '127.0.0.1', path: '/' }]);
    const page = await context.newPage();
    await page.clock.install();
    page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      if (allowLanesConsoleError(message.text(), failureStep)) return;
      errors.push(`console.error (step ${failureStep ?? 'none'}): ${message.text()}`);
    });
    // Name the endpoint behind any server error, so a failure is actionable.
    page.on('response', (response) => {
      if (response.status() >= 500 && failureStep === null) errors.push(`HTTP ${response.status()} from ${new URL(response.url()).pathname}`);
    });

    // Keep report data local and deterministic. The route is matched by endpoint,
    // so the verifier never calls a database or external service for lane data.
    const fixture = await loadLanesFixture(process.env.LANES_FIXTURE_JSON);
    let mode: 'ok' | '404' | '401' | '500' | 'non-json' | 'network' | 'slow' = 'ok';
    let confirmMode: 'ok' | '500' = 'ok';
    await page.route(/\/api\/cockpit\/lane-performance(?:\?.*)?$/, async (route) => {
      if (mode === '404') return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'Fixture unavailable' }) });
      if (mode === '401') return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'Unauthorised' }) });
      if (mode === '500') return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'Fixture failure' }) });
      if (mode === 'non-json') return route.fulfill({ status: 200, contentType: 'text/html', body: '<html>upstream error</html>' });
      if (mode === 'network') return route.abort('failed');
      if (mode === 'slow') await new Promise((resolve) => setTimeout(resolve, 2_000));
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixture) });
    });
    await page.route('**/api/cockpit/lane-performance/markers/confirm', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      return route.fulfill({ status: confirmMode === '500' ? 500 : 200, contentType: 'application/json', body: JSON.stringify({ ok: confirmMode === 'ok', error: 'Could not confirm marker' }) });
    });

    await page.goto(`${base}/cockpit?tab=lanes`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const laneView = page.getByTestId('lanes-view');
    await laneView.waitFor({ state: 'visible', timeout: 15_000 });
    for (const [tab, shot] of [['Overview', '01-overview'], ['Lanes', '02-lanes'], ['Forecast', '03-forecast'], ['Change log', '04-changes']] as const) {
      const button = laneView.getByRole('button', { name: tab, exact: true });
      await button.waitFor({ state: 'visible', timeout: 10_000 });
      await button.click();
      await laneView.locator(`button[aria-pressed="true"]`).filter({ hasText: tab }).waitFor({ state: 'visible', timeout: 10_000 }).catch(() => undefined);
      if (hasRawIsoTimestamp(await laneView.innerText(), fixture.notes)) errors.push(`${tab}: found an ISO timestamp in visible dates`);
      if (tab === 'Lanes') {
        if (!(await laneView.getByTestId('lane-card').count())) errors.push('Lanes subview: expected a fixture lane card');
        const meanRText = await laneView.getByTestId('lane-card').first().getByText('Mean R per trade').evaluate((label) => label.nextElementSibling?.textContent ?? '');
        if (!/[-+]?\d+(?:\.\d+)?R/.test(meanRText) || meanRText.includes('$')) errors.push('Lanes subview: a mean R figure rendered as money or without R');
        const sparkline = laneView.getByRole('img', { name: /cumulative net USD/ }).first();
        if (await sparkline.count()) {
          const size = await sparkline.evaluate((element) => {
            const chart = element.getBoundingClientRect();
            const card = element.closest('[data-testid="lane-card"]')!.getBoundingClientRect();
            return { chartWidth: chart.width, cardWidth: card.width, height: chart.height };
          });
          if (size.chartWidth < size.cardWidth - 40 || size.height < 40 || size.height > 55) errors.push('Lanes subview: sparkline does not fill the card at about 48px');
        }
      }
      if (tab === 'Overview') {
        const legendState = markerLegendState(fixture);
        if (legendState === 'legend' && !(await laneView.getByLabel('Confirmed change marker legend').isVisible())) errors.push('Overview: marker legend missing');
        if (legendState !== 'legend' && await laneView.getByLabel('Confirmed change marker legend').count()) errors.push('Overview: unexpected confirmed marker legend');
      }
      if (tab === 'Overview') {
        // Date ticks only ("5 Jul"): the y-axis also uses tick-value text, so filter by shape.
        const ticks = await laneView.locator('[role="img"] .recharts-cartesian-axis-tick-value').evaluateAll((elements) => elements
          .map((element) => ({ label: element.textContent?.trim() ?? '', x: element.getBoundingClientRect().x }))
          .filter(({ label, x }) => /^\d{1,2} [A-Z][a-z]{2,3}$/.test(label) && Number.isFinite(x)));
        if (ticks.length < 2) errors.push('Overview: expected at least two SVG date tick labels');
        else {
          const labels = ticks.map((tick) => tick.label);
          if (new Set(labels).size !== labels.length || !orderedUnique(ticks.map((tick) => tick.x))) errors.push('Overview: SVG date tick labels are duplicated or out of order');
        }
        const chart = laneView.getByRole('img', { name: 'Cumulative net profit and loss for live and scout lanes, with confirmed change markers' });
        if (await chart.count()) {
          // Browser side returns raw attributes only; Node-side helpers parse them.
          const rawPaths = await chart.locator('svg path[stroke]').evaluateAll((paths) => paths.map((path) => ({
            stroke: path.getAttribute('stroke'), className: path.getAttribute('class'),
            boxHeight: (path as SVGGraphicsElement).getBBox().height, d: path.getAttribute('d') ?? '',
          })));
          const geometry = rawPaths.map((path) => {
            const ys = pathYValues(path.d);
            return { ...path, yValues: ys, startY: ys[0], endY: ys.at(-1) };
          });
          const linePaths = geometry.filter((path) => path.className?.includes('recharts-area-curve') && path.stroke !== 'none');
          for (const [index, label] of ['live', 'scout'].entries()) {
            const series = linePaths[index];
            if (!series || !hasVisibleChartVariation({ height: series.boxHeight, yValues: series.yValues })) errors.push(`Overview: ${label} line has insufficient visible variation`);
          }
          const livePath = linePaths[0];
          const coneD = await chart.locator('svg path.recharts-area-area[fill="rgba(117,160,255,.38)"]').first()
            .evaluate((path) => path.getAttribute('d') ?? '').catch(() => null);
          const cone = coneD === null ? null : (pathYValues(coneD)[0] ?? null);
          if (livePath?.endY === undefined || cone === null || !endpointsMatch(livePath.endY, cone)) errors.push('Overview: forecast cone does not start at the live line endpoint');
        }
        const selected = laneView.getByRole('button', { name: 'Overview', exact: true });
        const unselected = laneView.getByRole('button', { name: 'Lanes', exact: true });
        const styles = await Promise.all([selected, unselected].map((item) => item.evaluate((element) => {
          const style = getComputedStyle(element); return `${style.backgroundColor}|${style.borderColor}|${style.color}`;
        })));
        if (styles[0] === styles[1]) errors.push('Subview selected state has no computed style contrast');
      }
      if (tab === 'Forecast' && !(await laneView.getByText('Expected monthly').isVisible())) errors.push('Forecast: expected monthly tile missing');
      if (tab === 'Forecast') {
        const forecastChart = laneView.getByRole('img', { name: 'Forecast fan from P5 to P95, with dashed P50' });
        const coneArea = forecastChart.locator('svg path.recharts-area-area');
        await coneArea.first().waitFor({ state: 'attached', timeout: 10_000 }).catch(() => undefined);
        const filledPaths = await coneArea.evaluateAll((paths) => paths.filter((path) => {
          const fill = path.getAttribute('fill') ?? getComputedStyle(path).fill;
          return Boolean(fill) && fill !== 'none';
        }).length);
        if (!filledPaths) errors.push('Forecast: expected a shaded forecast cone after today');
      }
      if (tab === 'Change log' && (await laneView.getByTestId('marker-row').count()) !== fixture.markers.length) errors.push('Change log: marker row count differs from the fixture');
      if (tab === 'Change log' && markerLegendState(fixture) === 'migration-empty' && !(await laneView.getByText('Markers need migration 0046').isVisible())) errors.push('Change log: expected the migration-0046 empty marker state');
      if (tab === 'Change log' && markerLegendState(fixture) === 'empty' && !(await laneView.getByText('No change markers yet').isVisible())) errors.push('Change log: expected the plain empty marker state');
      await page.screenshot({ path: `${outDir}/${shot}.png`, fullPage: true });
    }
    await laneView.getByRole('button', { name: 'Lanes', exact: true }).click();
    for (const filter of ['All', 'Live', 'Scout']) {
      const before = await laneView.getByTestId('lane-card').count();
      await laneView.getByRole('button', { name: filter, exact: true }).click();
      await laneView.locator('button[aria-pressed="true"]').filter({ hasText: filter }).waitFor({ state: 'visible', timeout: 10_000 }).catch(() => undefined);
      const after = await laneView.getByTestId('lane-card').count();
      const selected = laneView.getByRole('button', { name: filter, exact: true });
      const otherName = filter === 'All' ? 'Live' : 'All';
      const other = laneView.getByRole('button', { name: otherName, exact: true });
      const filterStyles = await Promise.all([selected, other].map((item) => item.evaluate((element) => {
        const style = getComputedStyle(element); return `${style.backgroundColor}|${style.borderColor}|${style.color}`;
      })));
      if (filterStyles[0] === filterStyles[1]) errors.push(`${filter} filter selected state has no computed style contrast`);
      if (filter === 'Live' && after >= before) errors.push('Live filter did not reduce fixture lane cards');
      if (filter === 'Scout' && after !== fixture.lanes.filter((lane) => lane.kind === 'scout').length) errors.push('Scout filter did not show the fixture scout lanes');
    }
    await laneView.getByRole('button', { name: 'Change log', exact: true }).click();
    const splitMarker = fixture.markers.find((marker) => fixture.lanes.some((lane) => lane.markerSplits.some((split) => split.markerId === marker.id)));
    if (splitMarker) {
      await laneView.getByRole('button', { name: splitMarker.title }).click();
      if (!(await laneView.getByText(/before/).first().isVisible())) errors.push('Marker selection did not show before and after figures');
    }

    failureStep = 'get-404';
    mode = '404';
    await page.reload({ waitUntil: 'domcontentloaded' });
    await laneView.waitFor({ state: 'visible', timeout: 15_000 });
    await page.getByTestId('lanes-skew').waitFor({ state: 'visible', timeout: 10_000 }).catch(() => undefined);
    await page.screenshot({ path: `${outDir}/05-lanes-404.png`, fullPage: true });
    const notFoundBanner = page.getByTestId('lanes-skew');
    if (!(await notFoundBanner.isVisible().catch(() => false))) errors.push('404: expected a visible not-found banner');

    // First-load responses must select the matching explicit state.
    for (const [kind, expected] of [['401', 'Sign in again'], ['500', 'lanes-error'], ['non-json', 'lanes-error'], ['network', 'lanes-error']] as const) {
      failureStep = `get-${kind}` as LanesFailureStep;
      mode = kind;
      await page.reload({ waitUntil: 'domcontentloaded' });
      await laneView.waitFor({ state: 'visible', timeout: 15_000 });
      const target = expected === 'lanes-error' ? laneView.getByTestId(expected) : laneView.getByText(expected, { exact: false });
      await target.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => undefined);
      if (!(await target.isVisible().catch(() => false))) errors.push(`first-load ${kind}: expected ${expected}`);
      if (await laneView.getByTestId('lanes-skew').count()) errors.push(`first-load ${kind}: unexpected schema-skew state`);
    }
    failureStep = null;
    mode = 'slow';
    const slowNavigation = page.reload({ waitUntil: 'domcontentloaded' });
    const loading = laneView.getByText('Loading lane report…', { exact: true });
    await loading.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => undefined);
    if (!(await loading.isVisible().catch(() => false))) errors.push('slow first-load: expected Loading lane report…');
    if (await laneView.getByTestId('lanes-skew').count()) errors.push('slow first-load: unexpected schema-skew state');
    await slowNavigation;
    await laneView.getByTestId('lane-card').first().waitFor({ state: 'visible', timeout: 15_000 }).catch(() => undefined);

    // Restore the mock and settle BEFORE dropping the allowance.
    mode = 'ok';
    await page.reload({ waitUntil: 'domcontentloaded' });
    await laneView.waitFor({ state: 'visible', timeout: 15_000 });
    failureStep = null;
    await page.reload({ waitUntil: 'domcontentloaded' });
    await laneView.waitFor({ state: 'visible', timeout: 15_000 });
    await laneView.getByRole('button', { name: 'Overview', exact: true }).waitFor({ state: 'visible', timeout: 15_000 });
    failureStep = 'get-500';
    mode = '500';
    await page.clock.fastForward(60_000);
    const retry = page.getByRole('button', { name: /retry/i }).first();
    await laneView.getByTestId('lanes-error').waitFor({ state: 'visible', timeout: 10_000 }).catch(() => undefined);
    if (await laneView.getByTestId('lanes-skew').count()) errors.push('500: unexpected schema-skew state');
    await laneView.getByText(/Stale report from/).waitFor({ state: 'visible', timeout: 10_000 }).catch(() => undefined);
    if (!(await retry.isVisible().catch(() => false))) errors.push('500: expected an error message and Retry control');
    await page.screenshot({ path: `${outDir}/06-lanes-500.png`, fullPage: true });
    if (!(await laneView.getByText(/Stale report from/).isVisible().catch(() => false))) errors.push('500: expected the last good report to be marked stale');
    if (hasRawIsoTimestamp(await laneView.innerText(), fixture.notes)) errors.push('500: found an ISO timestamp in the stale report view');
    if (!(await retry.isVisible().catch(() => false))) errors.push('500: expected an error message and Retry control');
    if (await retry.isVisible().catch(() => false)) {
      await retry.click();
      await laneView.getByTestId('lanes-error').waitFor({ state: 'visible', timeout: 10_000 }).catch(() => undefined);
      if (!(await laneView.getByText(/Stale report from/).isVisible().catch(() => false))) errors.push('500 retry: expected the last good report to remain stale');
    }
    // Settle before dropping the allowance: reload on the healthy mock so no request
    // answered during the failure step can log after it ends.
    mode = 'ok';
    await page.reload({ waitUntil: 'domcontentloaded' });
    await laneView.waitFor({ state: 'visible', timeout: 15_000 });
    failureStep = null;

    // Confirmation failure should be shown inline and must not disappear.
    mode = 'ok'; confirmMode = '500';
    await page.reload({ waitUntil: 'domcontentloaded' });
    await laneView.waitFor({ state: 'visible', timeout: 15_000 });
    await laneView.getByRole('button', { name: 'Change log', exact: true }).click();
    const proposedMarker = fixture.markers.find((marker) => marker.confirmed_at === null);
    const proposedRow = proposedMarker ? laneView.getByTestId('marker-row').filter({ has: laneView.getByRole('button', { name: proposedMarker.title }) }) : null;
    const confirm = proposedRow?.getByRole('button', { name: 'Confirm', exact: true });
    failureStep = 'confirm-500';
    if (proposedRow && confirm && await confirm.isVisible().catch(() => false)) {
      await confirm.click();
      await proposedRow.getByRole('alert').waitFor({ state: 'visible', timeout: 10_000 }).catch(() => undefined);
      if (!(await proposedRow.getByRole('alert').isVisible().catch(() => false))) errors.push('confirm POST 500: expected an inline error on the proposed marker row');
      if (!(await proposedRow.getByText('Proposed', { exact: true }).isVisible().catch(() => false))) errors.push('confirm POST 500: marker row did not stay proposed');
    }
    await page.screenshot({ path: `${outDir}/07-lanes-confirm-error.png`, fullPage: true });
    confirmMode = 'ok';
    failureStep = null;

    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await laneView.waitFor({ state: 'visible', timeout: 15_000 });
    for (const tab of ['Overview', 'Lanes', 'Forecast', 'Change log']) {
      await laneView.getByRole('button', { name: tab, exact: true }).click();
      if (tab === 'Lanes' && fixture.lanes.some((lane) => lane.series.length)) {
        const sparkline = laneView.getByRole('img', { name: /cumulative net USD/ }).first();
        const width = await sparkline.evaluate((element) => element.getBoundingClientRect().width);
        if (width < 250) errors.push('mobile Lanes: the sparkline is missing or too narrow');
      }
      const overflow = await page.evaluate(() => (document.scrollingElement?.scrollWidth ?? 0) > window.innerWidth);
      if (overflow) errors.push(`mobile ${tab}: page overflows horizontally at 390x844`);
      const tooSmall = await laneView.locator('button:visible, a:visible').evaluateAll((items) => items.some((item) => {
        const rect = item.getBoundingClientRect(); return rect.width < 44 || rect.height < 44;
      }));
      if (tooSmall) errors.push(`mobile ${tab}: a visible button or link is smaller than 44x44`);
      await page.screenshot({ path: `${outDir}/08-lanes-mobile-${tab.toLowerCase().replace(' ', '-')}.png`, fullPage: true });
    }

    await context.close();
  } finally {
    await browser.close();
    if (server && !server.killed) server.kill('SIGTERM');
  }
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(`PASS  lanes view verified; screenshots saved in ${outDir}`);
}

void main().catch((error) => { console.error(`FAIL  ${String(error)}`); process.exit(1); });
