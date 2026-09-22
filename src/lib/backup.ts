import { db } from '@/lib/db';
import bcrypt from 'bcryptjs';
import { hashPassword } from './auth';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { RUNTIME_FILES } from '@/lib/config/paths';
import { AI_CONFIG } from '@/lib/constants/ai-config';
import { logger } from './logger';
// JH2: pure chain-verdict (no DB access) — restore certifies the chain head
// inside its own transaction without touching the global db.
import { buildChainVerdict, type ChainRow } from './journal-hash';

/* ─── Types ───────────────────────────────────────────────────────── */

export interface BackupManifest {
  version: string;
  createdAt: string;
  companyId: string;
  companyInfo: {
    id: string;
    legalName: string;
    taxId: string | null;
  };
  recordCounts: {
    company: number;
    glAccounts: number;
    bankAccounts: number;
    bankStatements: number;
    bankTransactions: number;
    bankRules: number;
    journalEntries: number;
    journalLines: number;
    fiscalPeriods: number;
    companyMembers: number;
    users: number;
    systemConfig: number;
    companyConfig: boolean;
    // D10-E: reconciliation subsystem counts (optional for legacy 1.0.0 backups)
    reconciliationPeriods?: number;
    companyKnowledge?: number;
    knowledgeAudit?: number;
    // H-DR-1C: Memory Core counts (optional for legacy backups; required for
    // format >= 1.1.0). POLICY_A = MEMORY_FOLLOWS_BACKUP.
    systemMemories?: number;
    memoryItems?: number;
    memoryVersions?: number;
    relationships?: number;
    contradictions?: number;
    evolutionLinks?: number;
    traceabilityLogs?: number;
    confidenceLogs?: number;
  };
}

export interface BackupData {
  manifest: BackupManifest;
  data: {
    company: Record<string, unknown>[];
    glAccounts: Record<string, unknown>[];
    bankAccounts: Record<string, unknown>[];
    bankStatements: Record<string, unknown>[];
    bankTransactions: Record<string, unknown>[];
    bankRules: Record<string, unknown>[];
    journalEntries: Record<string, unknown>[];
    journalLines: Record<string, unknown>[];
    fiscalPeriods: Record<string, unknown>[];
    companyMembers: Record<string, unknown>[];
    users: Record<string, unknown>[];
    systemConfig: Record<string, unknown>[];
    companyConfig: Record<string, unknown> | null;
    // D10-E: reconciliation subsystem data (optional for legacy 1.0.0 backups)
    reconciliationPeriods?: Record<string, unknown>[];
    companyKnowledge?: Record<string, unknown>[];
    knowledgeAudit?: Record<string, unknown>[];
    // H-DR-1C: Memory Core data (optional for legacy backups; required for
    // format >= 1.1.0). POLICY_A = MEMORY_FOLLOWS_BACKUP — a restore must leave
    // the destination memory exactly as captured in this snapshot.
    systemMemories?: Record<string, unknown>[];
    memoryItems?: Record<string, unknown>[];
    memoryVersions?: Record<string, unknown>[];
    relationships?: Record<string, unknown>[];
    contradictions?: Record<string, unknown>[];
    evolutionLinks?: Record<string, unknown>[];
    traceabilityLogs?: Record<string, unknown>[];
    confidenceLogs?: Record<string, unknown>[];
    // JH2: authoritative per-company chain tail (optional — legacy backups
    // predate the journal hash chain). Internal row id is intentionally NOT
    // exported; the head is keyed by companyId and reconstructed on restore.
    journalChainHead?: {
      companyId: string;
      lastHash: string | null;
      lastEntryId: string | null;
    } | null;
  };
}

export interface BackupRecord {
  id: string;
  filename: string;
  size: number;
  createdAt: string;
  companyInfo: {
    id: string;
    legalName: string;
  };
  recordCounts: BackupManifest['recordCounts'];
}

interface ManifestFile {
  backups: Array<{
    id: string;
    filename: string;
    companyId: string;
    size: number;
    createdAt: string;
    companyLegalName: string;
    recordCounts: BackupManifest['recordCounts'];
  }>;
}

/* ─── Constants ───────────────────────────────────────────────────── */

const BACKUP_DIR = path.join(process.cwd(), 'db', 'backups');
const MANIFEST_PATH = path.join(BACKUP_DIR, 'manifest.json');
const BACKUP_VERSION = '1.1.0';

/**
 * H-DR-1C: true when the backup manifest version carries Memory Core
 * ("memory follows backup" format, >= 1.1.0). Older valid backups are legacy:
 * they legitimately have no memory data, and a restore must leave the
 * destination Memory Core EMPTY instead of preserving unrelated memory.
 */
const MEMORY_CORE_FORMAT_VERSION = '1.1.0';

function backupVersionAtLeast(version: string, target: string): boolean {
  const parse = (v: string) =>
    v.split('.').map((part) => {
      const n = Number.parseInt(part, 10);
      return Number.isNaN(n) ? 0 : n;
    });
  const a = parse(version);
  const b = parse(target);
  for (let i = 0; i < 3; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av !== bv) return av > bv;
  }
  return true;
}

/* ─── Helpers ─────────────────────────────────────────────────────── */

function ensureBackupDir(): void {
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }
}

function readManifest(): ManifestFile {
  ensureBackupDir();
  if (!fs.existsSync(MANIFEST_PATH)) {
    return { backups: [] };
  }
  try {
    const raw = fs.readFileSync(MANIFEST_PATH, 'utf-8');
    return JSON.parse(raw) as ManifestFile;
  } catch (err) {
    logger.warn('[BACKUP MANIFEST] Parse error — resetting manifest', {
      error: String(err),
      path: MANIFEST_PATH,
    });
    return { backups: [] };
  }
}

function writeManifest(manifest: ManifestFile): void {
  ensureBackupDir();
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf-8');
}

const RESTORE_EXCLUDED_KEYS = new Set([
  'createdAt',
  'updatedAt',
  'passwordHash',
  'transactions',
  'user',
  'lines',
]);

function sanitizeForRestore(
  obj: Record<string, unknown>,
  options?: { preservePasswordHash?: boolean },
): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (RESTORE_EXCLUDED_KEYS.has(key)) {
      if (key === 'passwordHash' && options?.preservePasswordHash) {
        cleaned[key] = value;
      }
      continue;
    }
    cleaned[key] = value;
  }
  return cleaned;
}

/* ─── Role Normalization Helpers (RC2-3) ─────────────────────────── */

export type RestoredUserRole = 'user' | 'super_admin';
export type RestoredMembershipRole = 'company_admin' | 'employee' | 'viewer';

/**
 * Normalize a user role coming from a backup payload to the current global
 * authority contract: 'user' | 'super_admin'.
 *
 * legacy/tenant/unknown values always collapse to 'user' (fail-closed).
 * 'super_admin' is preserved ONLY when there is a trusted authority context:
 * either an authorized bootstrap restore (empty-DB recovery) or a normal
 * restore performed by an actor that is already a global super_admin. The
 * backup payload alone never grants global authority.
 */
export function normalizeRestoredUserRole(
  backupRole: unknown,
  context: { bootstrap?: boolean; restoringActorIsSuperAdmin?: boolean },
): RestoredUserRole {
  if (
    backupRole === 'super_admin' &&
    (Boolean(context.bootstrap) || Boolean(context.restoringActorIsSuperAdmin))
  ) {
    return 'super_admin';
  }
  return 'user';
}

/**
 * Normalize a company membership role coming from a backup payload to the
 * current tenant authority contract: 'company_admin' | 'employee' | 'viewer'.
 *
 * Known valid roles are preserved. Legacy 'super_admin' folds into
 * 'company_admin'. Any unknown value collapses to 'viewer' (minimum tenant
 * privilege, no operational capability granted without evidence).
 */
export function normalizeRestoredMembershipRole(role: unknown): RestoredMembershipRole {
  switch (role) {
    case 'company_admin':
      return 'company_admin';
    case 'employee':
      return 'employee';
    case 'viewer':
      return 'viewer';
    case 'super_admin':
      return 'company_admin';
    default:
      return 'viewer';
  }
}

/* ─── Exported Functions ──────────────────────────────────────────── */

/**
 * Filters out sensitive AI config keys from an array of SystemConfig records.
 * Used during both backup export and restore to prevent AI key leakage/overwrite.
 */
export function filterSensitiveSystemConfig(
  entries: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return entries.filter((entry) => {
    const key = typeof entry.key === 'string' ? entry.key : '';
    return !AI_CONFIG.STORAGE_KEYS_SET.has(key);
  });
}

/**
 * Create a full backup of all company data.
 * Returns the backup data and saves it to disk.
 */
export async function createBackup(companyId: string): Promise<{
  id: string;
  filename: string;
  size: number;
  createdAt: string;
  data: string;
  recordCounts: BackupManifest['recordCounts'];
}> {
  // Verify company exists
  const company = await db.company.findUnique({
    where: { id: companyId },
  });

  if (!company) {
    throw new Error('Company not found');
  }

  // Fetch ALL company data in parallel
  const [
    glAccounts,
    bankAccounts,
    bankStatements,
    bankTransactions,
    bankRules,
    journalEntries,
    journalLines,
    fiscalPeriods,
    companyMembers,
    reconciliationPeriods,
    companyKnowledge,
    knowledgeAudit,
    // H-DR-1C: Memory Core (POLICY_A — memory follows the backup snapshot)
    systemMemories,
    memoryItems,
    memoryVersions,
    relationshipsSourceFetched,
    contradictionsAFetched,
    evolutionLinksSourceFetched,
    traceabilityLogs,
    confidenceLogs,
  ] = await Promise.all([
    db.glAccount.findMany({ where: { companyId } }),
    db.bankAccount.findMany({ where: { companyId } }),
    db.bankStatement.findMany({
      where: { companyId },
      include: { transactions: true },
    }),
    // Fetch all transactions for the company (via statements)
    db.bankTransaction.findMany({
      where: { statement: { companyId } },
    }),
    db.bankRule.findMany({ where: { companyId } }),
    db.journalEntry.findMany({
      where: { companyId },
      include: { lines: true },
    }),
    db.journalLine.findMany({
      where: { entry: { companyId } },
    }),
    db.fiscalPeriod.findMany({ where: { companyId } }),
    db.companyMember.findMany({
      where: { companyId },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            firstName: true,
            lastName: true,
            platformRole: true,
            isActive: true,
            createdAt: true,
            updatedAt: true,
          },
        },
      },
    }),
    // D10-E: reconcile + knowledge subsystem data
    db.reconciliationPeriod.findMany({ where: { companyId } }),
    db.companyKnowledge.findMany({ where: { companyId } }),
    db.knowledgeAudit.findMany({ where: { companyKnowledge: { companyId } } }),
    // H-DR-1C: Memory Core — tenant-scoped export
    db.systemMemory.findMany({ where: { companyId } }),
    db.memoryItem.findMany({ where: { companyId } }),
    db.memoryVersion.findMany({ where: { item: { companyId } } }),
    db.relationship.findMany({ where: { source: { companyId } } }),
    db.contradiction.findMany({ where: { itemA: { companyId } } }),
    db.evolutionLink.findMany({ where: { superseded: { companyId } } }),
    db.traceabilityLog.findMany({ where: { item: { companyId } } }),
    db.confidenceLog.findMany({ where: { item: { companyId } } }),
  ]);

  // H-DR-1C: Memory Core graph edges have no direct companyId (they reference
  // two MemoryItems). Export only edges whose BOTH endpoints belong to this
  // tenant. A cross-tenant edge (one endpoint inside, one outside) is never
  // silently exported, repaired or deleted — the backup fails safely.
  const tenantItemIds = new Set(memoryItems.map((m) => m.id));
  function partitionMemoryEdges<F extends { sourceId: string; targetId: string }>(
    rows: F[],
  ): F[] {
    const inTenant: Array<F> = [];
    for (const edge of rows) {
      const srcIn = tenantItemIds.has(edge.sourceId);
      const tgtIn = tenantItemIds.has(edge.targetId);
      if (srcIn && tgtIn) {
        inTenant.push(edge);
      } else if (srcIn || tgtIn) {
        throw new Error(
          `Backup integrity error: cross-tenant ${'memory edge'} ${String(
            (edge as unknown as { id: string }).id,
          )} (source=${edge.sourceId}, target=${edge.targetId}) crosses tenant ${companyId}. Backup aborted.`,
        );
      }
    }
    return inTenant;
  }
  const relationships = partitionMemoryEdges(
    relationshipsSourceFetched as unknown as Array<{ id: string; sourceId: string; targetId: string }>,
  ) as unknown as Array<Record<string, unknown>>;
  const contradictions = (
    contradictionsAFetched as unknown as Array<Record<string, unknown>>
  ).filter((c) => {
    const both = tenantItemIds.has(c.itemAId as string) && tenantItemIds.has(c.itemBId as string);
    const either = tenantItemIds.has(c.itemAId as string) || tenantItemIds.has(c.itemBId as string);
    if (either && !both) {
      throw new Error(
        `Backup integrity error: cross-tenant Contradiction ${String(c.id)} detected. Backup aborted.`,
      );
    }
    return both;
  });
  const evolutionLinks = (evolutionLinksSourceFetched as unknown as Array<Record<string, unknown>>).filter(
    (l) => {
      const both = tenantItemIds.has(l.supersededId as string) && tenantItemIds.has(l.supersededById as string);
      const either = tenantItemIds.has(l.supersededId as string) || tenantItemIds.has(l.supersededById as string);
      if (either && !both) {
        throw new Error(
          `Backup integrity error: cross-tenant EvolutionLink ${String(l.id)} detected. Backup aborted.`,
        );
      }
      return both;
    },
  );

  // JH2: the authoritative chain tail travels inside the backup. The internal
  // row id is dropped; identity is companyId. No hashes recalculated.
  const chainHead = await db.journalChainHead.findUnique({
    where: { companyId },
    select: { companyId: true, lastHash: true, lastEntryId: true },
  });

  // Collect unique user IDs from company members
  const userIds = [...new Set(companyMembers.map((m) => m.userId))];
  const users =
    userIds.length > 0
      ? await db.user.findMany({
          where: { id: { in: userIds } },
          select: {
            id: true,
            email: true,
            firstName: true,
            lastName: true,
            platformRole: true,
            isActive: true,
            phone: true,
            streetLine1: true,
            streetLine2: true,
            city: true,
            state: true,
            zipCode: true,
            avatar: true,
            createdAt: true,
            updatedAt: true,
          },
        })
      : [];

  // Fetch SystemConfig (exclude AI config keys — they are environment-specific)
  const allSystemConfig = await db.systemConfig.findMany();
  const systemConfig = filterSensitiveSystemConfig(allSystemConfig);

  // Read company-config.json (currency, periodType)
  const configPath = RUNTIME_FILES.companyConfig;
  let companyConfig: Record<string, unknown> | null = null;
  try {
    if (fs.existsSync(configPath)) {
      const allConfig = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
        companies?: Record<string, unknown>;
      };
      if (allConfig.companies?.[companyId]) {
        companyConfig = allConfig.companies[companyId] as Record<string, unknown>;
      }
    }
  } catch {
    // Config file missing or corrupt — backup continues without it
  }

  // Collect statement IDs for filtering transactions
  const statementIds = bankStatements.map((s) => s.id);
  const companyTransactions = bankTransactions.filter((t) => statementIds.includes(t.statementId));

  // Collect entry IDs for filtering journal lines
  const entryIds = journalEntries.map((e) => e.id);
  const companyJournalLines = journalLines.filter((l) => entryIds.includes(l.entryId));

  const now = new Date();
  const backupId = crypto.randomUUID();
  const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `${companyId}_${timestamp}.json`;

  const recordCounts = {
    company: 1,
    glAccounts: glAccounts.length,
    bankAccounts: bankAccounts.length,
    bankStatements: bankStatements.length,
    bankTransactions: companyTransactions.length,
    bankRules: bankRules.length,
    journalEntries: journalEntries.length,
    journalLines: companyJournalLines.length,
    fiscalPeriods: fiscalPeriods.length,
    companyMembers: companyMembers.length,
    users: users.length,
    systemConfig: systemConfig.length,
    companyConfig: companyConfig !== null,
    // D10-E: reconcile + knowledge subsystem counts
    reconciliationPeriods: reconciliationPeriods.length,
    companyKnowledge: companyKnowledge.length,
    knowledgeAudit: knowledgeAudit.length,
    // H-DR-1C: Memory Core counts (POLICY_A — memory follows the backup)
    systemMemories: systemMemories.length,
    memoryItems: memoryItems.length,
    memoryVersions: memoryVersions.length,
    relationships: relationships.length,
    contradictions: contradictions.length,
    evolutionLinks: evolutionLinks.length,
    traceabilityLogs: traceabilityLogs.length,
    confidenceLogs: confidenceLogs.length,
  };

  const backupData: BackupData = {
    manifest: {
      version: BACKUP_VERSION,
      createdAt: now.toISOString(),
      companyId,
      companyInfo: {
        id: company.id,
        legalName: company.legalName,
        taxId: company.taxId,
      },
      recordCounts,
    },
    data: {
      company: [JSON.parse(JSON.stringify(company))],
      glAccounts: glAccounts.map((a) => JSON.parse(JSON.stringify(a))),
      bankAccounts: bankAccounts.map((a) => JSON.parse(JSON.stringify(a))),
      bankStatements: bankStatements.map((s) => JSON.parse(JSON.stringify(s))),
      bankTransactions: companyTransactions.map((t) => JSON.parse(JSON.stringify(t))),
      bankRules: bankRules.map((r) => JSON.parse(JSON.stringify(r))),
      journalEntries: journalEntries.map((e) => JSON.parse(JSON.stringify(e))),
      journalLines: companyJournalLines.map((l) => JSON.parse(JSON.stringify(l))),
      fiscalPeriods: fiscalPeriods.map((p) => JSON.parse(JSON.stringify(p))),
      companyMembers: companyMembers.map((m) => {
        const parsed = JSON.parse(JSON.stringify(m)) as Record<string, unknown>;
        const { user, ...memberRest } = parsed;
        if (user && typeof user === 'object') {
          const u = user as Record<string, unknown>;
          const { platformRole, ...userRest } = u;
          memberRest.user = { ...userRest, role: platformRole };
        }
        return memberRest;
      }),
      users: users.map((u) => {
        const { platformRole, ...rest } = JSON.parse(JSON.stringify(u)) as Record<string, unknown>;
        return { ...rest, role: platformRole };
      }),
      systemConfig: systemConfig.map((c) => JSON.parse(JSON.stringify(c))),
      companyConfig,
      // D10-E: reconcile + knowledge subsystem data
      reconciliationPeriods: reconciliationPeriods.map((r) =>
        JSON.parse(JSON.stringify(r)),
      ),
      companyKnowledge: companyKnowledge.map((k) => JSON.parse(JSON.stringify(k))),
      knowledgeAudit: knowledgeAudit.map((a) => JSON.parse(JSON.stringify(a))),
      // H-DR-1C: Memory Core data (verbatim rows, POLICY_A)
      systemMemories: systemMemories.map((m) => JSON.parse(JSON.stringify(m))),
      memoryItems: memoryItems.map((m) => JSON.parse(JSON.stringify(m))),
      memoryVersions: memoryVersions.map((m) => JSON.parse(JSON.stringify(m))),
      relationships: relationships.map((r) => JSON.parse(JSON.stringify(r))),
      contradictions: contradictions.map((c) => JSON.parse(JSON.stringify(c))),
      evolutionLinks: evolutionLinks.map((l) => JSON.parse(JSON.stringify(l))),
      traceabilityLogs: traceabilityLogs.map((t) => JSON.parse(JSON.stringify(t))),
      confidenceLogs: confidenceLogs.map((c) => JSON.parse(JSON.stringify(c))),
      // JH2: authoritative chain tail (null when the chain was never started)
      journalChainHead: chainHead
        ? {
            companyId: chainHead.companyId,
            lastHash: chainHead.lastHash,
            lastEntryId: chainHead.lastEntryId,
          }
        : null,
    },
  };

  const jsonString = JSON.stringify(backupData, null, 2);
  const size = Buffer.byteLength(jsonString, 'utf-8');

  // Save to file
  ensureBackupDir();
  fs.writeFileSync(path.join(BACKUP_DIR, filename), jsonString, 'utf-8');

  // Update manifest
  const manifest = readManifest();
  manifest.backups.push({
    id: backupId,
    filename,
    companyId,
    size,
    createdAt: now.toISOString(),
    companyLegalName: company.legalName,
    recordCounts,
  });
  writeManifest(manifest);

  return {
    id: backupId,
    filename,
    size,
    createdAt: now.toISOString(),
    data: Buffer.from(jsonString, 'utf-8').toString('base64'),
    recordCounts,
  };
}

/**
 * List all backups for a specific company.
 */
export function listBackups(companyId: string): BackupRecord[] {
  const manifest = readManifest();
  return manifest.backups
    .filter((b) => b.companyId === companyId)
    .map((b) => ({
      id: b.id,
      filename: b.filename,
      size: b.size,
      createdAt: b.createdAt,
      companyInfo: {
        id: b.companyId,
        legalName: b.companyLegalName,
      },
      recordCounts: b.recordCounts,
    }))
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

/**
 * Get a specific backup file as a string.
 */
export function getBackupFile(filename: string): { data: string; size: number } | null {
  ensureBackupDir();
  const filePath = path.join(BACKUP_DIR, filename);

  // Security: prevent directory traversal
  const resolved = path.resolve(filePath);
  const resolvedDir = path.resolve(BACKUP_DIR);
  if (!resolved.startsWith(resolvedDir)) {
    return null;
  }

  if (!fs.existsSync(filePath)) {
    return null;
  }

  const jsonString = fs.readFileSync(filePath, 'utf-8');
  return {
    data: jsonString,
    size: Buffer.byteLength(jsonString, 'utf-8'),
  };
}

export type DeleteBackupResult =
  | { status: 'invalid' }
  | { status: 'not_found' }
  | { status: 'deleted' };

/**
 * Delete a specific backup file, scoped to a single tenant.
 *
 * Ownership is anchored to the manifest: a request filename is only accepted
 * when it matches exactly one manifest entry (filename + companyId). The
 * manifest is the single source of truth written by createBackup, so an
 * attacker cannot forge an entry or reach another tenant's file by path
 * normalization.
 */
export function deleteBackup(filename: string, companyId: string): DeleteBackupResult {
  // A. Format gate — reject separators, traversal and non-backup names.
  if (
    !filename ||
    filename.includes('/') ||
    filename.includes('\\') ||
    filename.includes('..') ||
    !filename.endsWith('.json')
  ) {
    return { status: 'invalid' };
  }

  // B. Ownership — exact manifest entry for this tenant.
  const manifest = readManifest();
  const entry = manifest.backups.find(
    (b) => b.filename === filename && b.companyId === companyId,
  );
  if (!entry) {
    return { status: 'not_found' };
  }

  // C. Defense-in-depth: resolved path must stay strictly inside BACKUP_DIR.
  const filePath = path.join(BACKUP_DIR, entry.filename);
  const resolved = path.resolve(filePath);
  const resolvedDir = path.resolve(BACKUP_DIR);
  const relative = path.relative(resolvedDir, resolved);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    return { status: 'not_found' };
  }

  // D. Physical file must exist.
  if (!fs.existsSync(filePath)) {
    return { status: 'not_found' };
  }

  // E. Delete the exact authorized file, then remove only its manifest entry.
  fs.unlinkSync(filePath);
  manifest.backups = manifest.backups.filter(
    (b) => !(b.filename === entry.filename && b.companyId === entry.companyId),
  );
  writeManifest(manifest);

  return { status: 'deleted' };
}

/**
 * Validate backup structure before restore.
 */
export function validateBackup(backupData: BackupData): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!backupData.manifest) {
    errors.push('Missing manifest');
    return { valid: false, errors };
  }

  if (!backupData.manifest.version) {
    errors.push('Missing backup version');
  }

  if (!backupData.manifest.companyId) {
    errors.push('Missing companyId in manifest');
  }

  if (!backupData.data) {
    errors.push('Missing data section');
    return { valid: false, errors };
  }

  // Check required data sections (systemConfig and companyConfig are optional for backwards compatibility)
  const requiredSections = [
    'company',
    'glAccounts',
    'bankAccounts',
    'bankStatements',
    'bankTransactions',
    'bankRules',
    'journalEntries',
    'journalLines',
    'fiscalPeriods',
    'companyMembers',
    'users',
  ] as const;

  for (const section of requiredSections) {
    if (!Array.isArray(backupData.data[section])) {
      errors.push(`Missing or invalid data section: ${section}`);
    }
  }

  // Optional sections — warn but don't fail
  // systemConfig is optional for backwards compatibility; missing it should not invalidate the backup

  // H-DR-1C: POLICY_A — Memory Core follows the backup. Backups with format
  // >= 1.1.0 contractually carry the memory snapshot, so a NEW-FORMAT backup
  // missing a memory section is malformed (never silently degraded to legacy).
  // Legacy valid backups (< 1.1.0) legitimately have no memory sections.
  if (
    typeof backupData.manifest.version === 'string' &&
    backupVersionAtLeast(backupData.manifest.version, MEMORY_CORE_FORMAT_VERSION)
  ) {
    const memorySections = [
      'systemMemories',
      'memoryItems',
      'memoryVersions',
      'relationships',
      'contradictions',
      'evolutionLinks',
      'traceabilityLogs',
      'confidenceLogs',
    ] as const;
    for (const section of memorySections) {
      if (!Array.isArray(backupData.data[section])) {
        errors.push(`Missing or invalid memory section: ${section}`);
      }
    }
  }

  // Check company data
  if (backupData.data.company?.length === 0) {
    errors.push('No company data found');
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Compute hierarchical depth for each GL account in O(n) using memoization.
 */
function computeDepths(accounts: Record<string, unknown>[]): Map<string, number> {
  const map = new Map(accounts.map((a) => [a.id, a]));
  const depths = new Map<string, number>();

  function getDepth(id: string): number {
    if (depths.has(id)) return depths.get(id)!;
    const acc = map.get(id);
    if (!acc || !acc.parentId) {
      depths.set(id, 0);
      return 0;
    }
    const d = 1 + getDepth(acc.parentId as string);
    depths.set(id, d);
    return d;
  }

  for (const a of accounts) getDepth(a.id as string);
  return depths;
}

/**
 * Restore from backup data.
 * Uses a transaction to ensure atomicity.
 */
export async function restoreBackup(
  companyId: string,
  backupData: BackupData,
  userId: string,
  options?: {
    bootstrap?: boolean;
    restoringActorIsSuperAdmin?: boolean;
    /** B3.4: password set for the first (bootstrap) user, inside the restore tx. */
    bootstrapRecoveryPassword?: string;
  },
): Promise<{ success: boolean; message: string; restoredCounts: Record<string, number> }> {
  const validation = validateBackup(backupData);
  if (!validation.valid) {
    return {
      success: false,
      message: `Invalid backup structure: ${validation.errors.join(', ')}`,
      restoredCounts: {},
    };
  }

  // Verify the backup is for the correct company
  if (backupData.manifest.companyId !== companyId) {
    return {
      success: false,
      message: 'Backup does not match the selected company',
      restoredCounts: {},
    };
  }

  // RC2-3: the trusted authority context for normalizing restored user roles
  // comes from the caller (the authenticated actor derived from DB/session),
  // never from the backup payload itself.
  const restoreRoleContext = {
    bootstrap: Boolean(options?.bootstrap),
    restoringActorIsSuperAdmin: Boolean(options?.restoringActorIsSuperAdmin),
  };

  // Audit Contract v1 — SecurityEvent: restore initiated
  const restoreId = crypto.randomUUID();
  try {
    await db.auditLog.create({
      data: {
        companyId,
        userId,
        action: 'SECURITY_RESTORE_INITIATED',
        entity: 'Backup',
        entityId: restoreId,
        details: JSON.stringify({
          contractVersion: 1,
          bootstrap: !!options?.bootstrap,
          backupCompanyId: backupData.manifest.companyId,
          recordCounts: backupData.manifest.recordCounts,
        }),
      },
    });
  } catch {
    // SecurityEvent nunca bloquea (principio 0.9 — AuditLog no debe impedir recuperar el sistema)
  }

  try {
    const restoredCounts: Record<string, number> = {};

    // D10-B: the company-config.json payload is computed inside the transaction,
    // but the filesystem WRITE is deferred until AFTER the transaction commits.
    // This guarantees a DB rollback never leaves a persisted file that diverges
    // from the (rolled back) database.
    let companyConfigWrite: { configPath: string; content: string } | null = null;

    // Use a transaction for atomicity
    await db.$transaction(async (tx) => {
        // Step 1: Delete existing data (skip in bootstrap mode)
        if (!options?.bootstrap) {
          const statementIds = await tx.bankStatement.findMany({
            where: { companyId },
            select: { id: true },
          });
          if (statementIds.length > 0) {
            const result = await tx.bankTransaction.deleteMany({
              where: { statementId: { in: statementIds.map((s) => s.id) } },
            });
            restoredCounts.bankTransactionsDeleted = result.count;
          }

          const entryIds = await tx.journalEntry.findMany({
            where: { companyId },
            select: { id: true },
          });
          if (entryIds.length > 0) {
            const result = await tx.journalLine.deleteMany({
              where: { entryId: { in: entryIds.map((e) => e.id) } },
            });
            restoredCounts.journalLinesDeleted = result.count;
          }

          // D10-E: delete reconcile + knowledge subsystem data (order matters for FK
          // constraints: knowledgeAudit → companyKnowledge → reconciliationPeriod).
          const knowledgeIds = await tx.companyKnowledge.findMany({
            where: { companyId },
            select: { id: true },
          });
          if (knowledgeIds.length > 0) {
            const auditDeleted = await tx.knowledgeAudit.deleteMany({
              where: { knowledgeId: { in: knowledgeIds.map((k) => k.id) } },
            });
            restoredCounts.knowledgeAuditDeleted = auditDeleted.count;
          }
          const knowledgeDeleted = await tx.companyKnowledge.deleteMany({
            where: { companyId },
          });
          restoredCounts.companyKnowledgeDeleted = knowledgeDeleted.count;
          const periodDeleted = await tx.reconciliationPeriod.deleteMany({
            where: { companyId },
          });
          restoredCounts.reconciliationPeriodsDeleted = periodDeleted.count;

          const deleteOps = [
            { model: 'journalEntry', where: { companyId } },
            { model: 'bankStatement', where: { companyId } },
            { model: 'bankRule', where: { companyId } },
            { model: 'bankAccount', where: { companyId } },
            { model: 'fiscalPeriod', where: { companyId } },
            { model: 'companyMember', where: { companyId } },
            { model: 'glAccount', where: { companyId } },
          ] as const;

          for (const op of deleteOps) {
            // @ts-expect-error Dynamic model access
            const result = await tx[op.model].deleteMany({ where: op.where });
            restoredCounts[`${op.model}Deleted`] = result.count;
          }

          // H-DR-1C (POLICY_A): Memory Core follows the backup. Remove the
          // destination's existing memory for THIS tenant only, so the final
          // memory state matches the snapshot exactly (legacy backups without
          // memory data legitimately leave the memory EMPTY). MemoryItem
          // deletion DB-cascades its six children (MemoryVersion, Relationship,
          // Contradiction, EvolutionLink, TraceabilityLog, ConfidenceLog).
          // Memory of OTHER tenants is never touched (exact companyId filter).
          const memItemsDeleted = await tx.memoryItem.deleteMany({
            where: { companyId },
          });
          const sysMemDeleted = await tx.systemMemory.deleteMany({
            where: { companyId },
          });
          if (memItemsDeleted.count > 0 || sysMemDeleted.count > 0) {
            restoredCounts.memoryItemsDeleted = memItemsDeleted.count;
            restoredCounts.systemMemoriesDeleted = sysMemDeleted.count;
          }
        }

        // Step 2: Re-insert data

      // 2a. Upsert company so FK references work on clean DB
      const companyData = backupData.data.company[0];
      if (companyData) {
        const cleanCompany = sanitizeForRestore(companyData as Record<string, unknown>);
        await tx.company.upsert({
          where: { id: companyId },
          create: cleanCompany as never,
          update: cleanCompany as never,
        });
      }

      // 2b. Upsert users (create if missing, update if exists)
      // Business rule (F-5): restore must NOT replace credentials with a known
      // default. Preserve the hash from the backup in every restore mode; when a
      // hash is missing (old/handcrafted backups), generate a random secret that
      // no one knows — the operator must reset the password afterwards.
      const sanitizeOpts = { preservePasswordHash: true };
      let normalizedUserRoles = 0;
      for (const user of backupData.data.users) {
        const clean = sanitizeForRestore(user as Record<string, unknown>, sanitizeOpts);
        // RC2-3: normalize roles to the current global authority contract before
        // persisting. The backup payload alone never grants 'super_admin'.
        const originalRole = clean.role;
        clean.platformRole = normalizeRestoredUserRole(clean.role, restoreRoleContext);
        delete clean.role;
        if (clean.platformRole !== originalRole) normalizedUserRoles += 1;
        // passwordHash is required by Prisma but older backups may not include it.
        const pwHash = clean.passwordHash as string | undefined;
        if (!pwHash || !pwHash.startsWith('$2')) {
          clean.passwordHash = await bcrypt.hash(crypto.randomBytes(24).toString('base64url'), 12);
        }
        // B3.4: during bootstrap disaster recovery the authorized setup-token
        // caller supplies a known recovery password for the first restored
        // user (canonical hashPassword, product password policy). Applied
        // inside this transaction so a failed password establishment never
        // leaves an apparently successful restore. No plaintext is persisted
        // or logged — only the bcrypt hash of the new credential.
        const recoveryPassword = options?.bootstrapRecoveryPassword;
        if (
          user.id === userId &&
          typeof recoveryPassword === 'string' &&
          recoveryPassword.length > 0
        ) {
          clean.passwordHash = await hashPassword(recoveryPassword);
        }
        await tx.user.upsert({
          where: { id: user.id as string },
          create: clean as never,
          update: clean as never,
        });
      }

      // Insert company members
      let normalizedMembershipRoles = 0;
      // R2-4: validate ALL members before inserting any — fail-closed.
      const sanitizedMembers: Array<Record<string, unknown>> = [];
      for (const member of backupData.data.companyMembers) {
        const clean = sanitizeForRestore(member as Record<string, unknown>);
        if (clean.companyId !== companyId) {
          throw new Error(
            `Backup integrity error: CompanyMember ${clean.id ?? 'unknown'} has companyId ${clean.companyId} which does not match manifest companyId ${companyId}. Restore aborted.`,
          );
        }
        sanitizedMembers.push(clean);
      }
      // All validated — normalize roles, then batch insert (H-3: createMany)
      for (const clean of sanitizedMembers) {
        const originalMemberRole = clean.role;
        clean.role = normalizeRestoredMembershipRole(clean.role);
        if (clean.role !== originalMemberRole) normalizedMembershipRoles += 1;
      }
      if (sanitizedMembers.length > 0) {
        await tx.companyMember.createMany({ data: sanitizedMembers as never[], skipDuplicates: true });
      }
      restoredCounts.companyMembers = backupData.data.companyMembers.length;

      // Insert GL accounts (sorted by depth for multilevel hierarchy)
      const accountDepths = computeDepths(backupData.data.glAccounts);
      const sortedAccounts = [...backupData.data.glAccounts].sort(
        (a, b) =>
          (accountDepths.get(a.id as string) || 0) - (accountDepths.get(b.id as string) || 0),
      );
      const glAccountIdMap = new Map<string, string>();
      for (const account of sortedAccounts) {
        const clean = sanitizeForRestore(account as Record<string, unknown>);
        if (clean.parentId) {
          const oldParentId = clean.parentId as string;
          clean.parentId = glAccountIdMap.get(oldParentId) || oldParentId;
        }
        const created = await tx.glAccount.create({ data: clean as never });
        glAccountIdMap.set(account.id as string, created.id);
      }
      restoredCounts.glAccounts = backupData.data.glAccounts.length;

      // Insert bank accounts
      const bankAccountIdMap = new Map<string, string>();
      for (const account of backupData.data.bankAccounts) {
        const clean = sanitizeForRestore(account as Record<string, unknown>);
        // Map GL account reference
        const oldGlId = clean.glAccountId as string;
        clean.glAccountId = glAccountIdMap.get(oldGlId) || oldGlId;
        const created = await tx.bankAccount.create({ data: clean as never });
        bankAccountIdMap.set(account.id as string, created.id);
      }
      restoredCounts.bankAccounts = backupData.data.bankAccounts.length;

      // D10-E: Insert reconciliation periods (after bankAccounts so bankAccountId FK remaps)
      const reconciliationPeriodIdMap = new Map<string, string>();
      for (const period of backupData.data.reconciliationPeriods ?? []) {
        const clean = sanitizeForRestore(period as Record<string, unknown>);
        // Map bank account reference
        const oldBankId = clean.bankAccountId as string;
        clean.bankAccountId = bankAccountIdMap.get(oldBankId) || oldBankId;
        const created = await tx.reconciliationPeriod.create({ data: clean as never });
        reconciliationPeriodIdMap.set(period.id as string, created.id);
      }
      restoredCounts.reconciliationPeriods = backupData.data.reconciliationPeriods?.length ?? 0;

      // Insert bank statements
      const statementIdMap = new Map<string, string>();
      for (const statement of backupData.data.bankStatements) {
        const clean = sanitizeForRestore(statement as Record<string, unknown>);
        // Map bank account reference
        const oldBankId = clean.bankAccountId as string;
        clean.bankAccountId = bankAccountIdMap.get(oldBankId) || oldBankId;
        const created = await tx.bankStatement.create({ data: clean as never });
        statementIdMap.set(statement.id as string, created.id);
      }
      restoredCounts.bankStatements = backupData.data.bankStatements.length;

      // Insert bank rules FIRST so transactions can reference them
      const ruleIdMap = new Map<string, string>();
      for (const rule of backupData.data.bankRules) {
        const clean = sanitizeForRestore(rule as Record<string, unknown>);
        // Map GL account references
        const oldGlId = clean.glAccountId as string;
        clean.glAccountId = glAccountIdMap.get(oldGlId) || oldGlId;
        if (clean.debitGlAccountId) {
          const oldDebitId = clean.debitGlAccountId as string;
          clean.debitGlAccountId = glAccountIdMap.get(oldDebitId) || oldDebitId;
        }
        if (clean.creditGlAccountId) {
          const oldCreditId = clean.creditGlAccountId as string;
          clean.creditGlAccountId = glAccountIdMap.get(oldCreditId) || oldCreditId;
        }
        const created = await tx.bankRule.create({ data: clean as never });
        ruleIdMap.set(rule.id as string, created.id);
      }
      restoredCounts.bankRules = backupData.data.bankRules.length;

      // Insert bank transactions (rules already exist for matchedRuleId FK)
      for (const transaction of backupData.data.bankTransactions) {
        const clean = sanitizeForRestore(transaction as Record<string, unknown>);
        // Map statement reference
        const oldStatementId = clean.statementId as string;
        clean.statementId = statementIdMap.get(oldStatementId) || oldStatementId;
        // Map GL account reference
        if (clean.glAccountId) {
          const oldGlId = clean.glAccountId as string;
          clean.glAccountId = glAccountIdMap.get(oldGlId) || oldGlId;
        }
        // Map matched rule reference
        if (clean.matchedRuleId) {
          const oldRuleId = clean.matchedRuleId as string;
          clean.matchedRuleId = ruleIdMap.get(oldRuleId) || oldRuleId;
        }
        // Strip FKs to journal entities not restored yet (will be re-linked through app workflow)
        delete clean.journalEntryId;
        delete clean.journalLineId;
        // D10-E: remap reconciliation period reference (periods restored in a prior pass)
        if (clean.reconciliationPeriodId) {
          const oldReconId = clean.reconciliationPeriodId as string;
          clean.reconciliationPeriodId =
            reconciliationPeriodIdMap.get(oldReconId) || null;
        }
        await tx.bankTransaction.create({ data: clean as never });
      }
      restoredCounts.bankTransactions = backupData.data.bankTransactions.length;

      // Insert fiscal periods — no FK remapping, safe for createMany (H-3)
      if (backupData.data.fiscalPeriods.length > 0) {
        const cleanPeriods = backupData.data.fiscalPeriods.map(
          (p) => sanitizeForRestore(p as Record<string, unknown>),
        );
        await tx.fiscalPeriod.createMany({ data: cleanPeriods as never[], skipDuplicates: true });
      }
      restoredCounts.fiscalPeriods = backupData.data.fiscalPeriods.length;

      // Insert journal entries
      const entryIdMap = new Map<string, string>();
      for (const entry of backupData.data.journalEntries) {
        const clean = sanitizeForRestore(entry as Record<string, unknown>);
        // Remove lines from entry data (we create them separately)
        delete clean.lines;
        const created = await tx.journalEntry.create({ data: clean as never });
        entryIdMap.set(entry.id as string, created.id);
      }
      restoredCounts.journalEntries = backupData.data.journalEntries.length;

      // Insert journal lines
      for (const line of backupData.data.journalLines) {
        const clean = sanitizeForRestore(line as Record<string, unknown>);
        // Map entry reference
        const oldEntryId = clean.entryId as string;
        clean.entryId = entryIdMap.get(oldEntryId) || oldEntryId;
        // Map GL account reference
        const oldGlId = clean.glAccountId as string;
        clean.glAccountId = glAccountIdMap.get(oldGlId) || oldGlId;
        await tx.journalLine.create({ data: clean as never });
      }
      restoredCounts.journalLines = backupData.data.journalLines.length;

      // ─── JH2: restore the journal chain head with PROOF, inside this same tx ───
      // Entries + lines exist now, so the head can be certified against the
      // restored members before it is persisted. A wrong/corrupt chain state
      // FAILS the restore (full rollback), never silently invents a root.
      {
        const memberRows = (await tx.journalEntry.findMany({
          where: {
            companyId,
            OR: [{ status: 'posted' }, { status: 'void' }],
            hash: { not: null },
          },
          select: {
            id: true,
            companyId: true,
            date: true,
            description: true,
            reference: true,
            status: true,
            hash: true,
            previousHash: true,
            hashVersion: true,
            lines: { select: { glAccountId: true, debit: true, credit: true, description: true } },
          },
        })) as unknown as ChainRow[];

        const backupHead = backupData.data.journalChainHead ?? null;
        if (memberRows.length === 0 && backupHead && (backupHead.lastHash != null || backupHead.lastEntryId != null)) {
          throw new Error('JH2_CHAIN_HEAD_WITHOUT_MEMBERS');
        }
        if (memberRows.length === 0) {
          // The restored dataset has an empty chain: any leftover head row for
          // this company (non-bootstrap restore over an existing chain) would
          // become stale state. Coherent with CHAIN_HEAD_WITHOUT_MEMBERS.
          await tx.journalChainHead.deleteMany({ where: { companyId } });
        }

        if (memberRows.length > 0) {
          // Derivation mode (head=undefined): validate topology + recompute,
          // then bind the backup head against the certified TAIL below.
          const verdict = buildChainVerdict(companyId, memberRows, undefined);
          if (verdict.valid !== true) {
            throw new Error(`JH2_RESTORE_CHAIN_INVALID:${verdict.reasonCode ?? 'UNKNOWN'}`);
          }
          const tailId = verdict.tailId as string;
          const tailHash = verdict.tailHash as string;
          const companyMismatch = memberRows.find((m) => m.companyId !== companyId);
          if (companyMismatch) {
            throw new Error('JH2_RESTORE_TENANT_CROSSING');
          }
          if (backupHead) {
            // The backup carries an authoritative tail: the restored head must
            // verify against it (not merely against a derived value).
            if (
              backupHead.companyId !== companyId ||
              backupHead.lastHash !== tailHash ||
              backupHead.lastEntryId !== tailId
            ) {
              throw new Error('JH2_RESTORE_CHAIN_HEAD_MISMATCH');
            }
          }

          restoredCounts.journalChainHead = 1;
          await tx.journalChainHead.upsert({
            where: { companyId },
            create: { companyId, lastHash: tailHash, lastEntryId: tailId },
            update: { lastHash: tailHash, lastEntryId: tailId },
          });
        }
        // zero members + no/nil head → nothing to restore (valid empty chain).
      }

      // D10-E: Insert company knowledge. Two-pass to resolve the self-referential
      // mergedIntoId FK regardless of row order in the backup payload.
      const companyKnowledgeIdMap = new Map<string, string>();
      for (const knowledge of backupData.data.companyKnowledge ?? []) {
        const clean = sanitizeForRestore(knowledge as Record<string, unknown>);
        delete clean.mergedIntoId; // linked in pass 2
        const created = await tx.companyKnowledge.create({ data: clean as never });
        companyKnowledgeIdMap.set(knowledge.id as string, created.id);
      }
      for (const knowledge of backupData.data.companyKnowledge ?? []) {
        const oldMergedIntoId = knowledge.mergedIntoId as string | undefined;
        if (oldMergedIntoId && companyKnowledgeIdMap.has(oldMergedIntoId)) {
          await tx.companyKnowledge.update({
            where: { id: companyKnowledgeIdMap.get(knowledge.id as string) as string },
            data: { mergedIntoId: companyKnowledgeIdMap.get(oldMergedIntoId) as string },
          });
        }
      }
      restoredCounts.companyKnowledge = backupData.data.companyKnowledge?.length ?? 0;

      // D10-E: Insert knowledge audit entries (require CompanyKnowledge FK knowledgeId,
      // so they must be inserted after company knowledge).
      for (const audit of backupData.data.knowledgeAudit ?? []) {
        const clean = sanitizeForRestore(audit as Record<string, unknown>);
        // Map knowledge reference
        const oldKnowledgeId = clean.knowledgeId as string;
        clean.knowledgeId = companyKnowledgeIdMap.get(oldKnowledgeId) || oldKnowledgeId;
        await tx.knowledgeAudit.create({ data: clean as never });
      }
      restoredCounts.knowledgeAudit = backupData.data.knowledgeAudit?.length ?? 0;

      // H-DR-1C (POLICY_A): restore Memory Core exactly as captured in the
      // snapshot — verbatim rows and ids (no relearning, no recalculation).
      // Insert order follows FK: MemoryItem roots first, then children, then
      // SystemMemory (Company FK already satisfied by the company upsert).
      // Graph edges (Relationship/Contradiction/EvolutionLink) are validated
      // BEFORE insertion: every endpoint must be part of THIS tenant's
      // restored memory — a new-format backup whose family does not form a
      // closed tenant graph fails closed inside the transaction.
      const restoredMemoryItems = (backupData.data.memoryItems ?? []).map(
        (m) => sanitizeForRestore(m as Record<string, unknown>),
      );
      if (restoredMemoryItems.length > 0) {
        await tx.memoryItem.createMany({ data: restoredMemoryItems as never });
      }
      restoredCounts.memoryItems = restoredMemoryItems.length;
      const restoredItemIds = new Set(restoredMemoryItems.map((m) => m.id as string));

      const assertEdgeWithinTenant = (
        label: string,
        row: Record<string, unknown>,
        endpoints: unknown[],
      ): void => {
        if (!endpoints.every((ref) => ref !== undefined && restoredItemIds.has(ref as string))) {
          throw new Error(
            `Backup integrity error: ${label} ${String(row.id)} references a MemoryItem outside the restored tenant snapshot. Restore aborted.`,
          );
        }
      };

      const restoredRelationships = (backupData.data.relationships ?? []).map(
        (r) => sanitizeForRestore(r as Record<string, unknown>),
      );
      for (const row of restoredRelationships) {
        assertEdgeWithinTenant('Relationship', row, [row.sourceId, row.targetId]);
      }
      if (restoredRelationships.length > 0) {
        await tx.relationship.createMany({ data: restoredRelationships as never });
      }
      restoredCounts.relationships = restoredRelationships.length;

      const restoredContradictions = (backupData.data.contradictions ?? []).map(
        (c) => sanitizeForRestore(c as Record<string, unknown>),
      );
      for (const row of restoredContradictions) {
        assertEdgeWithinTenant('Contradiction', row, [row.itemAId, row.itemBId]);
      }
      if (restoredContradictions.length > 0) {
        await tx.contradiction.createMany({ data: restoredContradictions as never });
      }
      restoredCounts.contradictions = restoredContradictions.length;

      const restoredEvolutionLinks = (backupData.data.evolutionLinks ?? []).map(
        (l) => sanitizeForRestore(l as Record<string, unknown>),
      );
      for (const row of restoredEvolutionLinks) {
        assertEdgeWithinTenant('EvolutionLink', row, [row.supersededId, row.supersededById]);
      }
      if (restoredEvolutionLinks.length > 0) {
        await tx.evolutionLink.createMany({ data: restoredEvolutionLinks as never });
      }
      restoredCounts.evolutionLinks = restoredEvolutionLinks.length;

      const restoredMemoryVersions = (backupData.data.memoryVersions ?? []).map(
        (v) => sanitizeForRestore(v as Record<string, unknown>),
      );
      if (restoredMemoryVersions.length > 0) {
        await tx.memoryVersion.createMany({ data: restoredMemoryVersions as never });
      }
      restoredCounts.memoryVersions = restoredMemoryVersions.length;

      const restoredTraceabilityLogs = (backupData.data.traceabilityLogs ?? []).map(
        (t) => sanitizeForRestore(t as Record<string, unknown>),
      );
      if (restoredTraceabilityLogs.length > 0) {
        await tx.traceabilityLog.createMany({ data: restoredTraceabilityLogs as never });
      }
      restoredCounts.traceabilityLogs = restoredTraceabilityLogs.length;

      const restoredConfidenceLogs = (backupData.data.confidenceLogs ?? []).map(
        (c) => sanitizeForRestore(c as Record<string, unknown>),
      );
      if (restoredConfidenceLogs.length > 0) {
        await tx.confidenceLog.createMany({ data: restoredConfidenceLogs as never });
      }
      restoredCounts.confidenceLogs = restoredConfidenceLogs.length;

      const restoredSystemMemories = (backupData.data.systemMemories ?? []).map(
        (m) => sanitizeForRestore(m as Record<string, unknown>),
      );
      if (restoredSystemMemories.length > 0) {
        await tx.systemMemory.createMany({ data: restoredSystemMemories as never });
      }
      restoredCounts.systemMemories = restoredSystemMemories.length;

      // Restore SystemConfig (skip AI config keys — never overwrite active AI keys from backup)
      if (backupData.data.systemConfig && backupData.data.systemConfig.length > 0) {
        const filtered = filterSensitiveSystemConfig(backupData.data.systemConfig);
        for (const config of filtered) {
          const clean = sanitizeForRestore(config as Record<string, unknown>);
          await tx.systemConfig.upsert({
            where: { key: clean.key as string },
            create: clean as never,
            update: { value: clean.value as string },
          });
        }
        restoredCounts.systemConfig = filtered.length;
        const skipped = backupData.data.systemConfig.length - filtered.length;
        if (skipped > 0) {
          logger.info('[BACKUP RESTORE] Skipped AI config keys to prevent overwrite', { skipped });
        }
      }

      // Restore company-config.json (currency, periodType).
      // D10-B: compute the payload in-memory here; write to disk only after the
      // transaction commits (see below).
      if (backupData.data.companyConfig) {
        const configPath = RUNTIME_FILES.companyConfig;
        let allConfig: { companies?: Record<string, unknown> } = { companies: {} };
        try {
          if (fs.existsSync(configPath)) {
            allConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
          }
        } catch {
          // File corrupt — start fresh
        }
        if (!allConfig.companies) {
          allConfig.companies = {};
        }
        allConfig.companies[companyId] = backupData.data.companyConfig;
        companyConfigWrite = {
          configPath,
          content: JSON.stringify(allConfig, null, 2),
        };
        restoredCounts.companyConfig = 1;
      }

      // Audit Contract v1 — RESTORE_COMPLETED dentro de la transacción
      await tx.auditLog.create({
        data: {
          companyId,
          userId,
          action: 'RESTORE_COMPLETED',
          entity: 'Backup',
          entityId: restoreId,
          details: JSON.stringify({
            contractVersion: 1,
            bootstrap: !!options?.bootstrap,
            restoredCounts,
            backupCreatedAt: backupData.manifest.createdAt,
            normalizedUserRoles,
            normalizedMembershipRoles,
          }),
        },
      });
    });

    // D10-B: write company-config.json only AFTER the transaction committed. If the
    // transaction rolled back (e.g. auditLog.create failed), the file was never
    // written, so DB and filesystem stay in sync. A failure of this post-commit
    // write is NOT a restore failure: the DB is already restored and is the source
    // of truth, so it must not trigger the outer catch (which would falsely report
    // a rollback and emit RESTORE_FAILED).
    let configWriteFailed = false;
    if (companyConfigWrite) {
      const { configPath, content } = companyConfigWrite;
      try {
        if (!fs.existsSync(path.dirname(configPath))) {
          fs.mkdirSync(path.dirname(configPath), { recursive: true });
        }
        fs.writeFileSync(configPath, content, 'utf-8');
      } catch (error) {
        configWriteFailed = true;
        const errMsg =
          error instanceof Error ? `${error.name}: ${error.message}` : 'Unknown error';
        logger.warn(
          '[BACKUP RESTORE] Database restored but company-config.json could not be updated',
          { configPath, error: errMsg },
        );
      }
    }

    return {
      success: true,
      message: configWriteFailed
        ? 'Backup restored successfully. Warning: company-config.json could not be updated.'
        : 'Backup restored successfully',
      restoredCounts,
    };
  } catch (error) {
    const errMsg = error instanceof Error ? `${error.name}: ${error.message}` : 'Unknown error';
    logger.error('[BACKUP RESTORE ERROR]', { error: errMsg });

    // Audit Contract v1 — RESTORE_FAILED fuera de la transacción (ya hizo rollback)
    try {
      await db.auditLog.create({
        data: {
          companyId,
          userId,
          action: 'RESTORE_FAILED',
          entity: 'Backup',
          entityId: restoreId,
          details: JSON.stringify({
            contractVersion: 1,
            error: errMsg,
          }),
        },
      });
    } catch {
      // Auditoría de fallo nunca debe impedir la respuesta (principio 0.9)
    }

    return {
      success: false,
      message: `Restore failed. The database was rolled back to its previous state. Error: ${errMsg}`,
      restoredCounts: {},
    };
  }
}
