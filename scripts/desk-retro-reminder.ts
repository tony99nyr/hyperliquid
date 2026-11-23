/**
 * desk-retro reminder: one Discord ping that the weekly Monday retro is due.
 *
 * Session reminders (CronCreate) live only in a Claude session and are lost when the
 * session or the machine restarts. This script runs from a systemd user timer
 * (ops/systemd/desk-retro-reminder.timer), so the reminder survives a restart.
 * Advisory only: it sends a message and does nothing else.
 *
 * `--test` sends a one-line test ping instead, so an install on a new box (the NAS,
 * ops/nas/install.sh) can prove the webhook works without a false "retro is due".
 */
import { hostname } from 'node:os';
import { loadEnvLocal } from './_skill-runtime';
import { sendDiscord, isDiscordConfigured } from '@/lib/infrastructure/notify/discord-notify';

async function main(): Promise<void> {
  loadEnvLocal();
  if (!isDiscordConfigured()) {
    console.error('desk-retro-reminder: DISCORD_WEBHOOK_URL is not set; no ping sent');
    process.exit(1);
  }
  if (process.argv.includes('--test')) {
    const ok = await sendDiscord(`Test ping from ${hostname()}: the desk-retro reminder can reach Discord.`, 'Desk Retro');
    console.log(ok ? 'desk-retro-reminder: test ping sent' : 'desk-retro-reminder: test ping failed');
    process.exit(ok ? 0 : 1);
  }
  const first = new Date().getUTCDate() <= 7;
  const msg = [
    '🗓️ Weekly desk retro is due. Run `/desk-retro` in the Ladder Expert session.',
    first ? 'First retro of the month: freeze the forecast, score last month, update the capital-rule count.' : '',
  ].filter(Boolean).join('\n');
  const ok = await sendDiscord(msg, 'Desk Retro');
  console.log(ok ? 'desk-retro-reminder: pinged' : 'desk-retro-reminder: ping failed');
  process.exit(ok ? 0 : 1);
}

void main();
