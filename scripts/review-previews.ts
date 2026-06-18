/**
 * skill:review-previews entrypoint (thin I/O). ADVISORY skill.
 *
 * HARD PRINCIPLE: this NEVER executes a trade. The operator creates a proposed
 * OPEN position in the cockpit as a `preview` (status='preview', origin='operator').
 * This skill lets Claude (a) LIST the open previews and (b) write a `review`
 * annotation (endorse / caution / avoid + a note) onto one. Writing a review only
 * records Claude's read — the operator's UI Approve is the ONLY thing that fires
 * the trade. NO-AUTO-FIRE.
 *
 * Usage:
 *   # LIST every open preview (default):
 *   pnpm skill:review-previews
 *
 *   # REVIEW one preview:
 *   pnpm skill:review-previews --id <uuid> --verdict <endorse|caution|avoid> --note "<text>"
 */

import { parseArgs, requireString, header, line, run } from './_skill-runtime';
import { listOpenPreviews, attachPreviewReview } from '@/lib/cockpit/pending-actions-service';
import type { PendingActionReview } from '@/types/cockpit';

const VERDICTS = ['endorse', 'caution', 'avoid'] as const;
type Verdict = (typeof VERDICTS)[number];

/** Inline verdict guard — no business logic worth a separate module. */
function validateVerdict(raw: string): Verdict {
  const v = raw.trim().toLowerCase();
  if ((VERDICTS as readonly string[]).includes(v)) return v as Verdict;
  throw new Error(`--verdict must be one of ${VERDICTS.join(' | ')} (got "${raw}")`);
}

run(async () => {
  const args = parseArgs(process.argv.slice(2));

  // REVIEW mode: --id present ⇒ write a review onto that preview.
  if (typeof args['id'] === 'string') {
    const id = requireString(args, 'id');
    const verdict = validateVerdict(requireString(args, 'verdict'));
    const note = requireString(args, 'note');

    const review: PendingActionReview = {
      verdict,
      note: note.trim(),
      reviewedAt: Date.now(),
    };

    header(`review-previews — writing ${verdict.toUpperCase()} review`);
    line(`preview id: ${id}`);
    line(`note: ${review.note}`);
    line('ADVISORY ONLY — this records Claude\'s read; it does NOT execute the trade.');

    const ok = await attachPreviewReview(id, review);
    if (!ok) {
      header('Review NOT written');
      line(
        `No open operator preview with id ${id} (it may not exist, or it was already ` +
          `decided/executed). Run without --id to list the current open previews.`,
      );
      return;
    }

    header('Review attached');
    line('The operator will see this verdict in the cockpit. Only their Approve fires the trade.');
    return;
  }

  // LIST mode (default): print every open operator preview.
  const previews = await listOpenPreviews();

  header(`review-previews — ${previews.length} open preview${previews.length === 1 ? '' : 's'}`);
  if (previews.length === 0) {
    line('No open operator previews to review.');
    return;
  }
  line('ADVISORY ONLY — reviewing a preview NEVER executes it; only the operator\'s UI Approve does.');

  previews.forEach((p, i) => {
    const d = p.proposal.display;
    header(`[${i}] ${d.coin} ${d.side.toUpperCase()} ${d.sz}`);
    line(`id: ${p.id}`);
    line(`est entry: ${d.estPx != null ? `$${d.estPx}` : 'n/a'}  stop: ${d.stopPx != null ? `$${d.stopPx}` : 'n/a'}`);
    line(`leverage: ${d.leverage != null ? `${d.leverage}x` : 'n/a'}${d.coinMaxLeverage != null ? ` (max ${d.coinMaxLeverage}x)` : ''}`);
    if (d.leaderAddress) {
      line(
        `leader: ${d.leaderAddress}` +
          (d.leaderLeverage != null ? ` @ ${d.leaderLeverage}x` : ''),
      );
    }
    line(`rationale: ${d.rationale}`);
    if (p.review) {
      line(`already reviewed: ${p.review.verdict.toUpperCase()} — ${p.review.note}`);
    } else {
      line('not yet reviewed');
    }
  });

  header('To review one');
  line('pnpm skill:review-previews --id <uuid> --verdict <endorse|caution|avoid> --note "<text>"');
});
