import { StructuralCandidatesClient } from '../_components/structural-candidates-client';
import { requireSsrCompanyContext } from '@/lib/ssr-context';

export const dynamic = 'force-dynamic';

export default async function StructuralCandidatesPage({
  searchParams,
}: {
  searchParams: Promise<{ companyId?: string }>;
}) {
  const { companyId } = await searchParams;
  const ctx = await requireSsrCompanyContext(companyId);

  if (!ctx.ok) {
    return (
      <div className="p-6">
        {ctx.reason === 'unauthenticated' && 'Authentication required'}
        {ctx.reason === 'missing-company' && 'Company context required'}
        {ctx.reason === 'forbidden' && 'Access denied'}
      </div>
    );
  }

  return <StructuralCandidatesClient companyId={ctx.companyId} />;
}
