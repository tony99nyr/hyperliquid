/**
 * Storyboard: the Scout tab heartbeat line ("watch: Nm ago · cycle: Nm ago").
 * Renders the real ScoutPanel once per heartbeat state, with the realtime hook
 * replaced by fixture rows, and writes storyboard-out/scout-heartbeat/index.html.
 */
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import fs from 'fs';
import path from 'path';
import ScoutPanel from '@/app/cockpit/components/ScoutPanel';
import type { ScoutHeartbeat } from '@/hooks/useScoutHeartbeat';

const state = vi.hoisted(() => ({ rows: [] as ScoutHeartbeat[] }));
vi.mock('@/hooks/useScoutHeartbeat', () => ({
  useScoutHeartbeat: () => ({ rows: state.rows, loaded: true, error: null, subscribed: true }),
}));

const MIN = 60_000;
const hb = (source: string, agoMs: number): ScoutHeartbeat => ({
  id: source, source, lastTickMs: Date.now() - agoMs, status: 'ok', detail: '',
});
const CRONS = [hb('reconcile', 40_000), hb('auto-exit-cron', 70_000), hb('reconcile-ok', 2 * MIN)];

const FRAMES: { id: string; title: string; caption: string; rows: ScoutHeartbeat[] }[] = [
  { id: 'hb-live', title: 'Scout alive', caption: 'scout-watch ticked 12 s ago and the cycle ran 14 min ago. The prod cron rows are also in the table.', rows: [...CRONS, hb('scout-watch', 12_000), hb('scout-cycle', 14 * MIN)] },
  { id: 'hb-watch-stale', title: 'Producer stale', caption: 'scout-watch last ticked 9 min ago (past the 5 min window), so the watch age shows red.', rows: [...CRONS, hb('scout-watch', 9 * MIN), hb('scout-cycle', 20 * MIN)] },
  { id: 'hb-no-scout-row', title: 'No scout-watch row, cron rows present (CHANGED)', caption: 'The scout never ticked, but cron rows ticked 40 s ago. Before: "watch: 40s ago" from the reconcile row. Now: "watch: —".', rows: [...CRONS] },
  { id: 'hb-empty', title: 'Empty table', caption: 'No heartbeat rows at all. Both ages show "—" (unchanged).', rows: [] },
  { id: 'hb-cycle-stale', title: 'Consumer stale', caption: 'scout-watch is fresh but the cycle last ran 3.5 h ago, so the cycle age shows red.', rows: [...CRONS, hb('scout-watch', 20_000), hb('scout-cycle', 210 * MIN)] },
];

const OUT = path.resolve(__dirname, '../../storyboard-out/scout-heartbeat');

describe('storyboard: scout heartbeat', () => {
  it('writes every frame', () => {
    const frames = FRAMES.map((f) => {
      state.rows = f.rows;
      const { container, unmount } = render(
        <ScoutPanel hypsOverride={[]} decisionsOverride={[]} perfOverride={null} lanesOverride={null}
          positionsOverride={{ positions: [], latestPnlByCoin: {} }} />,
      );
      const html = container.innerHTML;
      unmount();
      expect(html).toContain('data-testid="scout-heartbeat"');
      return `<section class="frame" data-frame="${f.id}"><h2>${f.id} · ${f.title}</h2><p>${f.caption}</p><div class="panel">${html}</div></section>`;
    });
    const page = `<!DOCTYPE html><html lang="en-GB"><head><meta charset="utf-8"><title>Scout heartbeat storyboard</title>
<link rel="stylesheet" href="panda.css"><style>
html,body{background:#0d1117}body{color:#e6edf3;font:14px system-ui,sans-serif;padding:24px 16px}
h1{font-size:18px;font-weight:600;margin:0 0 6px}.lede{color:#8b949e;margin:0 0 20px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(390px,100%),1fr));gap:20px}
.frame h2{font-size:14px;font-weight:600;margin:0 0 4px}.frame p{color:#8b949e;font-size:12px;line-height:1.4;margin:0 0 10px}
@media (min-width:800px){.frame h2{min-height:2.6em}.frame p{min-height:4.2em}}
.panel{max-width:420px}</style></head><body>
<h1>Scout tab: producer heartbeat states</h1>
<p class="lede">Real ScoutPanel, rendered with fixture scout_heartbeat rows. Each frame shows the panel at phone width.</p>
<div class="grid">${frames.join('\n')}</div></body></html>`;
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, 'index.html'), page);
  });
});
