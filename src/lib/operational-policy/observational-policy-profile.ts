import type { OperationalPolicyProfile } from './types';

export const OBSERVATIONAL_POLICY_PROFILE: OperationalPolicyProfile = {
  id: 'observational-policy-v1',
  name: 'Observational Default Policy',
  version: '1.0.0',
  defaultAction: 'ALLOW',
  rules: [
    {
      id: 'apply-all-not-ready',
      context: 'APPLY_ALL',
      readinessStatus: 'NOT_READY',
      action: 'WARN',
      reasonCode: 'READINESS_NOT_MET',
      description: 'Canonical readiness criteria are not met. Review Apply All classifications carefully.'
    },
    {
      id: 'apply-all-insufficient',
      context: 'APPLY_ALL',
      readinessStatus: 'INSUFFICIENT_DATA',
      action: 'WARN',
      reasonCode: 'INSUFFICIENT_SAMPLE',
      description: 'Apply All runs with insufficient shadow history. Verify classifications manually.'
    },
    {
      id: 'import-not-ready',
      context: 'IMPORT',
      readinessStatus: 'NOT_READY',
      action: 'WARN',
      reasonCode: 'DIVERGENCE_HIGH',
      description: 'Divergence rate is high. V2 would differ on several imports.'
    },
    {
      id: 'import-insufficient',
      context: 'IMPORT',
      readinessStatus: 'INSUFFICIENT_DATA',
      action: 'ALLOW',
      reasonCode: 'INSUFFICIENT_SAMPLE',
      description: 'Insufficient sample data to assess import quality. Proceed normally.'
    },
    {
      id: 'reconciliation-not-ready',
      context: 'RECONCILIATION',
      readinessStatus: 'NOT_READY',
      action: 'WARN',
      reasonCode: 'DIVERGENCE_HIGH',
      description: 'Divergence is high. Verify reconciliation suggestions carefully.'
    },
    {
      id: 'reconciliation-insufficient',
      context: 'RECONCILIATION',
      readinessStatus: 'INSUFFICIENT_DATA',
      action: 'ALLOW',
      reasonCode: 'INSUFFICIENT_SAMPLE',
      description: 'Insufficient sample data to assess reconciliation suggestions.'
    }
  ]
};
