import type { ReadinessForm } from './default-readiness-profile';
import { toStartOfDay, toEndOfDay } from './default-readiness-profile';

export function buildReadinessQueryParams(
  form: ReadinessForm,
  companyId: string,
): URLSearchParams {
  const params = new URLSearchParams();
  params.set('companyId', companyId);
  params.set('source', form.source);
  params.set('from', toStartOfDay(form.from!));
  params.set('to', toEndOfDay(form.to!));
  params.set('trustPolicy', form.trustPolicy);
  params.set('minimumEvaluatedTransactions', String(form.minimumEvaluatedTransactions));
  params.set('minimumBatches', String(form.minimumBatches));
  params.set('minimumAgreementRate', String(form.minimumAgreementRate));
  params.set('maximumDivergenceRate', String(form.maximumDivergenceRate));
  params.set('maximumAmbiguityRate', String(form.maximumAmbiguityRate));
  params.set('maximumErrorRate', String(form.maximumErrorRate));
  params.set('maximumInvalidRecordRate', String(form.maximumInvalidRecordRate));
  return params;
}
