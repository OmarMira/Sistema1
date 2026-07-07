import { db } from '@/lib/db';
import { AccountsClient } from '@/components/spa/AccountsClient';
import { AppShell } from '@/components/spa/AppShell';
import { cookies } from 'next/headers';

type GlAccount = Awaited<ReturnType<typeof db.glAccount.findMany>>[number];

export default async function AccountsServerPage() {
  const cookieStore = await cookies();
  const companyId = cookieStore.get('companyId')?.value;

  let initialAccounts: GlAccount[] = [];
  if (companyId) {
    initialAccounts = await db.glAccount.findMany({
      where: { companyId },
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
