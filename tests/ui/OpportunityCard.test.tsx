import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import OpportunityCard from '@/app/cockpit/components/opportunity/OpportunityCard';
import OpportunityBoard from '@/app/cockpit/components/opportunity/OpportunityBoard';
import type { OpportunityCardModel } from '@/app/cockpit/components/opportunity/opportunity-helpers';
import type { RubricScoreUiRow } from '@/hooks/realtime-row-mappers';

function uiRow(coin: string, side: 'long' | 'short', over: Partial<RubricScoreUiRow> = {}): RubricScoreUiRow {
  return {
    id: `${coin}:${side}`, coin, side, opportunity: 74, pillarRegime: 80, pillarLeaders: 70, pillarCarry: 40,
    pillarMicro: 64, regimeMultiplier: 0.9, badge: 'GO', chosenSide: side, noTradeReason: null,
    entryLow: 1690, entryHigh: 1710, invalidation: 1740, target: 1640, triggerPx: 1700, roomToTarget: 2,
    confidence: 0.8, scoreBandLow: 68, scoreBandHigh: 80, killedBy: null, computedAt: 1_000_000, ...over,
  };
}
function model(over: Partial<OpportunityCardModel> = {}): OpportunityCardModel {
  const display = uiRow('ETH', 'short');
  return { coin: 'ETH', badge: 'GO', chosenSide: 'short', noTradeReason: null, confidence: 0.8, computedAt: 1_000_000, display, long: uiRow('ETH', 'long', { opportunity: 20 }), short: display, ...over };
}

describe('OpportunityCard', () => {
  it('renders integer score + band + 4 pillars + direction', () => {
    render(<OpportunityCard model={model()} now={1_000_000} />);
    expect(screen.getByText('74')).toBeTruthy();
    expect(screen.getByText('±6')).toBeTruthy(); // (80-68)/2
    expect(screen.getByTestId('pillar-bar').querySelectorAll('[data-pillar]')).toHaveLength(4);
    expect(screen.getByText('SHORT')).toBeTruthy();
    expect(screen.getByTestId('opportunity-badge').textContent).toBe('GO');
  });

  it('NO-EDGE badge renders calm (muted), not GO', () => {
    const m = model({ badge: 'NO-EDGE', chosenSide: 'none', noTradeReason: 'vol-contraction' });
    render(<OpportunityCard model={m} now={1_000_000} />);
    expect(screen.getByTestId('opportunity-badge').textContent).toBe('NO EDGE');
    expect(screen.getByText('vol contraction')).toBeTruthy();
  });

  it('flags stale data (older than the ttl)', () => {
    render(<OpportunityCard model={model({ computedAt: 0 })} now={60 * 60 * 1000} />);
    expect(screen.getByTestId('opportunity-card').getAttribute('data-stale')).toBe('true');
  });

  it('calls onSelect when clicked, onAskClaude (stopping propagation) on the chip', () => {
    const onSelect = vi.fn();
    const onAskClaude = vi.fn();
    render(<OpportunityCard model={model()} now={1_000_000} onSelect={onSelect} onAskClaude={onAskClaude} />);
    fireEvent.click(screen.getByTestId('ask-claude'));
    expect(onAskClaude).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled(); // chip stops propagation
    fireEvent.click(screen.getByTestId('opportunity-card'));
    expect(onSelect).toHaveBeenCalledWith('ETH');
  });
});

describe('OpportunityBoard', () => {
  it('renders one card per coin from rowsOverride in universe order', () => {
    const rows = [uiRow('SOL', 'long'), uiRow('ETH', 'short'), uiRow('BTC', 'long')];
    render(<OpportunityBoard order={['ETH', 'BTC', 'SOL']} rowsOverride={rows} now={1_000_000} />);
    const cards = screen.getAllByTestId('opportunity-card');
    expect(cards).toHaveLength(3);
    expect(cards.map((c) => c.getAttribute('data-coin'))).toEqual(['ETH', 'BTC', 'SOL']);
  });
  it('shows a calm empty state with no rows', () => {
    render(<OpportunityBoard rowsOverride={[]} now={1_000_000} />);
    expect(screen.getByTestId('opportunity-empty')).toBeTruthy();
  });
  it('selecting a card calls onSelectCoin', () => {
    const onSelectCoin = vi.fn();
    render(<OpportunityBoard order={['ETH']} rowsOverride={[uiRow('ETH', 'short')]} onSelectCoin={onSelectCoin} now={1_000_000} />);
    fireEvent.click(screen.getByTestId('opportunity-card'));
    expect(onSelectCoin).toHaveBeenCalledWith('ETH');
  });
});
