import type { ReadinessCriteria } from '@/lib/services/canonical-readiness-service';
import type { OperationalPolicyProfile } from './types';
import type { ShadowMetricsQuery } from '@/lib/services/shadow-metrics-reader';
import { OBSERVATIONAL_POLICY_PROFILE } from './observational-policy-profile';

export interface ObservationConfig {
  criteria: ReadinessCriteria;
  profile: OperationalPolicyProfile;
  metricsQueryTemplate: Omit<ShadowMetricsQuery, 'companyId' | 'from' | 'to'>;
  windowDays: number;
}

export const APPLY_ALL_OBSERVATION_CONFIG: ObservationConfig = {
  criteria: {
    sample: {
      minimumEvaluatedTransactions: 100,
      minimumBatches: 3,
    },
    quality: {
      minimumAgreementRate: 0.95,
      maximumDivergenceRate: 0.05,
      maximumAmbiguityRate: 0.02,
    },
    integrity: {
      maximumErrorRate: 0.01,
      maximumInvalidRecordRate: 0.05,
    },
  },
  profile: OBSERVATIONAL_POLICY_PROFILE,
  metricsQueryTemplate: {
    source: 'APPLY_ALL',
    trustPolicy: 'INCLUDE_LEGACY_IMPORT',
  },
  windowDays: 90,
};
