import { Prisma } from '@prisma/client';
import { logger } from '@/lib/logger';
import { db } from '@/lib/db';
import { createAuditLogWithRetry } from '@/lib/audit';
import { assertActiveFiscalPeriod } from '@/lib/fiscal-period-guard';
import { parseCSV } from '@/lib/csv-parser';
import { parseOFX } from '@/lib/ofx-parser';
import { parsePDFAsync } from '@/lib/pdf-processor';
import {
  validateAccountHolder,
  isStrictModeEnabled,
} from '@/lib/validation/account-holder-validator';
import { JournalEntryService } from '@/lib/services/journal-entry.service';
import {
  ValidationError,
  NotFoundError,
  ConflictError,
  BankAccountRequiredError,
  MathMismatchError,
  AppError,
} from '@/lib/api-error';
import { trackPDFParseDuration } from '@/lib/metrics';
import { withTiming } from '@/lib/timing';
import { generateImportHash } from '@/lib/accounting/import-hash';
import { toStatementMonth, toDateString } from '@/lib/accounting/date-window';
import type { ParsedTransaction, StatementBalanceInfo, RuleCondition } from '@/lib/types/shared';
import { resolveImportRule } from '@/lib/services/rule-precedence-import-resolver';
import type { ShadowImportSummary } from '@/lib/services/rule-precedence-shadow';
import {
  isRulePrecedenceShadowEnabled,
  toRulePrecedenceRule,
  runShadowComparison,
  accumulateShadowSummary,
  persistShadowSummaryBestEffort,
  createEmptyShadowImportSummary,
} from '@/lib/services/rule-precedence-shadow';
import { ShadowMetricsReader } from '@/lib/services/shadow-metrics-reader';
import type { ShadowMetricsQuery } from '@/lib/services/shadow-metrics-reader';
import { PrismaAuditLogRepository } from '@/lib/db/audit-log-repository';
import { isOperationalPolicyImportObservationEnabled, getEngineMode } from '@/lib/rule-engine/flag';
import type { EngineMode } from '@/lib/rule-engine/flag';
import { buildDivergenceEvent } from '@/lib/rule-engine/events';
import type { V2EngineResult, PrecedenceEngineResult, RuleEngineDivergenceEvent } from '@/lib/rule-engine/events';
import { runRuleEngineV2Shadow } from '@/lib/services/rule-engine-adapter';
import type { PrismaBankRule } from '@/lib/services/rule-engine-adapter';
import { evaluateOperationalPolicy } from '@/lib/operational-policy/policy-service';
import { IMPORT_OBSERVATION_CONFIG } from '@/lib/operational-policy/import-observation-config';
import type { PolicyObservationResponse, OperationalPolicyDecision } from '@/lib/operational-policy/types';
import { MemoryAdapter } from '@/memory/adapter';
import { createAdapter, lookupTreatment, matchAuthorizedPattern } from '@/memory/classification-knowledge';
import type { AuthorizedPatternMatch } from '@/memory/classification-knowledge';
import { resolveEntity } from '@/memory/entity-resolution';

export interface ImportResult {
  statementId: string;
  transactionCount: number;
  autoCategorizedCount: number;
  duplicatesSkipped: number;
  newAccountCreated: boolean;
  bankAccountName: string;
  policyObservation?: PolicyObservationResponse;
}

// ─── Import Decision (KE → Rule Engine) ──────────────────────────

export interface ImportDecision {
  source: 'ke' | 'rule_engine' | 'ke_error';
  glAccountId: string | null;
  matchedRuleId: string | null;
}

/**
 * Resolve import classification using single-memory architecture:
 * Entity Resolution → Treatment Lookup → Rule Engine fallback.
 *
 * Flow:
 *   1. resolveEntity(companyId, description) → KNOWN / UNKNOWN / ERROR
 *   2. If KNOWN: lookupTreatment(companyId, entityId) → FOUND / NOT_FOUND / ERROR
 *   3. FOUND → use KE treatment (glAccountId), skip rule engine
 *   4. NOT_FOUND → rule engine
 *   5. Any ERROR → ke_error (no rule engine, no AI)
 *   6. UNKNOWN → rule engine
 *
 * @param keAdapter — MemoryAdapter for KE lookup
 * @param companyId — Company scope
 * @param description — Transaction description to classify
 * @param resolveRule — Callback that runs the rule engine (only called on MISS/UNKNOWN)
 * @returns ImportDecision with source, glAccountId, and matchedRuleId
 */
export async function resolveImportDecision(
  keAdapter: MemoryAdapter,
  companyId: string,
  description: string,
  resolveRule: () => Promise<{ matchedRuleId: string | null; glAccountId: string | null }>,
): Promise<ImportDecision> {
  let matchedRuleId: string | null = null;
  let glAccountId: string | null = null;

  // Step 1: Entity Resolution
  let entityResolution;
  try {
    entityResolution = await resolveEntity(companyId, description);
  } catch (resolutionError) {
    logger.error('[KE] Entity resolution threw — not falling back to rule engine', {
      companyId,
      description,
      error: String(resolutionError),
    });
    return { source: 'ke_error', glAccountId: null, matchedRuleId: null };
  }

  // Step 2a: ERROR → ke_error (ambiguous identity)
  if (entityResolution.status === 'ERROR') {
    logger.error('[KE] Entity resolution error — not falling back to rule engine', {
      companyId,
      description,
      reason: entityResolution.reason,
    });
    return { source: 'ke_error', glAccountId: null, matchedRuleId: null };
  }

  // Step 2b: UNKNOWN → rule engine
  if (entityResolution.status === 'UNKNOWN') {
    const resolution = await resolveRule();
    return {
      source: 'rule_engine',
      glAccountId: resolution.glAccountId,
      matchedRuleId: resolution.matchedRuleId,
    };
  }

  // Step 3: KNOWN → Treatment Lookup
  let treatment;
  try {
    treatment = await lookupTreatment(keAdapter, companyId, entityResolution.entityId);
  } catch (treatmentError) {
    logger.error('[KE] Treatment lookup threw — not falling back to rule engine', {
      companyId,
      entityId: entityResolution.entityId,
      error: String(treatmentError),
    });
    return { source: 'ke_error', glAccountId: null, matchedRuleId: null };
  }

  // Step 4a: Treatment ERROR → ke_error (ambiguous treatment)
  if (treatment.status === 'ERROR') {
    logger.error('[KE] Treatment lookup error — not falling back to rule engine', {
      companyId,
      entityId: entityResolution.entityId,
      reason: treatment.reason,
    });
    return { source: 'ke_error', glAccountId: null, matchedRuleId: null };
  }

  // Step 4b: Treatment FOUND → use KE treatment.
  // KE-EVOL-003: authority depends on the stored treatment confidence.
  // certain/tentative → KE authoritative (tentative exact keeps authority,
  // per certified semantics). uncertain → the knowledge is questioned:
  // NO GL is assigned from KE and the exact treatment evidence is preserved
  // for traceability before the existing Rule Engine continues. A questioned
  // treatment is NEVER transformed into NOT_FOUND and NEVER into ke_error.
  if (treatment.status === 'FOUND') {
    if (treatment.confidence === 'uncertain') {
      logger.info('[KE] Exact treatment found with uncertain confidence — no KE authority; questioned treatment preserved for traceability; continuing to rule engine', {
        companyId,
        entityId: entityResolution.entityId,
        memoryItemId: treatment.memoryItemId,
        questionedGlAccountId: treatment.glAccountId,
        confidence: treatment.confidence,
      });
    } else {
      return {
        source: 'ke',
        glAccountId: treatment.glAccountId,
        matchedRuleId: null,
      };
    }
  }

  // Step 4c: Treatment NOT_FOUND → structural match of AUTHORIZED patterns
  // (GENERALIZACIÓN-005). The exact lookup keeps precedence; the structural
  // match is generalization OF the stored knowledge, not a replacement.
  // KE-EVOL-003: a FOUND-but-questioned exact treatment skips structural
  // matching entirely — the exact knowledge was found, not missing.
  if (treatment.status === 'NOT_FOUND') {
  let structural: AuthorizedPatternMatch;
  try {
    structural = await matchAuthorizedPattern(keAdapter, companyId, entityResolution.entityId, description, 'any');
  } catch (structuralError) {
    logger.error('[KE] Structural match threw — not falling back to rule engine', {
      companyId,
      entityId: entityResolution.entityId,
      error: String(structuralError),
    });
    return { source: 'ke_error', glAccountId: null, matchedRuleId: null };
  }
  // Step 4d-a: structural MATCH → use the authorized learned treatment.
  // No rule engine, no AI, no mutation of stored knowledge, no new
  // authorization — the match executes knowledge, it does not create it.
  // KE-EVOL-003: an uncertain structural match is NOT authority — the
  // questioned match metadata (authorizedPatternId, matchedPatternIds,
  // glAccountId, sourceCandidateId) is preserved for traceability and the
  // existing Rule Engine continues. It is never degraded to no_match.
  if (structural.kind === 'match') {
    if (structural.confidence === 'uncertain') {
      logger.info('[KE] Authorized structural pattern matched with uncertain confidence — no KE authority; questioned match preserved for traceability; continuing to rule engine', {
        companyId,
        entityId: entityResolution.entityId,
        authorizedPatternId: structural.authorizedPatternId,
        matchedPatternIds: structural.matchedPatternIds,
        questionedGlAccountId: structural.glAccountId,
        sourceCandidateId: structural.sourceCandidateId,
        confidence: structural.confidence,
      });
    } else {
      logger.info('[KE] Authorized structural pattern matched — using learned treatment', {
        companyId,
        entityId: entityResolution.entityId,
        authorizedPatternId: structural.authorizedPatternId,
        matchedPatternIds: structural.matchedPatternIds,
      });
      return {
        source: 'ke',
        glAccountId: structural.glAccountId,
        matchedRuleId: null,
      };
    }
  }

  // Step 4d-b: structural ERROR → ke_error (explicit, never silent NO_MATCH)
  if (structural.kind === 'error') {
    logger.error('[KE] Structural match error — not falling back silently', {
      companyId,
      entityId: entityResolution.entityId,
      reason: structural.reason,
    });
    return { source: 'ke_error', glAccountId: null, matchedRuleId: null };
  }

  // Step 4d-c: structural AMBIGUOUS → no KE decision is invented; the
  // multiple incompatible matches are logged and the existing explicit
  // resolution mechanism downstream of KE (rule engine) keeps control.
  if (structural.kind === 'ambiguous') {
    logger.warn('[KE] Structural match ambiguous — no KE decision; continuing to rule engine', {
      companyId,
      entityId: entityResolution.entityId,
      matchedPatternIds: structural.matchedPatternIds,
    });
  }

  // Step 4d-d / NO_MATCH / AMBIGUOUS: legacy continuation — rule engine
  const resolution = await resolveRule();
  return {
    source: 'rule_engine',
    glAccountId: resolution.glAccountId,
    matchedRuleId: resolution.matchedRuleId,
  };
  }

  // Step 4d-d (uncertain exact treatment): legacy continuation — rule engine
  const resolutionExactlyQuestioned = await resolveRule();
  return {
    source: 'rule_engine',
    glAccountId: resolutionExactlyQuestioned.glAccountId,
    matchedRuleId: resolutionExactlyQuestioned.matchedRuleId,
  };
}

interface BuildV2ShadowDivergenceEventParams {
  transactionId: string;
  companyId: string;
  productiveMode: EngineMode;
  productiveMatchedRuleId: string | null;
  v2Txn: {
    id: string;
    date: Date;
    description: string;
    amount: number;
    bankAccountId: string;
    reference?: string;
  };
  bankRules: PrismaBankRule[];
  precedenceResult: PrecedenceEngineResult;
}

function buildV2ShadowDivergenceEvent(params: BuildV2ShadowDivergenceEventParams): RuleEngineDivergenceEvent | null {
  const { transactionId, companyId, productiveMode, productiveMatchedRuleId } = params;

  let v2Result: V2EngineResult;
  if (productiveMode === 'v2') {
    // V2 is productive: reuse the real productive result — no second execution.
    v2Result = {
      outcome: productiveMatchedRuleId ? 'matched' : 'pending',
      matchedRuleId: productiveMatchedRuleId ?? undefined,
    };
  } else {
    try {
      const match = runRuleEngineV2Shadow(
        params.v2Txn,
        params.bankRules,
        { status: 'not_run' },
        companyId,
      );
      if (match.outcome === 'matched') {
        v2Result = { outcome: 'matched', matchedRuleId: match.matchedRuleId };
      } else if (match.outcome === 'pending') {
        v2Result = { outcome: 'pending', errorCode: match.errorCode };
      } else {
        v2Result = { outcome: 'pending' };
      }
    } catch (error) {
      logger.error('[RULE ENGINE V2 SHADOW ERROR]', {
        error: String(error),
        companyId,
        transactionId,
      });
      v2Result = { outcome: 'pending', errorCode: 'v2_shadow_evaluation_error' };
    }
  }

  return buildDivergenceEvent(transactionId, companyId, v2Result, params.precedenceResult);
}

export class ImportService {
  static async importFile({
    companyId,
    bankAccountId,
    fileName,
    extension,
    buffer,
    content,
    userId,
    bypassHolderValidation = false,
  }: {
    companyId: string;
    bankAccountId: string | null;
    fileName: string;
    extension: string;
    buffer: Buffer;
    content: string;
    userId: string;
    bypassHolderValidation?: boolean;
  }): Promise<ImportResult> {
    // ─── PDF parsing ──────────────────────────────────────────────────
    if (extension === 'pdf') {
      let transactions: ParsedTransaction[] = [];
      let bankName = '';
      let accountNo: string | undefined;
      let openingBalance: number | undefined;
      let closingBalance: number | undefined;
      let startDate: Date | undefined;
      let endDate: Date | undefined;
      let accountHolder: string | undefined;

      try {
        const pdfStart = performance.now();
        logger.info('Starting PDF parse', { fileName });
        const parsed = await parsePDFAsync(buffer, { fileName, companyId, userId });
        trackPDFParseDuration(fileName, performance.now() - pdfStart);
        logger.info('PDF parsed', {
          fileName,
          durationSec: Number(((performance.now() - pdfStart) / 1000).toFixed(1)),
          transactionCount: parsed.transactions.length,
        });

        if (parsed.mathValid === false) {
          logger.warn('Math mismatch — saving with warning for manual review', {
            mismatch: parsed.mismatch,
          });
        }

        transactions = parsed.transactions;
        bankName = parsed.bankName || this.extractBankNameFromFilename(fileName);
        accountNo = parsed.accountNo;
        openingBalance = parsed.openingBalance;
        closingBalance = parsed.closingBalance;
        startDate = parsed.startDate;
        endDate = parsed.endDate;
        accountHolder = parsed.accountHolder;
      } catch (parseError) {
        if (parseError instanceof MathMismatchError) {
          throw parseError;
        }
        throw new ValidationError(
          parseError instanceof Error ? parseError.message : 'Error al parsear el archivo PDF',
        );
      }

      // Pre-validation of account holder name
      const company = await db.company.findUnique({
        where: { id: companyId },
        select: { legalName: true, entityType: true },
      });

      let holderDecision: 'auto_approved' | 'user_approved' | 'rejected' = 'auto_approved';
      let similarityScore = 1.0;

      if (bypassHolderValidation) {
        logger.info('Account holder validation skipped (bypass flag)', {
          extractedHolder: accountHolder,
          legalName: company?.legalName,
        });
      } else if (company && accountHolder) {
        const entityType = (company.entityType ?? 'BUSINESS') as 'INDIVIDUAL' | 'BUSINESS';
        const validation = validateAccountHolder(accountHolder, company.legalName, entityType);
        similarityScore = validation.score;

        if (validation.requiresApproval) {
          logger.warn('Account holder mismatch — saving with warning', {
            extractedHolder: accountHolder,
            legalName: company.legalName,
            entityType,
            score: validation.score,
            method: validation.method,
          });
          holderDecision = validation.score > 0.3 ? 'user_approved' : 'rejected';
          if (holderDecision === 'rejected') {
            throw new ValidationError(
              `EL_TITULAR_NO_COINCIDE:${accountHolder}:${company.legalName}:${Math.round(validation.score * 100)}`,
            );
          }
        }
      }

      // Guard: validate before touching the DB — no phantom accounts on failed imports
      if (transactions.length === 0) {
        throw new ValidationError('No hay transacciones para importar');
      }

      logger.info('Looking up bank account', { bankName, accountNo: accountNo || null });
      const { account: bankAccount, newAccountCreated: pdfNewAccount } =
        await this.findOrCreateBankAccount(
          companyId,
          bankAccountId,
          bankName,
          transactions,
          accountNo,
          openingBalance || 0,
        );
      logger.info('Bank account resolved', {
        accountName: bankAccount.accountName,
        accountId: bankAccount.id,
      });

      const balanceInfo: Partial<StatementBalanceInfo> = {};
      if (startDate) balanceInfo.startDate = startDate;
      if (endDate) balanceInfo.endDate = endDate;
      if (openingBalance !== undefined) balanceInfo.openingBalance = openingBalance;
      if (closingBalance !== undefined) balanceInfo.closingBalance = closingBalance;

      logger.info('Saving transactions to database', { count: transactions.length });
      const result = await this.importTransactions(
        companyId,
        bankAccount.id,
        bankAccount.glAccountId,
        transactions,
        'pdf',
        fileName,
        balanceInfo,
        userId,
      );
      logger.info('Import done', {
        saved: result.transactionCount,
        duplicatesSkipped: result.duplicatesSkipped,
      });

      // Create Audit Log for holder validation
      if (userId && accountHolder && company) {
        await createAuditLogWithRetry({
          companyId,
          userId,
          action:
            holderDecision === 'auto_approved'
              ? 'HOLDER_VALIDATION_AUTO_APPROVED'
              : 'HOLDER_VALIDATION_USER_APPROVED',
          entity: 'BankStatement',
          entityId: result.statementId,
          details: JSON.stringify({
            fileName,
            companyLegalName: company.legalName,
            extractedHolderName: accountHolder,
            similarityScore: Math.round(similarityScore * 100) / 100,
            decision: holderDecision,
          }),
        }).catch(() => {});
      }

      return {
        ...result,
        newAccountCreated: pdfNewAccount,
        bankAccountName: bankAccount.accountName,
      };
    }

    // ─── CSV parsing ─────────────────────────────────────────────────
    if (extension === 'csv' || extension === 'tsv' || extension === 'txt') {
      let transactions: ParsedTransaction[];
      let bankName = '';

      try {
        transactions = parseCSV(content);
        bankName = this.extractBankNameFromFilename(fileName);
      } catch (parseError) {
        throw new ValidationError(
          parseError instanceof Error ? parseError.message : 'Error al parsear el archivo CSV',
        );
      }

      const { account: bankAccount, newAccountCreated: csvNewAccount } =
        await this.findOrCreateBankAccount(companyId, bankAccountId, bankName, transactions);

      const result = await this.importTransactions(
        companyId,
        bankAccount.id,
        bankAccount.glAccountId,
        transactions,
        'csv',
        fileName,
        undefined,
        userId,
      );

      return {
        ...result,
        newAccountCreated: csvNewAccount,
        bankAccountName: bankAccount.accountName,
      };
    }

    // ─── OFX/QFX parsing ─────────────────────────────────────────────
    if (extension === 'ofx' || extension === 'qfx') {
      let parsed: { bankName: string; transactions: ParsedTransaction[]; accountNumber?: string; openingBalance?: number; closingBalance?: number; startDate?: Date; endDate?: Date };

      try {
        parsed = parseOFX(content);
      } catch (parseError) {
        throw new ValidationError(
          parseError instanceof Error ? parseError.message : 'Error al parsear el archivo OFX/QFX',
        );
      }

      const bankName = parsed.bankName;

      const { account: bankAccount, newAccountCreated: ofxNewAccount } =
        await this.findOrCreateBankAccount(
          companyId,
          bankAccountId,
          bankName,
          parsed.transactions,
          parsed.accountNumber,
          parsed.openingBalance || 0,
        );

      const result = await this.importTransactions(
        companyId,
        bankAccount.id,
        bankAccount.glAccountId,
        parsed.transactions,
        extension as 'ofx' | 'qfx',
        fileName,
        {
          startDate: parsed.startDate,
          endDate: parsed.endDate,
          openingBalance: parsed.openingBalance,
          closingBalance: parsed.closingBalance,
        },
        userId,
      );

      return {
        ...result,
        newAccountCreated: ofxNewAccount,
        bankAccountName: bankAccount.accountName,
      };
    }

    throw new ValidationError(
      `Formato de archivo no soportado: .${extension}. Los formatos soportados son: .csv, .ofx, .qfx, .pdf`,
    );
  }

  private static async findOrCreateBankAccount(
    companyId: string,
    bankAccountId: string | null,
    bankName: string,
    transactions: { description: string; amount: number }[],
    accountNumber?: string,
    openingBalance: number = 0,
    currency: string = 'USD',
  ): Promise<{ account: { id: string; accountName: string; accountNo?: string | null; bankName: string; companyId: string; glAccountId: string }; newAccountCreated: boolean }> {
    if (bankAccountId) {
      const account = await db.bankAccount.findFirst({
        where: { id: bankAccountId, companyId },
      });
      if (!account) {
        throw new NotFoundError('La cuenta bancaria especificada no existe');
      }
      return { account, newAccountCreated: false };
    }

    // Resolution precedence: explicit bankAccountId > accountNumber > bankName.
    // accountNumber MUST be attempted BEFORE bankName: a company may hold
    // several accounts at the same institution, so matching by bank name
    // first would silently attach every statement to whichever account
    // happened to be returned first. bankName remains the fallback for
    // statements that carry no resolvable account number.
    if (accountNumber) {
      const existing = await db.bankAccount.findFirst({
        where: { companyId, accountNo: accountNumber, isActive: true },
      });
      if (existing) return { account: existing, newAccountCreated: false };
    }

    if (bankName) {
      const existing = await db.bankAccount.findFirst({
        where: { companyId, bankName, isActive: true },
      });
      if (existing) return { account: existing, newAccountCreated: false };
    }

    // Si no existe, lanzamos un error que pre-rellenará el modal de creación
    throw new BankAccountRequiredError({
      bankName: bankName || 'Cuenta Bancaria Importada',
      accountNo: accountNumber || null,
      openingBalance,
      currency,
    });
  }

  private static async importTransactions(
    companyId: string,
    bankAccountId: string,
    bankGlAccountId: string,
    transactions: { date: Date; description: string; amount: number; reference?: string }[],
    format: string,
    fileName: string,
    balanceInfo: Partial<StatementBalanceInfo> | undefined,
    userId: string,
  ) {
    if (transactions.length === 0) {
      throw new ValidationError('No hay transacciones para importar');
    }

    const sorted = [...transactions].sort((a, b) => a.date.getTime() - b.date.getTime());

    const startDate = balanceInfo?.startDate || sorted[0]!.date;
    const endDate = balanceInfo?.endDate || sorted[sorted.length - 1]!.date;
    const openingBalance = balanceInfo?.openingBalance ?? 0;
    const closingBalance = balanceInfo?.closingBalance ?? 0;

    const bankAccount = await db.bankAccount.findFirst({
      where: { id: bankAccountId },
      select: { accountNo: true },
    });
    const accountNumber = bankAccount?.accountNo || 'unknown';
    const statementMonth = toStatementMonth(startDate);

    // ─── Deduplicación por importHash (SHA-256) ───────────────────────
    // Detecta reimportaciones del mismo extracto sin cargar todo en memoria.
    const hashList = sorted.map((txn) =>
      generateImportHash({
        companyId,
        accountNumber,
        statementMonth,
        txDate: toDateString(txn.date),
        amount: txn.amount,
        description: txn.description,
      }),
    );

    const existingHashes = await db.bankTransaction.findMany({
      where: { importHash: { in: hashList } },
      select: { importHash: true },
    });
    const existingHashSet = new Set(existingHashes.map((t) => t.importHash));

    const uniqueTransactions = sorted.filter((_txn, idx) => !existingHashSet.has(hashList[idx]!));
    const uniqueHashes = hashList.filter((_, idx) => !existingHashSet.has(hashList[idx]!));

    const duplicatesSkipped = sorted.length - uniqueTransactions.length;

    if (uniqueTransactions.length === 0) {
      return {
        statementId: '',
        transactionCount: 0,
        autoCategorizedCount: 0,
        duplicatesSkipped,
      };
    }

    const totalCredits = uniqueTransactions
      .filter((t) => t.amount > 0)
      .reduce((s, t) => s.add(new Prisma.Decimal(t.amount)), new Prisma.Decimal(0))
      .toNumber();
    const totalDebits = uniqueTransactions
      .filter((t) => t.amount < 0)
      .reduce((s, t) => s.add(new Prisma.Decimal(t.amount).abs()), new Prisma.Decimal(0))
      .toNumber();

    const bankRules = await db.bankRule.findMany({
      where: { companyId, isActive: true },
      orderBy: { priority: 'asc' },
      include: {
        glAccount: { select: { id: true } },
        debitGlAccount: { select: { id: true } },
        creditGlAccount: { select: { id: true } },
      },
    });

    const shadowEnabled = isRulePrecedenceShadowEnabled();
    const shadowRules = shadowEnabled ? bankRules.map((r) => toRulePrecedenceRule(r)) : [];
    let shadowSummary: ShadowImportSummary | null = null;

    const result = await db.$transaction(async (tx) => {
      // Duplicate check inside TX (atomic — prevents race conditions)
      const existingStatement = await tx.bankStatement.findFirst({
        where: { bankAccountId, startDate, endDate },
      });
      if (existingStatement) {
        throw new ConflictError(
          `Ya existe un extracto para el período ${startDate.toISOString().split('T')[0]} – ${endDate.toISOString().split('T')[0]}. Elimine el anterior o use un período diferente.`,
        );
      }

      const statement = await tx.bankStatement.create({
        data: {
          companyId,
          bankAccountId,
          startDate,
          endDate,
          openingBalance,
          closingBalance: closingBalance || openingBalance + totalCredits - totalDebits,
          totalCredits,
          totalDebits,
          format,
          fileName,
        },
      });

      let autoCategorizedCount = 0;
      const transactionsToInsert: Prisma.BankTransactionCreateManyInput[] = [];

      if (shadowEnabled) {
        shadowSummary = createEmptyShadowImportSummary();
      }

      // Knowledge Engine adapter — created once per import, reused across transactions
      const keAdapter = createAdapter(db, (fn) => db.$transaction(fn));

      for (let idx = 0; idx < uniqueTransactions.length; idx++) {
        const txn = uniqueTransactions[idx]!;

        // ─── KE → Rule Engine decision (productive function) ──────
        const decision = await resolveImportDecision(
          keAdapter,
          companyId,
          txn.description,
          async () => {
            const resolution = await resolveImportRule(
              {
                id: uniqueHashes[idx]!,
                date: txn.date,
                description: txn.description,
                amount: txn.amount,
                bankAccountId,
                reference: txn.reference,
              },
              bankRules,
              companyId,
            );

            // Persist AI proposal from adapter (if present)
            if (resolution.aiProposal) {
              await tx.pendingApproval.create({
                data: {
                  action: 'ai_classification_proposal',
                  payload: {
                    companyId,
                    transactionId: uniqueHashes[idx]!,
                    bankAccountId,
                    deterministicResult: resolution.deterministicResult,
                    aiProposal: resolution.aiProposal,
                    proposedEntity: resolution.aiProposal.proposedEntity ?? null,
                  },
                  requestedBy: userId,
                  status: 'pending',
                },
              });
            }

            return resolution;
          },
        );

        const matchedRuleId = decision.matchedRuleId;
        const glAccountId = decision.glAccountId;

        // KE_ERROR: explicit failure — rollback entire import, do NOT persist unclassified transaction
        if (decision.source === 'ke_error') {
          throw new AppError(
            500,
            `KE_ERROR: Knowledge Engine failed for transaction "${txn.description}". Import rolled back.`,
            'KE_ERROR',
          );
        }

        if (matchedRuleId) autoCategorizedCount++;

        if (shadowEnabled && shadowSummary) {
          const execResult = runShadowComparison(
            {
              id: uniqueHashes[idx],
              date: txn.date,
              description: txn.description,
              amount: txn.amount,
              bankAccountId,
              companyId,
            },
            shadowRules,
            matchedRuleId,
            { companyId, transactionId: uniqueHashes[idx] },
          );
          shadowSummary = accumulateShadowSummary(shadowSummary, execResult);

          if (execResult.ok) {
            const divergenceEvent = buildV2ShadowDivergenceEvent({
              transactionId: uniqueHashes[idx]!,
              companyId,
              productiveMode: getEngineMode(),
              productiveMatchedRuleId: matchedRuleId,
              v2Txn: {
                id: uniqueHashes[idx]!,
                date: txn.date,
                description: txn.description,
                amount: txn.amount,
                bankAccountId,
                reference: txn.reference,
              },
              bankRules: bankRules as PrismaBankRule[],
              precedenceResult: {
                reason: execResult.comparison.canonicalReason,
                winnerRuleId: execResult.comparison.canonicalWinnerId,
                ambiguous: execResult.comparison.canonicalAmbiguous,
              },
            });
            if (divergenceEvent) {
              logger.warn('[RULE ENGINE V2 DIVERGENCE]', { event: divergenceEvent });
            }
          }
        }

        transactionsToInsert.push({
          statementId: statement.id,
          date: txn.date,
          description: txn.description,
          amount: txn.amount,
          reference: txn.reference || null,
          isReconciled: false,
          glAccountId: glAccountId || null,
          matchedRuleId: matchedRuleId || null,
          importHash: uniqueHashes[idx], // SHA-256 para idempotencia
        });
      }

      await tx.bankTransaction.createMany({
        data: transactionsToInsert,
      });

      // Create journal entries for transactions with auto-assigned GL accounts
      const createdTxs = await tx.bankTransaction.findMany({
        where: { statementId: statement.id, glAccountId: { not: null }, journalEntryId: null },
        select: { id: true, date: true, amount: true, description: true, glAccountId: true },
      });
      const affectedGlAccountIds = new Set<string>();
      for (const bt of createdTxs) {
        // A transaction falling in a locked/closed fiscal period must not be
        // posted. Abort the whole import (the $transaction rolls back).
        await assertActiveFiscalPeriod(companyId, bt.date, tx as any);

        await JournalEntryService.createFromBankTransaction(tx as any, {
          bankTxId: bt.id,
          bankTxDate: bt.date,
          bankTxAmount: Number(bt.amount),
          bankTxDescription: bt.description,
          bankGlAccountId,
          counterpartyGlAccountId: bt.glAccountId!,
          companyId,
          skipRecalculate: true,
        });
        affectedGlAccountIds.add(bankGlAccountId);
        affectedGlAccountIds.add(bt.glAccountId!);
      }
      for (const glAccountId of affectedGlAccountIds) {
        await JournalEntryService.recalculateBalance(tx as any, glAccountId);
      }

       
      await ImportService.recalculateBalances(tx as any, bankAccountId);

      return { statementId: statement.id, autoCategorizedCount };
    });

    // ─── Persistir resumen shadow post-commit ──────────────────────
    if (shadowSummary) {
      await persistShadowSummaryBestEffort({
        companyId,
        userId,
        statementId: result.statementId,
        summary: shadowSummary,
      });
    }

    // ─── S7-09: Operational Policy Observation (best-effort, inline) ───
    let policyObservation: PolicyObservationResponse | undefined;

    if (isOperationalPolicyImportObservationEnabled() && shadowSummary) {
      try {
        const provider = new ShadowMetricsReader(
          new PrismaAuditLogRepository(db),
        );
        const metricsWindow = buildObservationWindow(
          new Date(),
          IMPORT_OBSERVATION_CONFIG.windowDays,
        );

        const metricsQuery: ShadowMetricsQuery = {
          ...IMPORT_OBSERVATION_CONFIG.metricsQueryTemplate,
          companyId,
          from: metricsWindow.from,
          to: metricsWindow.to,
        };

        const decision = await evaluateOperationalPolicy(
          { context: 'IMPORT' as const, metricsQuery },
          IMPORT_OBSERVATION_CONFIG.criteria,
          provider,
          IMPORT_OBSERVATION_CONFIG.profile,
        );

        policyObservation = { status: 'AVAILABLE', decision };

        await persistImportPolicyObservation({
          companyId,
          entityId: result.statementId,
          decision,
          metricsWindow,
        });
      } catch (error) {
        policyObservation = {
          status: 'UNAVAILABLE',
          errorCode: classifyImportPolicyObservationError(error),
        };
      }
    }

    return {
      statementId: result.statementId,
      transactionCount: uniqueTransactions.length,
      autoCategorizedCount: result.autoCategorizedCount,
      duplicatesSkipped,
      ...(policyObservation !== undefined && { policyObservation }),
    };
  }

  private static extractBankNameFromFilename(fileName: string): string {
    const base = fileName.replace(/\.[^.]+$/, '');
    const parts = base.split(/[-_\s]+/).filter(Boolean);

    const bankKeywords = [
      'chase',
      'bank',
      'wells',
      'fargo',
      'citi',
      'america',
      'bofa',
      'hsbc',
      'paypal',
      'venmo',
      'cashapp',
    ];

    const matchingParts = parts.filter((p) =>
      bankKeywords.some((kw) => p.toLowerCase().includes(kw)),
    );

    if (matchingParts.length > 0) {
      return matchingParts
        .map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
        .join(' ');
    }

    if (parts.length > 0 && parts[0]!.length > 2) {
      return parts[0]!.charAt(0).toUpperCase() + parts[0]!.slice(1).toLowerCase();
    }

    return 'Cuenta Bancaria Importada';
  }

  public static async recalculateBalances(tx: Prisma.TransactionClient, bankAccountId: string) {
    const statements = await tx.bankStatement.findMany({
      where: { bankAccountId },
      orderBy: [{ startDate: 'asc' }, { endDate: 'asc' }],
    });

    if (statements.length === 0) return;

    const oldest = statements[0];
    const newest = statements[statements.length - 1];

    await tx.bankAccount.update({
      where: { id: bankAccountId },
      data: {
        initialBalance: oldest!.openingBalance,
        balance: newest!.closingBalance,
      },
    });
  }

}

// ─── S7-09 Helpers ──────────────────────────────────────────

function buildObservationWindow(
  now: Date,
  windowDays: number,
): { from: Date; to: Date } {
  const from = new Date(now);
  from.setDate(from.getDate() - windowDays);
  from.setUTCHours(0, 0, 0, 0);

  const to = new Date(now);
  to.setUTCHours(23, 59, 59, 999);

  return { from, to };
}

function classifyImportPolicyObservationError(error: unknown): string {
  if (error instanceof ValidationError) {
    return 'POLICY_VALIDATION_ERROR';
  }
  if (error instanceof AppError) {
    return 'POLICY_PROVIDER_ERROR';
  }
  return 'POLICY_INTERNAL_ERROR';
}

async function persistImportPolicyObservation(params: {
  companyId: string;
  entityId: string;
  decision: OperationalPolicyDecision;
  metricsWindow: { from: Date; to: Date };
}): Promise<void> {
  const { companyId, entityId, decision, metricsWindow } = params;
  const payload = {
    policySchemaVersion: 1,
    context: 'IMPORT',
    profileId: decision.profileId,
    profileVersion: decision.profileVersion,
    action: decision.action,
    reasonCode: decision.reasons.reasonCode,
    readinessStatus: decision.readiness.status,
    metricsWindow: {
      from: metricsWindow.from.toISOString(),
      to: metricsWindow.to.toISOString(),
      source: 'IMPORT',
      trustPolicy: IMPORT_OBSERVATION_CONFIG.metricsQueryTemplate.trustPolicy,
    },
  };

  try {
    await db.auditLog.create({
      data: {
        companyId,
        action: 'OPERATIONAL_POLICY_OBSERVATION',
        entity: 'BankStatement',
        entityId,
        details: JSON.stringify(payload),
      },
    });
  } catch {
    // Best-effort: failure does NOT degrade AVAILABLE (I8)
  }
}
