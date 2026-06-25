/**
 * Favorites + follows write service (SERVICE ROLE, server-only).
 *
 * `favorited_traders` drives the favorites-gated watch set (the daemon reads it
 * each cycle); `followed_positions` tracks actively-followed (leader, coin)
 * positions for keep-matched alerts. The UI reads both via the anon client
 * (select-only RLS); ALL writes go through the admin-authed routes that call this.
 */

import 'server-only';
import { getServiceRoleClient } from './supabase-server';
import { normalizeLeaderAddress } from '@/lib/trader-watch/watch-set-business-logic';

function normCoin(coin: string): string {
  return coin.trim().toUpperCase();
}

export async function addFavorite(address: string, note?: string): Promise<void> {
  const leader_address = normalizeLeaderAddress(address);
  if (!leader_address) throw new Error('address required');
  const { error } = await getServiceRoleClient()
    .from('favorited_traders')
    .upsert({ leader_address, note: note ?? null }, { onConflict: 'leader_address' });
  if (error) throw new Error(`addFavorite failed: ${error.message}`);
}

export async function removeFavorite(address: string): Promise<void> {
  const leader_address = normalizeLeaderAddress(address);
  if (!leader_address) throw new Error('address required');
  const { error } = await getServiceRoleClient()
    .from('favorited_traders')
    .delete()
    .eq('leader_address', leader_address);
  if (error) throw new Error(`removeFavorite failed: ${error.message}`);
}

/** Start following a (leader, coin) position. Idempotent — a second follow of an
 *  already-active (leader, coin) is a no-op (the partial-unique index also guards). */
export async function addFollow(leaderAddress: string, coin: string, note?: string): Promise<void> {
  const leader_address = normalizeLeaderAddress(leaderAddress);
  const c = normCoin(coin);
  if (!leader_address || !c) throw new Error('leaderAddress + coin required');
  const client = getServiceRoleClient();
  const { data: existing, error: selErr } = await client
    .from('followed_positions')
    .select('id')
    .eq('leader_address', leader_address)
    .eq('coin', c)
    .eq('status', 'active')
    .limit(1);
  if (selErr) throw new Error(`addFollow check failed: ${selErr.message}`);
  if (existing && existing.length > 0) return; // already following
  const { error } = await client
    .from('followed_positions')
    .insert({ leader_address, coin: c, status: 'active', note: note ?? null });
  if (error) throw new Error(`addFollow failed: ${error.message}`);
}

/** Stop following: flip the active (leader, coin) follow to ended (keeps history). */
export async function endFollow(leaderAddress: string, coin: string): Promise<void> {
  const leader_address = normalizeLeaderAddress(leaderAddress);
  const c = normCoin(coin);
  if (!leader_address || !c) throw new Error('leaderAddress + coin required');
  const { error } = await getServiceRoleClient()
    .from('followed_positions')
    .update({ status: 'ended', ended_at: new Date().toISOString() })
    .eq('leader_address', leader_address)
    .eq('coin', c)
    .eq('status', 'active');
  if (error) throw new Error(`endFollow failed: ${error.message}`);
}
