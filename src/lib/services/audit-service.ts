import { createAuditLogWithRetry } from '../audit';
import { logger } from '../logger';

export async function safeAuditLog(data: {
  companyId: string;
  userId: string;
  action: string;
  entity: string;
  entityId?: string;
  details?: Record<string, unknown>;
}) {
  let entity = data.entity;
  if (!entity) {
    logger.warn('⚠️ AuditLog sin entidad, aplicando fallback "System"');
    entity = 'System';
  }

  return createAuditLogWithRetry({
    companyId: data.companyId,
    userId: data.userId,
    action: data.action,
    entity: entity,
    entityId: data.entityId || null,
    details: data.details ? JSON.stringify(data.details) : null,
  });
}
