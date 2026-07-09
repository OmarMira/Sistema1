import { db } from '@/lib/db';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { logger } from './logger';

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
const BACKUP_VERSION = '1.0.0';

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

/* ─── Exported Functions ──────────────────────────────────────────── */

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
            role: true,
            isActive: true,
            createdAt: true,
            updatedAt: true,
          },
        },
      },
    }),
  ]);

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
            role: true,
            isActive: true,
            phone: true,
            streetLine1: true,
            streetLine2: true,
            city: true,
            state: true,
            zipCode: true,
            avatar: true,
            passwordHash: true,
            createdAt: true,
            updatedAt: true,
          },
        })
      : [];

  // Fetch SystemConfig (AI API keys, settings)
  const systemConfig = await db.systemConfig.findMany();

  // Read company-config.json (currency, periodType)
  const configPath = path.join(process.cwd(), 'rules', 'company-config.json');
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
      companyMembers: companyMembers.map((m) => JSON.parse(JSON.stringify(m))),
      users: users.map((u) => JSON.parse(JSON.stringify(u))),
      systemConfig: systemConfig.map((c) => JSON.parse(JSON.stringify(c))),
      companyConfig,
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

/**
 * Delete a specific backup file.
 */
export function deleteBackup(filename: string): boolean {
  ensureBackupDir();
  const filePath = path.join(BACKUP_DIR, filename);

  // Security: prevent directory traversal
  const resolved = path.resolve(filePath);
  const resolvedDir = path.resolve(BACKUP_DIR);
  if (!resolved.startsWith(resolvedDir)) {
    return false;
  }

  if (!fs.existsSync(filePath)) {
    return false;
  }

  fs.unlinkSync(filePath);

  // Update manifest
  const manifest = readManifest();
  manifest.backups = manifest.backups.filter((b) => b.filename !== filename);
  writeManifest(manifest);

  return true;
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
  if (!Array.isArray(backupData.data.systemConfig)) {
    errors.push('Missing systemConfig section (AI settings will not be restored)');
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
  options?: { bootstrap?: boolean },
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

  try {
    const restoredCounts: Record<string, number> = {};

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
      const sanitizeOpts = options?.bootstrap ? { preservePasswordHash: true } : undefined;
      for (const user of backupData.data.users) {
        const clean = sanitizeForRestore(user as Record<string, unknown>, sanitizeOpts);
        // passwordHash is required by Prisma but older backups may not include it.
        // Generate a valid bcrypt hash so login works — user should reset password after restore.
        const pwHash = clean.passwordHash as string | undefined;
        if (!pwHash || !pwHash.startsWith('$2')) {
          clean.passwordHash = await bcrypt.hash('Admin123!', 12);
        }
        await tx.user.upsert({
          where: { id: user.id as string },
          create: clean as never,
          update: clean as never,
        });
      }

      // Insert company members
      for (const member of backupData.data.companyMembers) {
        const clean = sanitizeForRestore(member as Record<string, unknown>);
        await tx.companyMember.create({ data: clean as never });
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
        // Strip FKs to entities not restored yet (will be re-linked through app workflow)
        delete clean.journalEntryId;
        delete clean.journalLineId;
        delete clean.reconciliationPeriodId;
        await tx.bankTransaction.create({ data: clean as never });
      }
      restoredCounts.bankTransactions = backupData.data.bankTransactions.length;

      // Insert fiscal periods
      for (const period of backupData.data.fiscalPeriods) {
        const clean = sanitizeForRestore(period as Record<string, unknown>);
        await tx.fiscalPeriod.create({ data: clean as never });
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

      // Restore SystemConfig (AI API keys, settings)
      if (backupData.data.systemConfig && backupData.data.systemConfig.length > 0) {
        for (const config of backupData.data.systemConfig) {
          const clean = sanitizeForRestore(config as Record<string, unknown>);
          await tx.systemConfig.upsert({
            where: { key: clean.key as string },
            create: clean as never,
            update: { value: clean.value as string },
          });
        }
        restoredCounts.systemConfig = backupData.data.systemConfig.length;
      }

      // Restore company-config.json (currency, periodType)
      if (backupData.data.companyConfig) {
        const rulesDir = path.join(process.cwd(), 'rules');
        if (!fs.existsSync(rulesDir)) {
          fs.mkdirSync(rulesDir, { recursive: true });
        }
        const configPath = path.join(rulesDir, 'company-config.json');
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
        fs.writeFileSync(configPath, JSON.stringify(allConfig, null, 2), 'utf-8');
        restoredCounts.companyConfig = 1;
      }
    });

    return {
      success: true,
      message: 'Backup restored successfully',
      restoredCounts,
    };
  } catch (error) {
    const errMsg = error instanceof Error ? `${error.name}: ${error.message}` : 'Unknown error';
    logger.error('[BACKUP RESTORE ERROR]', { error: errMsg });
    return {
      success: false,
      message: `Restore failed. The database was rolled back to its previous state. Error: ${errMsg}`,
      restoredCounts: {},
    };
  }
}
