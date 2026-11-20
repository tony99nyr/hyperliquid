/**
 * Scoped agent actions (ADR-0009): the kill switch and the token.
 */

import { validateEnv } from '@/lib/env/env';

/** A shorter token reads as "not configured", so a weak secret can never authenticate. */
export const MIN_AGENT_ACTION_TOKEN_LENGTH = 32;

/** Master kill switch. Off by default: the endpoint refuses every request. */
export function isAgentActionsEnabled(): boolean {
  return validateEnv().AGENT_ACTIONS_ENABLED;
}

/** The dedicated bearer token for /api/agent/action, or undefined when unset or too short. */
export function getAgentActionToken(): string | undefined {
  const token = validateEnv().AGENT_ACTION_TOKEN?.trim();
  return token && token.length >= MIN_AGENT_ACTION_TOKEN_LENGTH ? token : undefined;
}
