import { expect, it, vi } from 'vitest';
import { makeSnapshot } from './helpers';

vi.mock('@/lib/db', () => ({
  db: { $transaction: vi.fn(), auditLog: { create: vi.fn() } },
  withCompanyBackupTransaction: vi.fn(),
}));

import { restoreBackup } from '@/lib/backup';
import { db } from '@/lib/db';

// Coverage of an existing fence, not a new behavior: company-format snapshots
// must never reach the retired legacy writer. The former assertion lived in a
// removed design suite; keep this current contract discoverable and executable.
it('refuses a current company snapshot before any legacy write or audit event', async () => {
  const snapshot = makeSnapshot();
  const result = await restoreBackup(snapshot.manifest.companyId, snapshot, 'owner');
  expect(result).toEqual({
    success: false,
    message: `Invalid backup structure: Backup format ${snapshot.manifest.version} requires the company recovery implementation; legacy restore is not supported`,
    restoredCounts: {},
  });
  expect(db.$transaction).not.toHaveBeenCalled();
  expect(db.auditLog.create).not.toHaveBeenCalled();
});
