import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { withRuntimeOperation, withRuntimeOperationSync } from '../backup-runtime-maintenance';
import { runBackupRetention } from '../backup-runtime-maintenance';

export async function cleanupExpiredSessions(): Promise<void> {
  try {
    await withRuntimeOperation(async () => {
    const result = await db.session.deleteMany({
      where: {
        expiresAt: {
          lt: new Date(),
        },
      },
    });
    if (result.count > 0) {
      logger.info('SESSION_CLEANUP_SUCCESS', { deletedCount: result.count });
    }
    });
  } catch (err) {
    logger.error('SESSION_CLEANUP_ERROR', { error: String(err) });
  }
}

export function startSessionCleanupInterval(): void {
  return withRuntimeOperationSync(startAdmittedSessionCleanup);
}

function startAdmittedSessionCleanup(): void {
  // Run once immediately on startup
  cleanupExpiredSessions().catch((err) => {
    logger.error('SESSION_CLEANUP_START_ERROR', { error: String(err) });
  });

  // Then run every 1 hour
  const ONE_HOUR = 60 * 60 * 1000;
  setInterval(() => {
    cleanupExpiredSessions()
      .then(() => runBackupRetention())
      .catch((err) => {
        logger.error('SESSION_CLEANUP_INTERVAL_ERROR', { error: String(err) });
      });
  }, ONE_HOUR);
}
