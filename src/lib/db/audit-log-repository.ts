import type { ExtendedPrismaClient } from '../db';
import type {
  AuditLogRepository,
  ShadowMetricsQuery,
  ShadowAuditLogRecord,
} from '../services/shadow-metrics-reader';

export class PrismaAuditLogRepository implements AuditLogRepository {
  constructor(private readonly prisma: ExtendedPrismaClient) {}

  async findShadowSummaries(query: ShadowMetricsQuery): Promise<ShadowAuditLogRecord[]> {
    const entityFilter = query.source === 'ALL'
      ? ['BankStatement', 'ApplyAllBatch']
      : query.source === 'IMPORT'
        ? ['BankStatement']
        : ['ApplyAllBatch'];

    const rows = await this.prisma.auditLog.findMany({
      where: {
        companyId: query.companyId,
        entity: { in: entityFilter },
        action: 'RULE_PRECEDENCE_SHADOW_SUMMARY',
        createdAt: { gte: query.from, lte: query.to },
      },
      select: {
        id: true,
        companyId: true,
        action: true,
        entity: true,
        entityId: true,
        details: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    return rows.map((r) => ({
      id: r.id,
      companyId: r.companyId ?? '',
      action: r.action,
      entity: r.entity,
      entityId: r.entityId,
      details: r.details,
      createdAt: r.createdAt,
    }));
  }
}
