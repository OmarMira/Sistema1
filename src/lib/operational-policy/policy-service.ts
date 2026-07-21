import type { ShadowMetricsProvider, ReadinessCriteria } from '@/lib/services/canonical-readiness-service';
import { evaluateCanonicalReadiness } from '@/lib/services/canonical-readiness-service';
import { AppError } from '@/lib/api-error';
import type {
  OperationalPolicyInput,
  OperationalPolicyProfile,
  OperationalPolicyDecision,
  OperationalPolicyRuleResult,
  OperationalPolicyAction,
  OperationalContext,
  OperationalPolicyRule,
} from './types';

const VALID_ACTIONS: OperationalPolicyAction[] = ['ALLOW', 'WARN', 'CONFIRM', 'BLOCK'];
const VALID_CONTEXTS: OperationalContext[] = ['APPLY_ALL', 'IMPORT', 'RECONCILIATION'];
const VALID_READINESS_STATUSES = ['READY', 'NOT_READY', 'INSUFFICIENT_DATA'] as const;

const ACTION_SEVERITY: Record<OperationalPolicyAction, number> = {
  ALLOW: 1,
  WARN: 2,
  CONFIRM: 3,
  BLOCK: 4,
};

function assertInput(input: OperationalPolicyInput): void {
  if (!input) {
    throw new AppError(400, 'input is required', 'POLICY_INPUT_REQUIRED');
  }
  if (!VALID_CONTEXTS.includes(input.context)) {
    throw new AppError(400, 'Unknown context', 'POLICY_UNKNOWN_CONTEXT');
  }
}

function assertCriteria(criteria: ReadinessCriteria): void {
  if (!criteria) {
    throw new AppError(400, 'criteria is required', 'POLICY_CRITERIA_REQUIRED');
  }
}

function assertProfile(profile: OperationalPolicyProfile): void {
  if (!profile) {
    throw new AppError(400, 'profile is required', 'POLICY_PROFILE_REQUIRED');
  }
  if (!profile.id || profile.id.trim() === '') {
    throw new AppError(400, 'profile id is required', 'POLICY_PROFILE_ID_REQUIRED');
  }
  if (!profile.version || profile.version.trim() === '') {
    throw new AppError(400, 'profile version is required', 'POLICY_VERSION_REQUIRED');
  }
  if (!VALID_ACTIONS.includes(profile.defaultAction)) {
    throw new AppError(400, 'Unknown default action', 'POLICY_UNKNOWN_DEFAULT_ACTION');
  }
  if (!Array.isArray(profile.rules)) {
    throw new AppError(400, 'profile rules must be an array', 'POLICY_RULES_NOT_ARRAY');
  }

  const seenIds = new Set<string>();
  const seenSemantics = new Set<string>();

  for (const rule of profile.rules) {
    if (!VALID_CONTEXTS.includes(rule.context)) {
      throw new AppError(400, 'Rule has unknown context', 'POLICY_RULE_INVALID_FIELD');
    }
    if (!VALID_READINESS_STATUSES.includes(rule.readinessStatus)) {
      throw new AppError(400, 'Rule has unknown readinessStatus', 'POLICY_RULE_INVALID_FIELD');
    }
    if (!VALID_ACTIONS.includes(rule.action)) {
      throw new AppError(400, 'Rule has unknown action', 'POLICY_RULE_INVALID_FIELD');
    }
    if (!rule.reasonCode || rule.reasonCode.trim() === '') {
      throw new AppError(400, 'Rule reasonCode is required', 'POLICY_RULE_INVALID_FIELD');
    }

    if (seenIds.has(rule.id)) {
      throw new AppError(400, `Duplicate rule id: ${rule.id}`, 'DUPLICATE_RULE_ID');
    }
    seenIds.add(rule.id);

    const semKey = `${rule.context}|${rule.readinessStatus}|${rule.action}|${rule.reasonCode}`;
    if (seenSemantics.has(semKey)) {
      throw new AppError(400, 'Duplicate rule content', 'DUPLICATE_RULE_CONTENT');
    }
    seenSemantics.add(semKey);
  }
}

function filterContextRules(
  profile: OperationalPolicyProfile,
  context: OperationalContext,
): OperationalPolicyRule[] {
  const contextRules = profile.rules.filter(r => r.context === context);
  if (contextRules.length === 0) {
    throw new AppError(400, 'No rules defined for context', 'POLICY_CONTEXT_RULES_REQUIRED');
  }
  return contextRules;
}

function buildRuleResults(
  contextRules: OperationalPolicyRule[],
  readinessStatus: 'READY' | 'NOT_READY' | 'INSUFFICIENT_DATA',
): OperationalPolicyRuleResult[] {
  return contextRules.map(rule => ({
    ruleId: rule.id,
    matched: rule.readinessStatus === readinessStatus,
    action: rule.action,
    reasonCode: rule.reasonCode,
    context: rule.context,
    readinessStatus: rule.readinessStatus,
  }));
}

function resolveFinalAction(
  ruleResults: OperationalPolicyRuleResult[],
  defaultAction: OperationalPolicyAction,
): { action: OperationalPolicyAction; reasonCode: string } {
  const matchedRules = ruleResults.filter(r => r.matched);

  if (matchedRules.length === 0) {
    return { action: defaultAction, reasonCode: 'DEFAULT_ACTION' };
  }

  const winner = matchedRules.reduce((best, current) => {
    return ACTION_SEVERITY[current.action] > ACTION_SEVERITY[best.action] ? current : best;
  });
  // If multiple rules produce the same severity, `reduce` keeps the first (declarative profile order).
  // This is intentional — the profile author controls which reasonCode wins by ordering rules.

  return { action: winner.action, reasonCode: winner.reasonCode };
}

function buildSummary(
  action: OperationalPolicyAction,
  ruleResults: OperationalPolicyRuleResult[],
): string {
  const matchedRules = ruleResults.filter(r => r.matched);
  if (matchedRules.length === 0) {
    return `No rules matched the current readiness status. Default action "${action}" applied.`;
  }
  const winner = matchedRules.reduce((best, current) => {
    return ACTION_SEVERITY[current.action] > ACTION_SEVERITY[best.action] ? current : best;
  });
  return `Rule "${winner.ruleId}" matched — ${winner.reasonCode}. Action: ${action}.`;
}

export async function evaluateOperationalPolicy(
  input: OperationalPolicyInput,
  criteria: ReadinessCriteria,
  provider: ShadowMetricsProvider,
  profile: OperationalPolicyProfile,
): Promise<OperationalPolicyDecision> {
  assertInput(input);
  assertCriteria(criteria);
  assertProfile(profile);

  const contextRules = filterContextRules(profile, input.context);

  const readiness = await evaluateCanonicalReadiness(input.metricsQuery, criteria, provider);

  const ruleResults = buildRuleResults(contextRules, readiness.status);

  const { action, reasonCode } = resolveFinalAction(ruleResults, profile.defaultAction);

  const summary = buildSummary(action, ruleResults);

  return {
    action,
    context: input.context,
    profileId: profile.id,
    profileVersion: profile.version,
    readiness,
    rules: ruleResults,
    reasons: { reasonCode, summary },
  };
}
