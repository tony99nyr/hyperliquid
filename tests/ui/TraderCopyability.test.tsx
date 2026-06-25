/**
 * TraderCopyability render tests — verdict + why + chips + vet button. The hook is
 * mocked (controlled evaluation state).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import TraderCopyability from '@/app/cockpit/components/left-rail/TraderCopyability';
import type { UseTraderEvaluationState } from '@/hooks/useTraderEvaluation';

let state: UseTraderEvaluationState;
const vetSpy = vi.fn(async () => {});
vi.mock('@/hooks/useTraderEvaluation', () => ({ useTraderEvaluation: () => state }));

beforeEach(() => {
  vetSpy.mockClear();
  state = { evaluation: null, loading: false, vetting: false, error: null, vet: vetSpy };
});

describe('TraderCopyability', () => {
  it('unvetted → prompts to vet; clicking vet calls the hook', () => {
    render(<TraderCopyability address="0xabc" />);
    expect(screen.getByText(/not yet vetted/i)).toBeTruthy();
    fireEvent.click(screen.getByTestId('copyability-vet'));
    expect(vetSpy).toHaveBeenCalled();
  });

  it('renders the verdict + why + chips when evaluated', () => {
    state.evaluation = {
      verdict: 'avoid',
      persistenceConfidence: 'single-window',
      metrics: { winRate: 0.68, medianHoldHours: 0.1, roundTrips: 35, addsPerTrip: 169, worstLossVsMedianWin: 424, liquidations: 0, why: 'Uncopyable with a stop: averages down hard.' },
      windowLabel: 'last 30d',
      fillsSeen: 12000,
      generatedAt: '2026-06-25T00:00:00Z',
    };
    render(<TraderCopyability address="0xabc" />);
    const v = screen.getByTestId('copyability-verdict');
    expect(v.getAttribute('data-verdict')).toBe('avoid');
    expect(screen.getByText(/averages down hard/i)).toBeTruthy();
    expect(screen.getByText('12,000 fills sampled.', { exact: false })).toBeTruthy();
  });

  it('vetting state disables the button', () => {
    state.vetting = true;
    render(<TraderCopyability address="0xabc" />);
    const btn = screen.getByTestId('copyability-vet') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toMatch(/vetting/i);
  });
});
