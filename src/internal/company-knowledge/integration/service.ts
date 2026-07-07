import { db } from '@/lib/db';
import type { CompanyKnowledgeRecord, EntityType } from '../entity/types';
import { resolveDecisionReason } from '../entity/types';
import { proposeCreate } from '../entity/service';
import type {
  EntityContextReader,
  EntityContextWriter,
  EntityContextEntry,
} from './adapter';
import { CompanyKnowledgeMatcher } from './matcher';

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

export interface ExplainabilityPayload {
  source: string;
  knowledgeId: string;
  canonicalName: string;
  relationship: string | null;
  version: number;
  decisionReason: string;
}

export interface SyncOrchestratorOptions {
  reader: EntityContextReader;
  writer: EntityContextWriter;
}

export interface SyncResult {
  created: number;
  skipped: number;
  warned: number;
}

// ───────────────────────────────────────────────
// Default entity type inferrer from context hints
// ───────────────────────────────────────────────

export function inferEntityType(entry: EntityContextEntry): EntityType {
  const hints = entry.contextHints ?? {};

  if ('assetType' in hints) return 'asset';
  if ('productType' in hints) return 'financial_product';
  if ('platformType' in hints) return 'platform';
  if ('industry' in hints || 'taxId' in hints) return 'company';

  return 'person';
}

// ───────────────────────────────────────────────
// SyncOrchestrator
// ───────────────────────────────────────────────

export class SyncOrchestrator {
  private readonly reader: EntityContextReader;
  private readonly writer: EntityContextWriter;

  constructor(options: SyncOrchestratorOptions) {
    this.reader = options.reader;
    this.writer = options.writer;
  }

  // ─────────────────────────────────────────────
  // inboundSync — EntityContext → Company Knowledge
  //
  // Reads context entries for a company. For each entry, checks
  // if a similar entity already exists in CK. If not, creates a
  // PendingApproval proposal via the approval gate.
  // ─────────────────────────────────────────────

  async inboundSync(
    companyId: string,
    requestedBy: string,
    typeForEntry?: (entry: EntityContextEntry) => EntityType,
  ): Promise<SyncResult> {
    const entries = await this.reader.pull(companyId);
    const activeRecords = (await db.companyKnowledge.findMany({
      where: { companyId, status: 'active' },
    })) as unknown as CompanyKnowledgeRecord[];

    const matcher = new CompanyKnowledgeMatcher(activeRecords);
    const resolveType = typeForEntry ?? inferEntityType;

    let created = 0;
    let skipped = 0;
    let warned = 0;

    for (const entry of entries) {
      const match = matcher.match(entry.rawName);

      // Exact or high_similarity → block creation
      if (match.type === 'exact' || match.type === 'high_similarity') {
        skipped++;
        continue;
      }

      // medium_similarity → warn but still create
      if (match.type === 'medium_similarity') {
        warned++;
      }

      // no_match or medium_similarity → propose creation
      const entityType = resolveType(entry);

      await proposeCreate({
        companyId,
        type: entityType,
        canonicalName: entry.rawName,
        aliases: [],
        metadata: entry.contextHints as Record<string, unknown>,
        source: 'entity_context',
        requestedBy,
      });

      created++;
    }

    return { created, skipped, warned };
  }

  // ─────────────────────────────────────────────
  // outboundSync — Company Knowledge → EntityContext
  //
  // Reads active CK entities for the company and pushes
  // DetectionBias[] to the EntityContextWriter.
  // ─────────────────────────────────────────────

  async outboundSync(companyId: string): Promise<void> {
    const records = (await db.companyKnowledge.findMany({
      where: { companyId, status: 'active' },
    })) as unknown as CompanyKnowledgeRecord[];

    const biases = records.map((r) => ({
      knowledgeId: r.id,
      type: r.type as EntityType,
      canonicalName: r.canonicalName,
      aliases: r.aliases ?? [],
      relationship: r.relationship ?? '',
      decisionReason: 'company_knowledge_confirmed',
    }));

    await this.writer.push(companyId, biases);
  }

  // ─────────────────────────────────────────────
  // onConfirm — after a PendingApproval is confirmed
  //
  // Pushes the single confirmed entity as a detection bias
  // so EntityContext prefers it on subsequent detections.
  // ─────────────────────────────────────────────

  async onConfirm(knowledgeId: string, companyId: string): Promise<void> {
    const record = (await db.companyKnowledge.findUnique({
      where: { id: knowledgeId },
    })) as unknown as CompanyKnowledgeRecord | null;

    if (!record || record.companyId !== companyId) {
      return;
    }

    await this.writer.push(companyId, [
      {
        knowledgeId: record.id,
        type: record.type as EntityType,
        canonicalName: record.canonicalName,
        aliases: record.aliases ?? [],
        relationship: record.relationship ?? '',
        decisionReason: 'company_knowledge_confirmed',
      },
    ]);
  }

  // ─────────────────────────────────────────────
  // onArchive — after an entity is archived
  //
  // Pushes a tombstone bias so EntityContext knows this
  // entity is no longer authoritative.
  // ─────────────────────────────────────────────

  async onArchive(knowledgeId: string, companyId: string): Promise<void> {
    const record = (await db.companyKnowledge.findUnique({
      where: { id: knowledgeId },
    })) as unknown as CompanyKnowledgeRecord | null;

    if (!record || record.companyId !== companyId) {
      return;
    }

    await this.writer.push(companyId, [
      {
        knowledgeId: record.id,
        type: record.type as EntityType,
        canonicalName: record.canonicalName,
        aliases: record.aliases ?? [],
        relationship: record.relationship ?? '',
        decisionReason: 'knowledge_archived',
      },
    ]);
  }

  // ─────────────────────────────────────────────
  // onMerge — after source is merged into target
  //
  // Pushes the merged target bias so EntityContext
  // migrates references from source to target.
  // ─────────────────────────────────────────────

  async onMerge(
    sourceKnowledgeId: string,
    targetKnowledgeId: string,
    companyId: string,
  ): Promise<void> {
    const target = (await db.companyKnowledge.findUnique({
      where: { id: targetKnowledgeId },
    })) as unknown as CompanyKnowledgeRecord | null;

    if (!target || target.companyId !== companyId) {
      return;
    }

    await this.writer.push(companyId, [
      {
        knowledgeId: targetKnowledgeId,
        type: target.type as EntityType,
        canonicalName: target.canonicalName,
        aliases: target.aliases ?? [],
        relationship: target.relationship ?? '',
        decisionReason: 'company_knowledge_merged',
      },
    ]);
  }

  // ─────────────────────────────────────────────
  // explain — explainability payload
  //
  // Returns full provenance for a knowledge entity.
  // ─────────────────────────────────────────────

  async explain(
    knowledgeId: string,
  ): Promise<ExplainabilityPayload | { source: string }> {
    const record = (await db.companyKnowledge.findUnique({
      where: { id: knowledgeId },
    })) as unknown as CompanyKnowledgeRecord | null;

    if (!record) {
      return { source: 'unknown' };
    }

    return {
      source: record.source,
      knowledgeId: record.id,
      canonicalName: record.canonicalName,
      relationship: record.relationship,
      version: record.version,
      decisionReason: resolveDecisionReason(record.source),
    };
  }
}
