/**
 * PURE Leader-vs-You alignment read (no React, no I/O — fixture-tested).
 *
 * When a session follows a leader AND holds a position on the same coin, the
 * operator's strongest exit cue is what the LEADER is doing now. This derives a
 * single alignment state from the two positions:
 *
 *   🟢 aligned          — same side, leader still in (trail them, hold).
 *   🟡 leader trimming   — same side, leader's size shrank materially (lighten up).
 *   🔴 leader covered/flipped — leader closed the coin OR flipped to the other
 *                          side (the trail-the-leader EXIT cue — strongest signal).
 *   ⚠️ leader adding into a loss — same side, leader added size while underwater
 *                          (martingale caution — do NOT blindly follow the add).
 *
 * The trimming threshold compares the leader's CURRENT size to a baseline (the
 * size first seen this session, supplied by the caller's short-poll state). With
 * no baseline we cannot detect a trim/add, so we fall back to aligned/covered.
 */

import type { HlPosition } from '@/lib/hyperliquid/hyperliquid-info-service';

export type AlignmentState = 'aligned' | 'leader-trimming' | 'leader-covered' | 'leader-adding-loss';

export interface AlignmentRead {
  state: AlignmentState;
  /** Emoji glyph for the dense readout. */
  glyph: string;
  /** Short label. */
  label: string;
  /** One-line operator cue. */
  cue: string;
}

/** Your side on the coin (from the folded position). */
export type UserSide = 'long' | 'short';

export interface AlignmentInput {
  coin: string;
  /** Your current side on the coin. */
  userSide: UserSide;
  /** The leader's current position on the SAME coin (null = leader flat/closed). */
  leaderPosition: HlPosition | null;
  /**
   * The leader's size on this coin when first observed this session (the
   * baseline for trim/add detection). Null/undefined ⇒ trim/add not assessable.
   */
  leaderBaselineSize?: number | null;
}

/** A material size change is >10% of the baseline (ignore dust/rounding). */
const TRIM_FRACTION = 0.1;

const READS: Record<AlignmentState, Omit<AlignmentRead, 'state'>> = {
  aligned: { glyph: '🟢', label: 'Aligned', cue: 'Leader still in — trail them.' },
  'leader-trimming': { glyph: '🟡', label: 'Leader trimming', cue: 'Leader cut size — consider lightening up.' },
  'leader-covered': { glyph: '🔴', label: 'Leader covered/flipped', cue: 'Leader left the coin — trail the exit.' },
  'leader-adding-loss': { glyph: '⚠️', label: 'Leader adding into a loss', cue: 'Leader is averaging down — do NOT blindly follow.' },
};

function read(state: AlignmentState): AlignmentRead {
  return { state, ...READS[state] };
}

/**
 * Derive the alignment state. PURE.
 *
 * Resolution order (strongest cue first):
 *  1. Leader flat / opposite side  → covered/flipped (🔴) — the exit cue.
 *  2. Same side, underwater, size grew vs baseline → adding-into-loss (⚠️).
 *  3. Same side, size shrank materially vs baseline → trimming (🟡).
 *  4. Otherwise (same side, holding/adding-in-profit) → aligned (🟢).
 */
export function deriveAlignment(input: AlignmentInput): AlignmentRead {
  const lp = input.leaderPosition;
  // 1. Leader is out of the coin, or on the OTHER side → covered/flipped.
  if (!lp || lp.size <= 0 || lp.side !== input.userSide) {
    return read('leader-covered');
  }

  const baseline = input.leaderBaselineSize;
  const haveBaseline = baseline != null && Number.isFinite(baseline) && baseline > 0;

  if (haveBaseline) {
    const delta = lp.size - (baseline as number);
    const grew = delta > (baseline as number) * TRIM_FRACTION;
    const shrank = -delta > (baseline as number) * TRIM_FRACTION;
    // 2. Adding into a loss (martingale caution) — size grew while underwater.
    if (grew && lp.unrealizedPnl < 0) return read('leader-adding-loss');
    // 3. Trimming — size shrank materially (de-risking, same direction).
    if (shrank) return read('leader-trimming');
  }

  // 4. Same side, holding (or adding in profit) → aligned.
  return read('aligned');
}

/** Find the leader's position on a coin (case-insensitive), or null. */
export function leaderPositionForCoin(
  positions: HlPosition[],
  coin: string,
): HlPosition | null {
  const norm = coin.trim().toUpperCase();
  return positions.find((p) => p.coin.toUpperCase() === norm) ?? null;
}
