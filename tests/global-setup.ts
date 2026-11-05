import { execFileSync } from 'child_process';
import path from 'path';
import { PrismaClient } from '@prisma/client';
import { BankProfileConfigSchema } from '../src/lib/bank-profile-schema';
import boaProfile from '../src/lib/bank-profiles/boa-standard.json';

export default async function globalSetup() {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error(
      '[TEST SAFETY] DATABASE_URL is not set. Cannot apply schema sync. Aborting.'
    );
  }

  const parsed = new URL(databaseUrl);
  const databaseName = parsed.pathname.replace(/^\//, '');

  if (databaseName !== 'accountexpress_test') {
    throw new Error(
      `[TEST SAFETY] DATABASE_URL database is "${databaseName}", not "accountexpress_test". ` +
      `Schema sync must only run on the test database. Aborting.`
    );
  }

  const nodeBin = process.execPath;
  const prismaScript = path.resolve(
    __dirname,
    '../node_modules/prisma/build/index.js'
  );

  execFileSync(
    nodeBin,
    [prismaScript, 'db', 'push', '--skip-generate'],
    {
      stdio: 'inherit',
      env: process.env,
    }
  );
  const db = new PrismaClient({ datasourceUrl: databaseUrl });
  try {
  const profilesToSeed = [
    {
      bankId: boaProfile.bankId,
      bankName: boaProfile.bankName,
      fingerprints: boaProfile.fingerprints,
      config: {
        layoutType: boaProfile.layoutType,
        lineGroupingTolerancePx: boaProfile.lineGroupingTolerancePx,
        numberFormat: boaProfile.numberFormat,
        rules: boaProfile.rules,
      },
    },
  ];

  for (const item of profilesToSeed) {
    const validation = BankProfileConfigSchema.safeParse(item.config);
    if (validation.success) {
      // S1 (Wave 5): bank profiles are company-scoped and a nullable companyId is
      // not addressable by a Prisma unique input, so the GLOBAL read-only seed
      // (companyId NULL) is addressed by id.
      const existingSeed = await db.bankProfile.findFirst({
        where: { bankId: item.bankId, companyId: null },
        select: { id: true },
      });
      if (existingSeed) {
        await db.bankProfile.update({
          where: { id: existingSeed.id },
          data: {
            bankName: item.bankName,
            fingerprints: JSON.stringify(item.fingerprints),
            config: JSON.stringify(validation.data),
          },
        });
      } else {
        await db.bankProfile.create({
          data: {
            bankId: item.bankId,
            bankName: item.bankName,
            fingerprints: JSON.stringify(item.fingerprints),
            config: JSON.stringify(validation.data),
            isActive: true,
          },
        });
      }
    }
  }
  } finally {
    await db.$disconnect();
  }
}
