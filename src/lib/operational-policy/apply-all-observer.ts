import type { ShadowMetricsProvider } from '@/lib/services/canonical-readiness-service';
import type { ShadowMetricsQuery } from '@/lib/services/shadow-metrics-reader';
import { evaluateOperationalPolicy } from '@/lib/operational-policy/policy-service';
import { APPLY_ALL_OBSERVATION_CONFIG } from '@/lib/operational-policy/apply-all-observation-config';
import type { OperationalContext, OperationalPolicyDecision } from './types';

// ─── Types ──────────────────────────────────────────────────

export type PolicyObservationStatus = 'AVAILABLE' | 'UNAVAILABLE';

export interface PolicyObservationAvailable {
  status: 'AVAILABLE';
  decision: OperationalPolicyDecision;
}

export interface PolicyObservationUnavailable {
  status: 'UNAVAILABLE';
  errorCode: string;
}

export type PolicyObservationResponse =
  | PolicyObservationAvailable
  | PolicyObservationUnavailable;

export interface ObservePolicyParams {
  companyId: string;
  context: OperationalContext;
  provider: ShadowMetricsProvider;
  metricsWindow: { from: Date; to: Date };
}

// ─── Observer ───────────────────────────────────────────────

export async function observePolicy(
  params: ObservePolicyParams,
): Promise<PolicyObservationResponse> {
  const { companyId, context, provider, metricsWindow } = params;
  const config = APPLY_ALL_OBSERVATION_CONFIG;

  const metricsQuery: ShadowMetricsQuery = {
    ...config.metricsQueryTemplate,
    companyId,
    from: metricsWindow.from,
    to: metricsWindow.to,
  };

  const decision = await evaluateOperationalPolicy(
    { context, metricsQuery },
    config.criteria,
    provider,
    config.profile,
  );

  return { status: 'AVAILABLE', decision };
}
