/**
 * Price alerts (I/O) — load armed alerts, compare against live mids, page
 * Discord, mark fired. Runs from the ladder-watch cron route each tick,
 * INDEPENDENT of armed ladders (the tick early-returns with none; alerts must
 * not). Fail-soft everywhere: an alert outage can never affect the money path,
 * and nothing here can trade — see price-alert-business-logic.
 */

import 'server-only';
import { getServiceRoleClient } from '@/lib/cockpit/supabase-server';
import { fetchAllMids } from '@/lib/hyperliquid/hyperliquid-info-service';
import { sendDiscord } from '@/lib/infrastructure/notify/discord-notify';
import { alertConditionMet, alertMessage, type PriceAlert } from './price-alert-business-logic';

export interface PriceAlertSummary {
  checked: number;
  fired: number;
}

export async function checkPriceAlerts(): Promise<PriceAlertSummary> {
  try {
    const client = getServiceRoleClient();
    const { data, error } = await client
      .from('price_alerts')
      .select('id, coin, direction, trigger_px, message')
      .eq('status', 'armed')
      .limit(50);
    if (error || !data || data.length === 0) return { checked: 0, fired: 0 };

    const mids = await fetchAllMids();
    let fired = 0;
    for (const row of data) {
      const alert: PriceAlert = {
        id: String((row as { id: string }).id),
        coin: String((row as { coin: string }).coin).trim().toUpperCase(),
        direction: (row as { direction: 'above' | 'below' }).direction,
        triggerPx: Number((row as { trigger_px: number }).trigger_px),
        message: String((row as { message: string }).message ?? ''),
      };
      const mark = mids[alert.coin];
      if (!alertConditionMet(alert, mark)) continue;
      // Claim BEFORE paging (status guard makes the claim atomic) so two
      // concurrent ticks can't double-page; a crash after the claim loses one
      // ping, which is the acceptable side of that trade-off.
      const { data: claimed } = await client
        .from('price_alerts')
        .update({ status: 'fired', fired_at: new Date().toISOString() })
        .eq('id', alert.id)
        .eq('status', 'armed')
        .select('id');
      if (!claimed || claimed.length === 0) continue;
      await sendDiscord(alertMessage(alert, mark as number), 'HL Price Alert').catch(() => {});
      fired++;
    }
    return { checked: data.length, fired };
  } catch {
    return { checked: 0, fired: 0 };
  }
}
