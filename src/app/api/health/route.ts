import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { readJsonConfig } from '@/lib/config-loader';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  try {
    // 1. Verificar conexión DB (ligero, sin carga de esquema)
    await db.$queryRaw`SELECT 1`;

    // 2. Cargar versión de configuración de seguridad
    const config = await readJsonConfig<{ version?: string }>('security-config.json');

    // 3. Métricas operativas (no sensibles)
    const [lastBackup, audit24h, lockedPeriods] = await Promise.all([
      db.auditLog.findFirst({
        where: { action: 'BACKUP_CREATED' },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      }),
      db.auditLog.count({
        where: { createdAt: { gte: new Date(Date.now() - 86400000) } },
      }),
      db.fiscalPeriod.count({ where: { isLocked: true } }),
    ]);

    return NextResponse.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      version: process.env.APP_VERSION || '3.0.0',
      database: 'connected',
      metrics: {
        lastBackupAt: lastBackup?.createdAt || null,
        auditEventsLast24h: audit24h,
        lockedFiscalPeriods: lockedPeriods,
      },
      config: {
        securityVersion: config.version,
        rateLimitEnabled: true,
      },
    });
  } catch (err) {
    const errMsg = err instanceof Error ? `${err.name}: ${err.message}` : 'Unknown error';
    logger.error('[HEALTH CHECK FAILED]', { error: errMsg });
    return NextResponse.json(
      { status: 'degraded', timestamp: new Date().toISOString() },
      { status: 503 },
    );
  }
}
