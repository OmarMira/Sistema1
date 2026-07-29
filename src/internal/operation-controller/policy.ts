import type { Intent, Capability, PolicyDecision } from './types';

export function evaluatePolicy(
  intent: Intent,
  capabilities: Capability[],
): PolicyDecision {
  const matches = capabilities.filter(
    (c) =>
      c.requester === intent.requester &&
      c.resourceType === intent.resourceType &&
      c.operation === intent.operation,
  );

  if (matches.length === 0) {
    return { mode: 'denied', reason: `No capability found for ${intent.requester} on ${intent.resourceType}.${intent.operation}` };
  }

  if (matches.length === 1) {
    return { mode: matches[0].mode };
  }

  const modes = new Set(matches.map((m) => m.mode));
  if (modes.size === 1) {
    return { mode: matches[0].mode };
  }

  return {
    mode: 'denied',
    reason: `Ambiguous capabilities: ${matches.length} matches with conflicting modes`,
  };
}