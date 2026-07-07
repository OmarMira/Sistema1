import { db } from '@/lib/db';
import { logger } from '@/lib/logger';

export async function cleanupExpiredSessions(): Promise<void> {
  try {
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
  } catch (err) {
    logger.error('SESSION_CLEANUP_ERROR', { error: String(err) });
  }
}

export function startSessionCleanupInterval(): void {
  // Run once immediately on startup
  cleanupExpiredSessions().catch((err) => {
    logger.error('SESSION_CLEANUP_START_ERROR', { error: String(err) });
  });

  // Then run every 1 hour
  const ONE_HOUR = 60 * 60 * 1000;
  setInterval(() => {
    cleanupExpiredSessions().catch((err) => {
      logger.error('SESSION_CLEANUP_INTERVAL_ERROR', { error: String(err) });
    });
  }, ONE_HOUR);
}
