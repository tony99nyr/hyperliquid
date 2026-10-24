import { describe, expect, it } from 'vitest';
import { mergeMigrationInventories, parseMigrationSql } from '../../../scripts/_migration-parser';

describe('migration SQL inventory parser', () => {
  it('finds created tables, added columns, and functions', () => {
    const inventory = parseMigrationSql(`
      create table if not exists public.positions (
        id uuid primary key,
        coin text not null,
        constraint positions_coin_key unique (coin)
      );
      alter table public.positions add column if not exists stop_px numeric;
      create or replace function public.reanchor_draft_ladder(p_id uuid)
      returns void language sql as $$ select 1; $$;
    `);
    expect([...inventory.tables.get('positions') ?? []].sort()).toEqual(['coin', 'id', 'stop_px']);
    expect([...inventory.functions]).toEqual(['reanchor_draft_ladder']);
  });

  it('ignores comments and follows dropped and renamed columns', () => {
    const inventory = parseMigrationSql(`
      create table public.leaders (
        -- denormalized copy of the wallet, refreshed or rebuilt nightly
        id uuid primary key,
        /* block comment: or */ wallet text not null,
        stale text
      );
      alter table public.leaders drop column if exists stale;
      alter table public.leaders rename column wallet to address;
    `);
    expect([...inventory.tables.get('leaders') ?? []].sort()).toEqual(['address', 'id']);
  });

  it('merges objects across migrations', () => {
    const merged = mergeMigrationInventories([
      parseMigrationSql('create table public.items (id uuid);'),
      parseMigrationSql('alter table public.items add column name text;'),
    ]);
    expect([...merged.tables.get('items') ?? []].sort()).toEqual(['id', 'name']);
  });
});
