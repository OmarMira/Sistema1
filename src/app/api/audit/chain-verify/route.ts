import { NextRequest, NextResponse } from 'next/server';
import { apiHandler, type RouteContext } from '@/lib/api-handler';
import { requireCompanyContext } from '@/lib/context-storage';
import { requireCompanyRole } from '@/lib/rbac';
import { verifyAuditChain, verifyJournalChain } from '@/lib/journal-hash';

/**
 * S12 — GET /api/audit/chain-verify
 *
 * Exposes the cryptographic chain verdicts so tampering is detectable at
 * runtime instead of only after a forensic export.
 *
 * - `journal`: verified through buildChainVerdict and therefore SCOPED to the
 *   caller's company (its rows and its chain-head row).
 * - `audit`: the audit chain is GLOBAL — its `previousHash` links cross tenant
 *   boundaries, so it cannot be filtered per company without breaking it. It is
 *   verified over the whole chain, `companyRows` counts the caller's own rows,
 *   and a break located in another tenant is reported redacted (no cross-tenant
 *   identifiers).
 *
 * Same role tier as the other audit/backup surfaces: company_admin.
 */
export const GET = apiHandler(async (_request: NextRequest, _context: RouteContext) => {
  const { companyId } = requireCompanyContext();

  await requireCompanyRole(companyId, ['company_admin']);

  const [journal, audit] = await Promise.all([
    verifyJournalChain(companyId),
    verifyAuditChain({ companyId }),
  ]);

  return NextResponse.json({ companyId, journal, audit });
});
