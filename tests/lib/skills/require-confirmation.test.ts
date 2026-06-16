/**
 * Locks the NO-AUTO-FIRE gate (the human-in-the-loop safety rail). The action
 * skills NEVER auto-fire: confirmation defaults to NO, garbage/boolean --confirm
 * cannot bypass, and in LIVE mode the --confirm argv bypass is REFUSED entirely
 * (a real order always requires the interactive typed phrase).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the interactive prompt so we can drive the "typed answer" deterministically
// without a TTY. `answer` is what the user "types".
let answer = '';
const questionMock = vi.fn(async () => answer);
const closeMock = vi.fn();
vi.mock('node:readline/promises', () => ({
  createInterface: () => ({ question: questionMock, close: closeMock }),
}));

import { requireConfirmation } from '../../../scripts/_skill-runtime';

beforeEach(() => {
  answer = '';
  questionMock.mockClear();
  closeMock.mockClear();
});

describe('requireConfirmation — PAPER mode argv path', () => {
  it('--confirm yes confirms (no prompt)', async () => {
    const ok = await requireConfirmation({ confirm: 'yes' }, 'do it', { mode: 'paper' });
    expect(ok).toBe(true);
    expect(questionMock).not.toHaveBeenCalled();
  });

  it('--confirm no does NOT confirm', async () => {
    expect(await requireConfirmation({ confirm: 'no' }, 'x', { mode: 'paper' })).toBe(false);
  });

  it('--confirm garbage does NOT confirm', async () => {
    expect(await requireConfirmation({ confirm: 'YESPLEASE' }, 'x', { mode: 'paper' })).toBe(false);
  });

  it('boolean --confirm (no value) falls through to the prompt, default NO', async () => {
    answer = 'no';
    const ok = await requireConfirmation({ confirm: true }, 'x', { mode: 'paper' });
    expect(ok).toBe(false);
    expect(questionMock).toHaveBeenCalledTimes(1); // could NOT bypass via boolean
  });
});

describe('requireConfirmation — interactive default-NO', () => {
  it('empty answer aborts', async () => {
    answer = '';
    expect(await requireConfirmation({}, 'x', { mode: 'paper' })).toBe(false);
  });
  it('exactly "yes" confirms', async () => {
    answer = 'yes';
    expect(await requireConfirmation({}, 'x', { mode: 'paper' })).toBe(true);
  });
});

describe('requireConfirmation — LIVE mode refuses the argv bypass', () => {
  it('--confirm yes is IGNORED in live mode (must type the live phrase)', async () => {
    answer = ''; // user types nothing at the forced prompt
    const ok = await requireConfirmation({ confirm: 'yes' }, 'REAL ORDER', {
      mode: 'live',
      liveConfirmPhrase: 'sell 1.5 eth',
    });
    expect(ok).toBe(false); // the argv bypass did NOT fire the order
    expect(questionMock).toHaveBeenCalledTimes(1); // it fell through to the prompt
  });

  it('live order fires ONLY when the exact phrase is typed', async () => {
    answer = 'sell 1.5 eth';
    const ok = await requireConfirmation({ confirm: 'yes' }, 'REAL ORDER', {
      mode: 'live',
      liveConfirmPhrase: 'SELL 1.5 ETH',
    });
    expect(ok).toBe(true); // case-insensitive match of the full phrase
  });

  it('a mere "yes" typed in live mode does NOT fire when a phrase is required', async () => {
    answer = 'yes';
    const ok = await requireConfirmation({}, 'REAL ORDER', {
      mode: 'live',
      liveConfirmPhrase: 'sell 1.5 eth',
    });
    expect(ok).toBe(false);
  });
});
