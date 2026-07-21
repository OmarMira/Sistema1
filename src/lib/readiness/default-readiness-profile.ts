export type SourceOption = 'ALL' | 'IMPORT' | 'APPLY_ALL';
export type TrustPolicyOption = 'TRUSTED_ONLY' | 'INCLUDE_LEGACY_IMPORT' | 'INCLUDE_UNTRUSTED_HISTORY';

export interface ReadinessForm {
  source: SourceOption;
  trustPolicy: TrustPolicyOption;
  from: string | null;
  to: string | null;
  minimumEvaluatedTransactions: number;
  minimumBatches: number;
  minimumAgreementRate: number;
  maximumDivergenceRate: number;
  maximumAmbiguityRate: number;
  maximumErrorRate: number;
  maximumInvalidRecordRate: number;
}

export const INITIAL_READINESS_PROFILE: Omit<ReadinessForm, 'from' | 'to'> = {
  source: 'ALL',
  trustPolicy: 'INCLUDE_LEGACY_IMPORT',
  minimumEvaluatedTransactions: 100,
  minimumBatches: 3,
  minimumAgreementRate: 0.95,
  maximumDivergenceRate: 0.05,
  maximumAmbiguityRate: 0.02,
  maximumErrorRate: 0.01,
  maximumInvalidRecordRate: 0.05,
};

export function createInitialReadinessForm(from?: string, to?: string): ReadinessForm {
  return {
    ...INITIAL_READINESS_PROFILE,
    from: from ?? computeDefaultFrom(),
    to: to ?? computeDefaultTo(),
  };
}

export function toStartOfDay(isoDate: string): string {
  return `${isoDate}T00:00:00.000Z`;
}

export function toEndOfDay(isoDate: string): string {
  return `${isoDate}T23:59:59.999Z`;
}

export function computeDefaultFrom(): string {
  const d = new Date();
  d.setDate(d.getDate() - 90);
  return d.toISOString().slice(0, 10);
}

export function computeDefaultTo(): string {
  return new Date().toISOString().slice(0, 10);
}
