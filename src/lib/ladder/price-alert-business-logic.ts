/**
 * Price alerts — PURE decision logic. One-shot operator pings ("tell me when
 * COIN crosses PX"), checked by the watch tick against live marks.
 * Informational only — nothing here (or downstream) can trade.
 */

export interface PriceAlert {
  id: string;
  coin: string;
  direction: 'above' | 'below';
  triggerPx: number;
  message: string;
}

/** True when the alert's condition is met at this mark. Bad inputs never fire. */
export function alertConditionMet(alert: PriceAlert, markPx: number | undefined): boolean {
  if (markPx === undefined || !Number.isFinite(markPx) || markPx <= 0) return false;
  if (!Number.isFinite(alert.triggerPx) || alert.triggerPx <= 0) return false;
  return alert.direction === 'above' ? markPx >= alert.triggerPx : markPx <= alert.triggerPx;
}

/** The Discord line for a fired alert. */
export function alertMessage(alert: PriceAlert, markPx: number): string {
  const arrow = alert.direction === 'above' ? '≥' : '≤';
  const base = `🔔 **PRICE ALERT** — ${alert.coin} ${markPx} ${arrow} ${alert.triggerPx}`;
  return alert.message ? `${base}\n${alert.message}` : base;
}
