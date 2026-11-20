import { describe, it, expect, vi, beforeEach } from 'vitest';

const validateEnv = vi.fn();
vi.mock('@/lib/env/env', () => ({ validateEnv: () => validateEnv() }));

import { getAgentActionToken, isAgentActionsEnabled } from '@/lib/agent-actions/agent-action-config';

beforeEach(() => vi.clearAllMocks());

describe('agent-action config', () => {
  it('reads the kill switch', () => {
    validateEnv.mockReturnValue({ AGENT_ACTIONS_ENABLED: false });
    expect(isAgentActionsEnabled()).toBe(false);
    validateEnv.mockReturnValue({ AGENT_ACTIONS_ENABLED: true });
    expect(isAgentActionsEnabled()).toBe(true);
  });

  it('returns a token of 32 characters or more, trimmed', () => {
    validateEnv.mockReturnValue({ AGENT_ACTION_TOKEN: ` ${'k'.repeat(32)} ` });
    expect(getAgentActionToken()).toBe('k'.repeat(32));
  });

  it('treats a missing, empty or short token as not configured', () => {
    for (const AGENT_ACTION_TOKEN of [undefined, '', '   ', 'k'.repeat(31)]) {
      validateEnv.mockReturnValue({ AGENT_ACTION_TOKEN });
      expect(getAgentActionToken()).toBeUndefined();
    }
  });
});
