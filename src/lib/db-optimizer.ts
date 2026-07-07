// ─── PostgreSQL Connection Health Check ──────────────────────────────────────
// No PRAGMAs needed — PostgreSQL uses WAL natively and tuning is server-level.
// This just verifies connectivity and sets a safe statement timeout.

import { db } from './db';
import { logger } from './logger';

export async function optimizeSQLite() {
  try {
    // Verify connection with a lightweight query
    const result = await db.$queryRawUnsafe<{ version: string }[]>('SELECT version()');
    const pgVersion = result?.[0]?.version ?? 'unknown';
    logger.info('PG_CONNECTED', { version: pgVersion });

    // Set a sane session-level statement timeout (30s) to prevent runaway queries
    await db.$executeRawUnsafe("SET statement_timeout = '30s'");
    logger.info('PG_STATEMENT_TIMEOUT_SET', { timeout: '30s' });
  } catch (error) {
    logger.error('PG_CONNECTION_FAILED', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
