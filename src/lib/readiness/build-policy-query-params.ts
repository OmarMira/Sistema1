import { buildReadinessQueryParams } from '@/lib/readiness/build-readiness-query-params';
import type { OperationalContext } from '@/lib/operational-policy/types';
import type { ReadinessForm } from '@/lib/readiness/default-readiness-profile';

export function buildPolicyQueryParams(
  form: ReadinessForm & { context: OperationalContext },
  companyId: string,
): URLSearchParams {
  const params = buildReadinessQueryParams(form, companyId);
  params.set('context', form.context);
  return params;
}
