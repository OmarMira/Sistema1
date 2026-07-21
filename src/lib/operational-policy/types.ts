import type { CanonicalReadiness, ReadinessCriteria } from '@/lib/services/canonical-readiness-service';
import type { ShadowMetricsQuery } from '@/lib/services/shadow-metrics-reader';

export type OperationalContext = 'APPLY_ALL' | 'IMPORT' | 'RECONCILIATION';

export type OperationalPolicyAction = 'ALLOW' | 'WARN' | 'CONFIRM' | 'BLOCK';

export interface OperationalPolicyProfile {
  id: string;
  name: string;
  version: string;
  defaultAction: OperationalPolicyAction;
  rules: OperationalPolicyRule[];
}

export interface OperationalPolicyRule {
  id: string;
  context: OperationalContext;
  readinessStatus: 'READY' | 'NOT_READY' | 'INSUFFICIENT_DATA';
  action: OperationalPolicyAction;
  reasonCode: string;
  description: string;
}

export interface OperationalPolicyRuleResult {
  ruleId: string;
  matched: boolean;
  action: OperationalPolicyAction;
  reasonCode: string;
  context: OperationalContext;
  readinessStatus: 'READY' | 'NOT_READY' | 'INSUFFICIENT_DATA';
}

export interface OperationalPolicyReason {
  reasonCode: string;
  summary: string;
}

export interface OperationalPolicyDecision {
  action: OperationalPolicyAction;
  context: OperationalContext;
  profileId: string;
  profileVersion: string;
  readiness: CanonicalReadiness;
  rules: OperationalPolicyRuleResult[];
  reasons: OperationalPolicyReason;
}

export interface OperationalPolicyInput {
  context: OperationalContext;
  metricsQuery: ShadowMetricsQuery;
}

export type { ShadowMetricsQuery, ReadinessCriteria, CanonicalReadiness };
