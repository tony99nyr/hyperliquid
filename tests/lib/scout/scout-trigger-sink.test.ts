import { describe, it, expect } from 'vitest';
import { appendFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendTriggersJsonl, recentTriggersJsonl, rotateTriggerFileIfLarge } from '@/lib/scout/scout-trigger-sink';
import { parseScoutDecision } from '@/lib/scout/scout-cycle-business-logic';
import type { ScoutTrigger } from '@/lib/scout/scout-trigger-business-logic';

const trig = (over: Partial<ScoutTrigger> = {}): ScoutTrigger => ({
  kind: 'rubric-jump', coin: 'HYPE', side: 'long', urgency: 'info', detail: 'opp 20→40', at: 1_700_000_000_000, ...over,
});

describe('ScoutTriggerSink — JSONL adapter round-trip (previously the only untested I/O)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scout-sink-'));
  const path = join(dir, 'triggers.jsonl');

  it('append → recent round-trips the trigger shape', () => {
    appendTriggersJsonl([trig(), trig({ coin: 'ETH', kind: 'price-move' })], path);
    const back = recentTriggersJsonl(10, path);
    expect(back).toHaveLength(2);
    expect(back[0].coin).toBe('HYPE');
    expect(back[1].kind).toBe('price-move');
    expect(back[0].id).toBeNull(); // file adapter has no ids/cursor
  });

  it('tails the most recent N and skips garbage lines', () => {
    appendTriggersJsonl([trig({ detail: 'newest' })], path);
    appendFileSync(path, 'NOT JSON\n');
    const back = recentTriggersJsonl(2, path);
    expect(back.length).toBeGreaterThanOrEqual(1);
    expect(back.some((t) => t.detail === 'newest')).toBe(true);
  });

  it('rotation keeps the file bounded and parseable', () => {
    const big = join(dir, 'big.jsonl');
    const many = Array.from({ length: 3000 }, (_, i) => trig({ detail: `t${i}`.padEnd(300, 'x') }));
    appendTriggersJsonl(many, big);
    rotateTriggerFileIfLarge(big);
    const back = recentTriggersJsonl(5, big);
    expect(back).toHaveLength(5);
    expect(back[4].detail.startsWith('t2999')).toBe(true); // newest survived
  });

  it('missing file → empty (never throws)', () => {
    expect(recentTriggersJsonl(5, join(dir, 'nope.jsonl'))).toEqual([]);
  });
});

describe('parseScoutDecision — the headless contract is strict (malformed NEVER trades)', () => {
  it('valid open maps to the CLI arg shape', () => {
    const r = parseScoutDecision(JSON.stringify({ action: 'open', coin: 'ETH', side: 'sell', riskUsd: 50, stopFrac: 0.03, leverage: 3, lane: 'directional', thesis: 'test' }));
    expect(r.kind).toBe('open');
    if (r.kind === 'open') {
      expect(r.args['coin']).toBe('ETH');
      expect(r.args['risk']).toBe('50');
      expect(r.args['stop-frac']).toBe('0.03');
      expect(r.args['lane']).toBe('directional');
    }
  });
  it('stand-down is first-class', () => {
    const r = parseScoutDecision('{"action":"stand-down","note":"chop"}');
    expect(r.kind).toBe('stand-down');
  });
  it('valid close requires sessionId and maps exit args', () => {
    const r = parseScoutDecision(JSON.stringify({ action: 'close', coin: 'ETH', sessionId: 's1', fraction: 0.5 }));
    expect(r.kind).toBe('close');
    if (r.kind === 'close') { expect(r.args['exit']).toBe(true); expect(r.args['fraction']).toBe('0.5'); }
  });
  it('rejects: bad JSON, unknown action, missing thesis, bad stopFrac, bad side', () => {
    expect(parseScoutDecision('not json').kind).toBe('error');
    expect(parseScoutDecision('{"action":"yolo"}').kind).toBe('error');
    expect(parseScoutDecision('{"action":"open","coin":"ETH","side":"buy","riskUsd":50,"stopFrac":0.03}').kind).toBe('error');
    expect(parseScoutDecision('{"action":"open","coin":"ETH","side":"buy","riskUsd":50,"stopFrac":1.5,"thesis":"t"}').kind).toBe('error');
    expect(parseScoutDecision('{"action":"open","coin":"ETH","side":"long","riskUsd":50,"stopFrac":0.03,"thesis":"t"}').kind).toBe('error');
    expect(parseScoutDecision('{"action":"close","coin":"ETH"}').kind).toBe('error');
  });
});
