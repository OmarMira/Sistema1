import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiHandler } from '@/lib/api-handler';

/**
 * First-run probe. A zero-company database is only a FRESH installation when it
 * also has no retained audit history: audit rows outlive their company, so a
 * deliberate deletion must never be mistaken for a formatted machine.
 */
export const GET = apiHandler(
  async () => {
    const [companyCount, userCount, auditCount] = await Promise.all([
      db.company.count(),
      db.user.count(),
      db.auditLog.count(),
    ]);
    return NextResponse.json({
      empty: companyCount === 0,
      hasUsers: userCount > 0,
      freshInstallation: companyCount === 0 && auditCount === 0,
      retainedAudit: companyCount === 0 && auditCount > 0,
    });
  },
  { allowAnonymous: true, requireMembership: false },
);
