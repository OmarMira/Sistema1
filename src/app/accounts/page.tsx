import { db } from '@/lib/db';
import { AccountsClient } from '@/components/spa/AccountsClient';
import { AppShell } from '@/components/spa/AppShell';
import { cookies } from 'next/headers';
import { requireSsrCompanyContext } from '@/lib/ssr-context';
import { assertCompanyModuleEntitlement } from '@/lib/module-entitlement-guard';

export const dynamic = 'force-dynamic';

type GlAccount = Awaited<ReturnType<typeof db.glAccount.findMany>>[number];

export default async function AccountsServerPage() {
  const cookieStore = await cookies();
  const companyIdCandidate = cookieStore.get('companyId')?.value;

  const ctx = await requireSsrCompanyContext(companyIdCandidate);

  let initialAccounts: GlAccount[] = [];
  if (ctx.ok) {
    // Commercial precondition (11D-D): chart of accounts belongs to the
    // accounting module. Checked with the already-validated ctx.companyId,
    // never with a request-controlled value. Fail closed with the neutral
    // empty state: Server Components have no 403 contract in this project
    // (no error.tsx), mirroring the SsrCompanyContext policy.
    let entitled = false;
    try {
      await assertCompanyModuleEntitlement(ctx.companyId, 'accounting');
      entitled = true;
    } catch {
      entitled = false;
    }

    if (entitled) {
      initialAccounts = await db.glAccount.findMany({
        where: { companyId: ctx.companyId },
        include: {
          _count: {
            select: { children: true, journalLines: true },
          },
        },
        orderBy: { code: 'asc' },
      });
    }
  }

  return (
    <AppShell>
      <AccountsClient initialAccounts={initialAccounts} />
    </AppShell>
  );
}
