/**
 * Minimal Discord webhook notifier — the cockpit's only outbound push sink.
 *
 * The cockpit was built without notification sinks (the logger note); this adds a
 * single, fail-soft Discord poster for operator pages (e.g. a position nearing
 * liquidation). SERVER-ONLY (the webhook URL is a secret in env, never the client
 * bundle). NEVER throws into the caller — a notification is best-effort and must not
 * mask or break the work that triggered it. No-op (returns false) when unconfigured.
 */

import 'server-only';

/** Discord caps message content at 2000 chars; stay well under. */
const MAX_CONTENT = 1800;

function webhookUrl(): string | null {
  const u = process.env.DISCORD_WEBHOOK_URL;
  return typeof u === 'string' && /^https:\/\/discord(app)?\.com\/api\/webhooks\//.test(u) ? u : null;
}

/** True when a Discord webhook is configured (so callers can branch/log). */
export function isDiscordConfigured(): boolean {
  return webhookUrl() !== null;
}

/**
 * Post `content` to the configured Discord webhook. Returns true on a 2xx, false
 * on no-config / any error (logged, never thrown). `username` overrides the
 * webhook's default name in the channel.
 */
export async function sendDiscord(content: string, username = 'HL Cockpit'): Promise<boolean> {
  const url = webhookUrl();
  if (!url) return false;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // allowed_mentions.parse: [] — model-authored content (steward proposals) must
      // never be able to ping @everyone/@here/roles; templated callers lose nothing.
      body: JSON.stringify({ content: content.slice(0, MAX_CONTENT), username, allowed_mentions: { parse: [] } }),
      // Discord webhooks are fast; bound it so a hung POST can't stall a cron tick.
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      console.error(`[discord] webhook ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[discord] webhook error:', err instanceof Error ? err.message : String(err));
    return false;
  }
}
