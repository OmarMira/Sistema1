import { db } from '@/lib/db';
import { AccountsClient } from '@/components/spa/AccountsClient';
import { AppShell } from '@/components/spa/AppShell';
import { cookies } from 'next/headers';
import { requireSsrCompanyContext } from '@/lib/ssr-context';

export const dynamic = 'force-dynamic';

type GlAccount = Awaited<ReturnType<typeof db.glAccount.findMany>>[number];

export default async function AccountsServerPage() {
  const cookieStore = await cookies();
  const companyIdCandidate = cookieStore.get('companyId')?.value;

  const ctx = await requireSsrCompanyContext(companyIdCandidate);

  let initialAccounts: GlAccount[] = [];
  if (ctx.ok) {
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

  return (
    <AppShell>
      <AccountsClient initialAccounts={initialAccounts} />
    </AppShell>
  );
}
