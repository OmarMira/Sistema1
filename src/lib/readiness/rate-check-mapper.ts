import type { ReadinessCheckResult, ReadinessCheckCode }
  from '@/lib/services/canonical-readiness-service';

export type RateKey = 'agreementRate' | 'divergenceRate' | 'ambiguityRate' | 'errorRate';

export const RATE_TO_CHECK_CODE: Record<RateKey, ReadinessCheckCode> = {
  agreementRate: 'MINIMUM_AGREEMENT_RATE',
  divergenceRate: 'MAXIMUM_DIVERGENCE_RATE',
  ambiguityRate: 'MAXIMUM_AMBIGUITY_RATE',
  errorRate: 'MAXIMUM_ERROR_RATE',
};

export function getCheckForRate(
  checks: ReadinessCheckResult[],
  rateKey: RateKey,
): ReadinessCheckResult | undefined {
  const code = RATE_TO_CHECK_CODE[rateKey];
  return checks.find(c => c.code === code);
}

export function getRatePassed(
  checks: ReadinessCheckResult[],
  rateKey: RateKey,
): boolean | undefined {
  return getCheckForRate(checks, rateKey)?.passed;
}
