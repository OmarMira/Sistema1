import { execFileSync } from 'child_process';
import path from 'path';

export default function globalSetup() {
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
}
