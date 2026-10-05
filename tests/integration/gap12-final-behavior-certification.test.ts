// GAP12 — Final behavior certification orchestrator (SELECTED_OPTION=OPTION_A).
//
// Single-file certification suite proving the property "the system thinks
// more and the user does less" end to end. It drives REAL production paths
// against the real test database:
//
//   ImportService.importFile            (classification decisions)
//   reclassifyTransaction               (human intervention + KE learning)
//   decideAiProposal                    (gated AI proposal acceptance)
//   rollbackAutomationDecision          (rollback of automated decisions)
//   resolveDecisionExplanation          (5-source explanation transport)
//   GET /api/transactions/[id]/explanation (RBAC + entitlement boundary)
//
// Nothing in src/ is mocked. The ONLY instrumentation in this file is the
// observational passthrough call-count wrapper around CSV layout discovery
// (certified pattern from tests/services/csv-reusable-layout-e2e.test.ts):
// every call still executes the real implementation; nothing about
// behavior is substituted.
//
// C2 longitudinal proof (PASO 4): harness intervention counters count REAL
// mutating actions executed by this harness (manual classification,
// correction, proposal decision). Reads/verifications never count. The
// counter alone is never treated as evidence: every learned occurrence is
// additionally correlated with persisted side effects (FINAL_DECISION_SOURCE
// trace, GL assignment, knowledge claim, CompanyKnowledge alias).
//
// Journeys covered: J1->J2, J3->J4, J5, J6, J7->J8, J9, J10 (5 sources),
// J11 (tenant isolation), J12 (decreasing intervention, K >= 3 patterns),
// plus an explicit SAFETY block for the PASO 6 guard properties.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { ImportService } from '@/lib/services/import.service';
import { reclassifyTransaction } from '@/lib/services/transaction-reclassification.service';
import { decideAiProposal } from '@/lib/services/ai-proposal-approval.service';
import { rollbackAutomationDecision } from '@/lib/rollback-automation';
import { resolveDecisionExplanation } from '@/lib/get-decision-explanation';
import { resolveEntity } from '@/memory/entity-resolution';
import {
  csvLayoutFingerprint,
  inspectCsvLayout,
  discoverCsvMapping,
  inferCsvMappingFromContent,
} from '@/lib/csv-parser';
import { createSession } from '@/lib/sessions';
import { requestContext } from '@/lib/context-storage';
import { GET as explainGET } from '../../src/app/api/transactions/[id]/explanation/route';
import {
  createTestUser,
  createTestCompany,
  createTestCompanyMember,
  createTestGlAccount,
  createTestBankAccount,
  createTestBankStatement,
  clearDatabase,
} from '../helpers/factories';

// ─── Observational call-count wrapper (real implementations, passthrough) ───

vi.mock('@/lib/csv-parser', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/csv-parser')>();
  return {
    ...actual,
    discoverCsvMapping: vi.fn(actual.discoverCsvMapping),
    inferCsvMappingFromContent: vi.fn(actual.inferCsvMappingFromContent),
  };
});
const discoverySpy = vi.mocked(discoverCsvMapping);
const inferenceSpy = vi.mocked(inferCsvMappingFromContent);

// ─── Shared certification state (journeys are sequential by design) ─────────

const ACTION = 'FINAL_DECISION_SOURCE';

type PatternKey = 'P1' | 'P2' | 'P3';
const c2: Record<PatternKey, { first: number; learned: number }> = {
  P1: { first: 0, learned: 0 },
  P2: { first: 0, learned: 0 },
  P3: { first: 0, learned: 0 },
};

interface Tenant {
  userId: string;
  companyId: string;
  token: string;
}

let A: Tenant; // certification tenant (all journeys)
let B: Tenant; // second tenant (J11 isolation)
let C: Tenant; // tenant WITHOUT banking entitlement (SAFETY)
let viewerToken = '';
let outsiderToken = '';

let glBank = ''; // 1000 bank
let glExpense = ''; // 6100 manual/KE target
let glFixed = ''; // 6200 correction + rollback target
let glRule = ''; // 6300 rule target (P2, J9)
let glSafe = ''; // 6400 safe-rule target (J5)
let bankId = '';
let factoryStatementId = '';

let ruleP2Id = '';
let ruleJ5Id = '';
let ruleJ9Id = '';

let u = ''; // uniqueness suffix (tenant-scoped)
let D_P1 = '';
let D_P2 = '';
let D_P3 = '';
let D_J5 = '';
let D_J6 = '';
let D_J9 = '';
let D_J10 = '';
let D_J7A = '';
let D_J7B = '';
let D_J7C = '';
let CSV_J7_1 = '';
let CSV_J7_2 = '';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function row(date: string, description: string, amount: number): string {
  return `${date},${description},${amount.toFixed(2)}\n`;
}

/**
 * Reproduce the production execution context: apiHandler runs every route
 * handler inside requestContext.run({ userId, companyId }), and the knowledge
 * audit trail (appendAuditEntry → requireCurrentUserId) requires that
 * AsyncLocalStorage store. Service calls invoked directly by this harness
 * must run under the same ambient context — same as in production.
 */
function asTenant<T>(
  tenant: { userId: string; companyId: string },
  fn: () => Promise<T>,
): Promise<T> {
  return requestContext.run({ userId: tenant.userId, companyId: tenant.companyId }, fn);
}

async function importCsv(fileName: string, rows: string[]): Promise<{ transactionCount: number }> {
  const content = `Date,Description,Amount\n${rows.join('')}`;
  return asTenant(A, () =>
    ImportService.importFile({
      companyId: A.companyId,
      bankAccountId: bankId,
      fileName,
      extension: 'csv',
      buffer: Buffer.from(content),
      content,
      userId: A.userId,
      bypassHolderValidation: true,
    }),
  );
}

async function importRaw(fileName: string, content: string): Promise<{ transactionCount: number }> {
  return asTenant(A, () =>
    ImportService.importFile({
      companyId: A.companyId,
      bankAccountId: bankId,
      fileName,
      extension: 'csv',
      buffer: Buffer.from(content),
      content,
      userId: A.userId,
      bypassHolderValidation: true,
    }),
  );
}

// Amounts are globally unique per occurrence, so description+amount is a
// stable selector independent of date parsing timezone semantics.
async function findTx(description: string, amount: number) {
  const tx = await db.bankTransaction.findFirst({
    where: { description, amount, statement: { bankAccountId: bankId } },
  });
  if (!tx) {
    throw new Error(`GAP12_CERT: transaction not found — ${description} @ ${amount}`);
  }
  return tx;
}

async function traces(entityId: string) {
  return db.auditLog.findMany({
    where: {
      companyId: A.companyId,
      action: ACTION,
      entity: 'BankTransaction',
      entityId,
    },
    orderBy: { createdAt: 'asc' },
  });
}

function traceDetails(row: { details: string | null } | null | undefined) {
  return JSON.parse(row?.details ?? '{}') as Record<string, string>;
}

async function latestExplanationSource(transactionId: string): Promise<string | null> {
  const explanation = await resolveDecisionExplanation(A.companyId, transactionId);
  return explanation?.source ?? null;
}

// ─── Setup ───────────────────────────────────────────────────────────────────

beforeAll(async () => {
  await clearDatabase();

  // Tenant A — the certification tenant.
  const userA = await createTestUser('gap12-a@example.com');
  const companyA = await createTestCompany('Gap12 Cert Co');
  await createTestCompanyMember(userA.id, companyA.id);
  const tokenA = await createSession(userA.id);
  u = companyA.id.slice(-6);
  A = { userId: userA.id, companyId: companyA.id, token: tokenA };

  // Tenant B — isolation subject.
  const userB = await createTestUser('gap12-b@example.com');
  const companyB = await createTestCompany('Gap12 Other Co');
  await createTestCompanyMember(userB.id, companyB.id);
  const tokenB = await createSession(userB.id);
  B = { userId: userB.id, companyId: companyB.id, token: tokenB };

  // Tenant C — no banking entitlement (guards must reject with MODULE_*).
  const userC = await createTestUser('gap12-c@example.com');
  const companyC = await createTestCompany('Gap12 NoEnt Co', 'BUSINESS', {
    seedEntitlements: false,
  });
  await createTestCompanyMember(userC.id, companyC.id);
  const tokenC = await createSession(userC.id);
  C = { userId: userC.id, companyId: companyC.id, token: tokenC };

  // Viewer (role outside ['company_admin','employee']) and outsider
  // (no membership at all) — RBAC negatives for the explanation route.
  const viewer = await createTestUser('gap12-viewer@example.com');
  await db.companyMember.create({
    data: { userId: viewer.id, companyId: companyA.id, role: 'viewer' },
  });
  viewerToken = await createSession(viewer.id);

  const outsider = await createTestUser('gap12-outsider@example.com');
  outsiderToken = await createSession(outsider.id);

  // GL accounts + bank account.
  const bankGl = await createTestGlAccount({
    companyId: companyA.id,
    code: '1000',
    name: 'Bank',
  });
  const expenseGl = await createTestGlAccount({
    companyId: companyA.id,
    code: '6100',
    name: 'Expense',
    accountType: 'expense',
  });
  const fixedGl = await createTestGlAccount({
    companyId: companyA.id,
    code: '6200',
    name: 'Corrected Expense',
    accountType: 'expense',
  });
  const ruleGl = await createTestGlAccount({
    companyId: companyA.id,
    code: '6300',
    name: 'Rule Expense',
    accountType: 'expense',
  });
  const safeGl = await createTestGlAccount({
    companyId: companyA.id,
    code: '6400',
    name: 'Safe Rule Expense',
    accountType: 'expense',
  });
  glBank = bankGl.id;
  glExpense = expenseGl.id;
  glFixed = fixedGl.id;
  glRule = ruleGl.id;
  glSafe = safeGl.id;

  const bank = await createTestBankAccount(companyA.id, glBank);
  bankId = bank.id;

  // Factory statement for non-import transactions (J10 AI + no-trace control).
  const factoryStatement = await createTestBankStatement(companyA.id, bankId);
  factoryStatementId = factoryStatement.id;

  // Rules (real BankRule rows, resolved by the real rule engine).
  const ruleP2 = await db.bankRule.create({
    data: {
      companyId: companyA.id,
      name: 'gap12-beta-rule',
      conditionType: 'contains',
      conditionValue: 'GAP12 BETA',
      glAccountId: glRule,
      priority: 10,
      isActive: true,
    },
  });
  const ruleJ5 = await db.bankRule.create({
    data: {
      companyId: companyA.id,
      name: 'gap12-j5-safe',
      conditionType: 'contains',
      conditionValue: 'GAP12 J5SAFE',
      glAccountId: glSafe,
      priority: 20,
      isActive: true,
    },
  });
  const ruleJ9 = await db.bankRule.create({
    data: {
      companyId: companyA.id,
      name: 'gap12-rollback-rule',
      conditionType: 'contains',
      conditionValue: 'GAP12 ROLLBACK',
      glAccountId: glRule,
      priority: 30,
      isActive: true,
    },
  });
  ruleP2Id = ruleP2.id;
  ruleJ5Id = ruleJ5.id;
  ruleJ9Id = ruleJ9.id;

  // Descriptions (tenant-unique suffix; each rule token appears ONLY in its
  // own journey's description, never in another journey's).
  D_P1 = `GAP12 P1 VENDOR ${u}`;
  D_P2 = `GAP12 BETA P2 VENDOR ${u}`;
  D_P3 = `GAP12 P3 VENDOR ${u}`;
  D_J5 = `GAP12 J5SAFE VENDOR ${u}`;
  D_J6 = `GAP12 J6 AMBIGUOUS ${u}`;
  D_J9 = `GAP12 ROLLBACK VENDOR ${u}`;
  D_J10 = `GAP12 J10 IMPCORR VENDOR ${u}`;
  D_J7A = `GAP12 J7 LAYOUT ALPHA ${u}`;
  D_J7B = `GAP12 J7 LAYOUT BETAONE ${u}`;
  D_J7C = `GAP12 J7 LAYOUT GAMMA ${u}`;

  // J7 layout (different structural identity from the main layout used by
  // every other journey: semicolon + spanish headers + reference column).
  CSV_J7_1 =
    'fecha;concepto;importe;referencia\n' +
    `2025-06-15;${D_J7A};-50.00;REF-G12-1\n` +
    `2025-06-16;${D_J7B};-55.00;REF-G12-2\n`;
  CSV_J7_2 =
    'fecha;concepto;importe;referencia\n' +
    `2025-06-17;${D_J7C};-65.00;REF-G12-3\n`;
}, 60000);

afterAll(async () => {
  if (A) {
    const companyIds = [A.companyId, B.companyId, C.companyId];
    // csvLayoutProfile does not cascade with company deletion (scoped cleanup
    // pattern from csv-reusable-layout-e2e).
    await db.csvLayoutProfile
      .deleteMany({ where: { companyId: { in: companyIds } } })
      .catch(() => {});
    // CompanyKnowledge.companyId is ON DELETE RESTRICT (0_init migration) and
    // clearDatabase() does not cover it — delete its dependents first,
    // otherwise the company wipe silently fails and leaves orphans behind.
    await db.pendingApproval
      .deleteMany({ where: { companyId: { in: companyIds } } })
      .catch(() => {});
    await db.knowledgeAudit
      .deleteMany({ where: { companyKnowledge: { companyId: { in: companyIds } } } })
      .catch(() => {});
    await db.companyKnowledge
      .deleteMany({ where: { companyId: { in: companyIds } } })
      .catch(() => {});
  }
  await clearDatabase();
});

// ─── A. J1→J2 — new entity → confirmation/learning → reuse ───────────────────

describe('GAP12 final behavior certification', () => {
  it('J1→J2: new entity confirmed once, second/third occurrence reused automatically', async () => {
    // First occurrence: no knowledge, no rule → unclassified, NO trace.
    await importCsv('gap12-p1-1.csv', [row('2025-06-01', D_P1, -100)]);
    const first = await findTx(D_P1, -100);
    expect(first.glAccountId).toBeNull();
    expect(await traces(first.id)).toHaveLength(0);

    // REAL human intervention #1: manual classification + entity confirmation.
    c2.P1.first += 1;
    const rc = await asTenant(A, () =>
      reclassifyTransaction({
        companyId: A.companyId,
        transactionId: first.id,
        glAccountId: glExpense,
        confirmedEntity: { canonicalName: 'GAP12 Alpha Vendor', entityType: 'company' },
      }),
    );
    expect(rc.status).toBe('OK');

    // Persisted learning side effects (identity + claim).
    const ck = await db.companyKnowledge.findFirst({
      where: { companyId: A.companyId, canonicalName: 'GAP12 Alpha Vendor' },
    });
    expect(ck).not.toBeNull();
    expect(ck!.aliases).toContain(D_P1);
    const claim = await db.memoryItem.findFirst({
      where: {
        companyId: A.companyId,
        type: 'classification',
        status: 'active',
        content: { contains: ck!.id },
      },
    });
    expect(claim).not.toBeNull();

    // Learned occurrence 1: harness takes NO action → must classify itself.
    await importCsv('gap12-p1-2.csv', [row('2025-06-03', D_P1, -120)]);
    const learned1 = await findTx(D_P1, -120);
    expect(learned1.glAccountId).toBe(glExpense);
    const learned1Trace = await traces(learned1.id);
    expect(learned1Trace).toHaveLength(1);
    expect(traceDetails(learned1Trace[0]).source).toBe('KNOWLEDGE');
    expect(c2.P1.learned).toBe(0); // zero harness actions on the learned occurrence

    // Learned occurrence 2 (longitudinal): still automatic, still zero actions.
    await importCsv('gap12-p1-3.csv', [row('2025-06-05', D_P1, -140)]);
    const learned2 = await findTx(D_P1, -140);
    expect(learned2.glAccountId).toBe(glExpense);
    expect(c2.P1.learned).toBe(0);

    expect(c2.P1.learned).toBeLessThan(c2.P1.first);
  });

  // ─── B. J3→J4 — human correction → next occurrence respects it ────────────

  it('J3→J4: rule-classified transaction corrected by human, next occurrence follows the correction', async () => {
    // First occurrence classified by RULE (safe automation, not an intervention).
    await importCsv('gap12-p2-1.csv', [row('2025-06-07', D_P2, -200)]);
    const first = await findTx(D_P2, -200);
    expect(first.glAccountId).toBe(glRule);
    expect(first.matchedRuleId).toBe(ruleP2Id);
    const firstTrace = await traces(first.id);
    expect(firstTrace).toHaveLength(1);
    expect(traceDetails(firstTrace[0])).toMatchObject({
      source: 'RULE',
      matchedRuleId: ruleP2Id,
    });

    // REAL human intervention #1: correction after the rule decision.
    c2.P2.first += 1;
    const rc = await asTenant(A, () =>
      reclassifyTransaction({
        companyId: A.companyId,
        transactionId: first.id,
        glAccountId: glFixed,
        confirmedEntity: { canonicalName: 'GAP12 Beta Vendor', entityType: 'company' },
      }),
    );
    expect(rc.status).toBe('OK');

    // Learned occurrence: correction is respected, rule is NOT consulted.
    await importCsv('gap12-p2-2.csv', [row('2025-06-09', D_P2, -220)]);
    const learned = await findTx(D_P2, -220);
    expect(learned.glAccountId).toBe(glFixed); // follows the human correction
    expect(learned.matchedRuleId).toBeNull(); // KE took precedence over the rule
    const learnedTrace = await traces(learned.id);
    expect(learnedTrace).toHaveLength(1);
    expect(traceDetails(learnedTrace[0]).source).toBe('KNOWLEDGE');
    expect(c2.P2.learned).toBe(0);

    expect(c2.P2.learned).toBeLessThan(c2.P2.first);
  });

  // ─── C. J5 — consistent pattern → safe automation ─────────────────────────

  it('J5: consistent rule classifies automatically at first occurrence with full provenance', async () => {
    await importCsv('gap12-j5.csv', [row('2025-06-11', D_J5, -60)]);
    const tx = await findTx(D_J5, -60);

    // Automated with zero human actions, provenance persisted.
    expect(tx.glAccountId).toBe(glSafe);
    expect(tx.matchedRuleId).toBe(ruleJ5Id);
    const t = await traces(tx.id);
    expect(t).toHaveLength(1);
    expect(traceDetails(t[0])).toMatchObject({
      source: 'RULE',
      matchedRuleId: ruleJ5Id,
    });
    expect(tx.journalEntryId ?? null).not.toBeNull(); // books produced by the automated decision
  });

  // ─── D. J6 — ambiguity/conflict → NO automation ───────────────────────────

  it('J6: ambiguous identity → import refuses to decide → zero automatic decisions', async () => {
    const statementsBefore = await db.bankStatement.count({
      where: { bankAccountId: bankId },
    });

    // Two DISTINCT active entities match the same description → ambiguous.
    const ck1 = await db.companyKnowledge.create({
      data: {
        companyId: A.companyId,
        type: 'COMPANY',
        canonicalName: D_J6,
        aliases: [],
        status: 'active',
      },
    });
    const ck2 = await db.companyKnowledge.create({
      data: {
        companyId: A.companyId,
        type: 'COMPANY',
        canonicalName: `GAP12 J6 RIVAL ${u}`,
        aliases: [D_J6],
        status: 'active',
      },
    });

    const resolution = await resolveEntity(A.companyId, D_J6);
    expect(resolution).toMatchObject({ status: 'ERROR' });

    // The system must NOT pick a side: the import is refused fail-closed.
    const j6Csv = `Date,Description,Amount\n${row('2025-06-13', D_J6, -70)}`;
    await expect(importRaw('gap12-j6.csv', j6Csv)).rejects.toThrow('KE_ERROR');

    // Zero automatic decisions: nothing persisted, no statement, no approval.
    expect(await db.bankTransaction.count({ where: { description: D_J6 } })).toBe(0);
    expect(await db.bankStatement.count({ where: { bankAccountId: bankId } })).toBe(statementsBefore);
    expect(
      await db.pendingApproval.count({
        where: { companyId: A.companyId, action: 'ai_classification_proposal' },
      }),
    ).toBe(0);

    await db.companyKnowledge.deleteMany({ where: { id: { in: [ck1.id, ck2.id] } } });
  });

  // ─── E. J7→J8 — supported format → persistence → reuse ────────────────────

  it('J7→J8: new supported layout persisted once, second import reuses it with zero discovery', async () => {
    const fingerprint = csvLayoutFingerprint(inspectCsvLayout(CSV_J7_1));

    const before = await db.csvLayoutProfile.findUnique({
      where: {
        companyId_fingerprint: { companyId: A.companyId, fingerprint },
      },
    });
    expect(before).toBeNull();

    // First import of the new layout: discovery runs, mapping persisted.
    discoverySpy.mockClear();
    inferenceSpy.mockClear();
    const first = await importRaw('gap12-j7-1.csv', CSV_J7_1);
    expect(first.transactionCount).toBe(2);
    expect(discoverySpy).toHaveBeenCalledTimes(1);

    const profile = await db.csvLayoutProfile.findUnique({
      where: {
        companyId_fingerprint: { companyId: A.companyId, fingerprint },
      },
    });
    expect(profile).not.toBeNull();
    expect(profile!.delimiter).toBe(';');
    expect(profile!.descriptionColumnIndex).toBe(1);

    // Second import of the SAME layout: mapping reused, discovery delta = 0.
    discoverySpy.mockClear();
    inferenceSpy.mockClear();
    const second = await importRaw('gap12-j7-2.csv', CSV_J7_2);
    expect(second.transactionCount).toBe(1);
    expect(discoverySpy).toHaveBeenCalledTimes(0);
    expect(inferenceSpy).toHaveBeenCalledTimes(0);

    const profiles = await db.csvLayoutProfile.findMany({
      where: { companyId: A.companyId, fingerprint },
    });
    expect(profiles).toHaveLength(1); // reused, not duplicated

    // The stored mapping was actually APPLIED (row parsed with real columns).
    const reused = await db.bankTransaction.findFirst({
      where: { description: D_J7C, statement: { bankAccountId: bankId } },
    });
    expect(reused).not.toBeNull();
    expect(Number(reused!.amount)).toBe(-65);
  });

  // ─── F. J9 — rollback of an automated decision → consistent books ─────────

  it('J9: rollback of a RULE decision moves the transaction and leaves balanced books', async () => {
    await importCsv('gap12-j9.csv', [row('2025-06-19', D_J9, -90)]);
    const tx = await findTx(D_J9, -90);
    expect(tx.glAccountId).toBe(glRule);
    expect(tx.matchedRuleId).toBe(ruleJ9Id);

    const res = await asTenant(A, () =>
      rollbackAutomationDecision({
        companyId: A.companyId,
        transactionId: tx.id,
        actorUserId: A.userId,
        correctedGlAccountId: glFixed,
        reason: 'GAP12 J9 rollback of automated rule decision',
      }),
    );
    expect(res.ok).toBe(true);
    expect(res.classificationChanged).toBe(true);

    const after = await db.bankTransaction.findUnique({ where: { id: tx.id } });
    expect(after).not.toBeNull();
    expect(after!.glAccountId).toBe(glFixed);
    expect(after!.journalEntryId).not.toBeNull();

    // Books consistent: the post-rollback entry is balanced and targets the
    // corrected GL (rollback never writes GL values itself).
    const lines = await db.journalLine.findMany({
      where: { entryId: after!.journalEntryId! },
    });
    expect(lines.length).toBeGreaterThan(0);
    const debit = lines.reduce((acc, l) => acc + Number(l.debit), 0);
    const credit = lines.reduce((acc, l) => acc + Number(l.credit), 0);
    expect(debit).toBeCloseTo(credit, 2);
    expect(lines.some((l) => l.glAccountId === glFixed)).toBe(true);

    // Rollback audit trail snapshots the pre-rollback automated provenance.
    const rbAudit = await db.auditLog.findFirst({
      where: {
        companyId: A.companyId,
        action: 'ROLLBACK_RECLASSIFY',
        entityId: tx.id,
      },
      orderBy: { createdAt: 'desc' },
    });
    expect(rbAudit).not.toBeNull();
    expect(traceDetails(rbAudit).previousGlAccountId).toBe(glRule);

    // The decision is human-owned after rollback.
    expect(await latestExplanationSource(tx.id)).toBe('USER_CORRECTION');
  });

  // ─── G. J10 — explanation for all five sources + negative control ─────────

  it('J10: valid explanation for all 5 sources; trace-less decision yields NO explanation', async () => {
    // a) KNOWLEDGE — automatic learned decision from J1→J2.
    const txKnow = await findTx(D_P1, -120);
    const eKnow = await resolveDecisionExplanation(A.companyId, txKnow.id);
    expect(eKnow).not.toBeNull();
    expect(eKnow!.source).toBe('KNOWLEDGE');
    expect(eKnow!.label.length).toBeGreaterThan(0);

    // b) RULE — automatic rule decision from J5 (ruleName resolved).
    const txRule = await findTx(D_J5, -60);
    const eRule = await resolveDecisionExplanation(A.companyId, txRule.id);
    expect(eRule).not.toBeNull();
    expect(eRule!.source).toBe('RULE');
    expect(eRule!.label.length).toBeGreaterThan(0);
    expect(eRule!.ruleName).toBe('gap12-j5-safe');
    expect(eRule!.label).toContain('gap12-j5-safe');

    // c) USER_CORRECTION — human correction from J3→J4 (latest wins over RULE).
    const txCorr = await findTx(D_P2, -200);
    const eCorr = await resolveDecisionExplanation(A.companyId, txCorr.id);
    expect(eCorr).not.toBeNull();
    expect(eCorr!.source).toBe('USER_CORRECTION');
    expect(eCorr!.label.length).toBeGreaterThan(0);

    // d) IMPORT_CORRECTION — dedicated import-review correction.
    await importCsv('gap12-j10.csv', [row('2025-06-21', D_J10, -45)]);
    const txImp = await findTx(D_J10, -45);
    expect(txImp.glAccountId).toBeNull();
    const rc = await asTenant(A, () =>
      reclassifyTransaction({
        companyId: A.companyId,
        transactionId: txImp.id,
        glAccountId: glExpense,
        source: 'import_correction',
      }),
    );
    expect(rc.status).toBe('OK');
    const eImp = await resolveDecisionExplanation(A.companyId, txImp.id);
    expect(eImp).not.toBeNull();
    expect(eImp!.source).toBe('IMPORT_CORRECTION');
    expect(eImp!.label.length).toBeGreaterThan(0);

    // e) AI_HUMAN_APPROVED — pending approval must NOT bypass the human.
    const aiTx = await db.bankTransaction.create({
      data: {
        statementId: factoryStatementId,
        date: new Date('2025-06-27'),
        amount: -300,
        description: `GAP12 J10 AI PROPOSAL TX ${u}`,
        isReconciled: false,
        importHash: `gap12-ai-${u}`,
      },
    });
    const approval = await db.pendingApproval.create({
      data: {
        companyId: A.companyId,
        action: 'ai_classification_proposal',
        payload: {
          companyId: A.companyId,
          transactionId: `gap12-ai-${u}`, // historical contract: importHash
          bankAccountId: bankId,
          deterministicResult: 'ambiguous',
          aiProposal: {
            role: 'expense',
            glAccountCode: '6100',
            glAccountId: glExpense,
            suggestSubAccount: false,
            subAccountName: null,
            conditions: [],
          },
          proposedEntity: { canonicalName: `GAP12 AI Entity ${u}`, entityType: 'company' },
        },
        requestedBy: A.userId,
        status: 'pending',
      },
    });

    // NO BYPASS while the approval is pending: nothing was applied.
    expect(approval.status).toBe('pending');
    const pendingTx = await db.bankTransaction.findUnique({ where: { id: aiTx.id } });
    expect(pendingTx!.glAccountId).toBeNull();
    expect(pendingTx!.journalEntryId).toBeNull();
    expect(await traces(aiTx.id)).toHaveLength(0);

    // Explicit human decision consumes the approval through the gated consumer.
    const decided = await asTenant(A, () =>
      decideAiProposal({
        companyId: A.companyId,
        approvalId: approval.id,
        decision: 'ACCEPT',
      }),
    );
    expect(decided).toMatchObject({ status: 'OK', decision: 'ACCEPT' });

    const eAi = await resolveDecisionExplanation(A.companyId, aiTx.id);
    expect(eAi).not.toBeNull();
    expect(eAi!.source).toBe('AI_HUMAN_APPROVED');
    expect(eAi!.label.length).toBeGreaterThan(0);
    const aiTrace = await traces(aiTx.id);
    expect(aiTrace).toHaveLength(1);
    expect(traceDetails(aiTrace[0]).approvalId).toBe(approval.id);

    // NEGATIVE CONTROL: a GL decision without a trace must NOT produce an
    // explanation — fabricated provenance must fail certification.
    const noTraceTx = await db.bankTransaction.create({
      data: {
        statementId: factoryStatementId,
        date: new Date('2025-06-28'),
        amount: -11,
        description: `GAP12 NO TRACE TX ${u}`,
        isReconciled: false,
        glAccountId: glExpense,
      },
    });
    expect(await resolveDecisionExplanation(A.companyId, noTraceTx.id)).toBeNull();
  });

  // ─── H. J11 — tenant isolation ────────────────────────────────────────────

  it('J11: tenant B consumes nothing from tenant A (knowledge, traces, writes, route)', async () => {
    const txA = await findTx(D_P1, -120);

    // Knowledge is not consumed cross-tenant.
    expect(await resolveEntity(B.companyId, D_P1)).toEqual({ status: 'UNKNOWN' });

    // Explanations are tenant-scoped: B sees no provenance for A's tx.
    expect(await resolveDecisionExplanation(B.companyId, txA.id)).toBeNull();

    // Reclassification refused (tenant-scoped read).
    const denied = await reclassifyTransaction({
      companyId: B.companyId,
      transactionId: txA.id,
      glAccountId: glExpense,
    });
    expect(denied.status).toBe('TRANSACTION_NOT_FOUND');

    // Rollback fails closed for the wrong tenant.
    await expect(
      rollbackAutomationDecision({
        companyId: B.companyId,
        transactionId: txA.id,
        actorUserId: B.userId,
        correctedGlAccountId: glExpense,
        reason: 'GAP12 cross-tenant rollback attempt',
      }),
    ).rejects.toThrow(/ROLLBACK_FAIL_CLOSED/);

    // Route: B's session + B's company + A's transaction → no leak.
    const req = new NextRequest(
      `http://localhost/api/transactions/${txA.id}/explanation?companyId=${B.companyId}`,
      { method: 'GET', headers: { Authorization: `Bearer ${B.token}` } },
    );
    const res = await explainGET(req, {
      params: Promise.resolve({ id: txA.id }),
    } as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { explanation: unknown };
    expect(body.explanation).toBeNull();
  });

  // ─── I. J12 — longitudinal decreasing intervention (K ≥ 3 patterns) ───────

  it('J12: LEARNED_INTERVENTION < FIRST_INTERVENTION per pattern and in SUM, correlated with persisted evidence', async () => {
    // Third pattern: first occurrence → human classify + confirm.
    await importCsv('gap12-p3-1.csv', [row('2025-06-23', D_P3, -80)]);
    const p3First = await findTx(D_P3, -80);
    expect(p3First.glAccountId).toBeNull();

    c2.P3.first += 1;
    const rc = await asTenant(A, () =>
      reclassifyTransaction({
        companyId: A.companyId,
        transactionId: p3First.id,
        glAccountId: glFixed,
        confirmedEntity: { canonicalName: 'GAP12 Delta Vendor', entityType: 'company' },
      }),
    );
    expect(rc.status).toBe('OK');

    // Learned occurrence of P3: zero harness actions.
    await importCsv('gap12-p3-2.csv', [row('2025-06-25', D_P3, -85)]);
    const p3Learned = await findTx(D_P3, -85);
    expect(p3Learned.glAccountId).toBe(glFixed);
    const p3Trace = await traces(p3Learned.id);
    expect(p3Trace).toHaveLength(1);
    expect(traceDetails(p3Trace[0]).source).toBe('KNOWLEDGE');
    expect(c2.P3.learned).toBe(0);

    // K ≥ 3 patterns measured.
    const patterns: PatternKey[] = ['P1', 'P2', 'P3'];
    expect(patterns.length).toBeGreaterThanOrEqual(3);

    let firstTotal = 0;
    let learnedTotal = 0;
    for (const p of patterns) {
      // Per-pattern paired comparison (never a global aggregate alone).
      expect(c2[p].learned).toBeLessThan(c2[p].first);
      firstTotal += c2[p].first;
      learnedTotal += c2[p].learned;
    }
    // Global SUM over the same patterns.
    expect(learnedTotal).toBeLessThan(firstTotal);

    // Correlation with PERSISTED side effects — the counter alone is never
    // the evidence: every learned occurrence carries a real runtime decision.
    const learnedCases = [
      { description: D_P1, amount: -120, glId: glExpense },
      { description: D_P2, amount: -220, glId: glFixed },
      { description: D_P3, amount: -85, glId: glFixed },
    ];
    for (const lc of learnedCases) {
      const tx = await findTx(lc.description, lc.amount);
      expect(tx.glAccountId).toBe(lc.glId);
      const t = await traces(tx.id);
      expect(t).toHaveLength(1);
      expect(traceDetails(t[0]).source).toBe('KNOWLEDGE');
      const ck = await db.companyKnowledge.findFirst({
        where: { companyId: A.companyId, aliases: { has: lc.description } },
      });
      expect(ck).not.toBeNull();
      const claim = await db.memoryItem.findFirst({
        where: {
          companyId: A.companyId,
          type: 'classification',
          status: 'active',
          content: { contains: ck!.id },
        },
      });
      expect(claim).not.toBeNull();
    }

    // Pinned certification numbers (documented in the SALIDA contract).
    expect(firstTotal).toBe(3);
    expect(learnedTotal).toBe(0);
  });

  // ─── PASO 6 — safety properties, asserted explicitly ──────────────────────

  it('SAFETY: conflict → 0 auto, approval gated, tenant isolation, rollback consistency, RBAC+entitlement', async () => {
    // 1. Pending conflict (J6 ambiguity) → zero automatic decisions persisted.
    expect(await db.bankTransaction.count({ where: { description: D_J6 } })).toBe(0);
    expect(await resolveEntity(A.companyId, D_J6)).toEqual({ status: 'UNKNOWN' }); // rivals cleaned; no auto side effect ever persisted

    // 2. Pending human approval → no bypass: the approval is consumed ONLY by
    //    the explicit decision flow, and its trace carries the approval id.
    const approval = await db.pendingApproval.findFirst({
      where: { companyId: A.companyId, action: 'ai_classification_proposal' },
    });
    expect(approval).not.toBeNull();
    expect(approval!.status).not.toBe('pending');
    const aiTx = await db.bankTransaction.findFirst({
      where: { importHash: `gap12-ai-${u}` },
    });
    expect(aiTx).not.toBeNull();
    const aiTrace = await traces(aiTx!.id);
    expect(aiTrace).toHaveLength(1);
    expect(traceDetails(aiTrace[0]).approvalId).toBe(approval!.id);

    // 3. Tenant B never consumes A's knowledge/traces (re-check).
    const txA = await findTx(D_P1, -120);
    expect(await resolveDecisionExplanation(B.companyId, txA.id)).toBeNull();
    expect(await resolveEntity(B.companyId, D_P1)).toEqual({ status: 'UNKNOWN' });

    // 4. Rollback left consistent books (re-check on the J9 transaction).
    const j9Tx = await findTx(D_J9, -90);
    expect(j9Tx.glAccountId).toBe(glFixed);
    expect(j9Tx.journalEntryId).not.toBeNull();
    const j9Lines = await db.journalLine.findMany({
      where: { entryId: j9Tx.journalEntryId! },
    });
    const debit = j9Lines.reduce((acc, l) => acc + Number(l.debit), 0);
    const credit = j9Lines.reduce((acc, l) => acc + Number(l.credit), 0);
    expect(debit).toBeCloseTo(credit, 2);

    // 5a. Positive control: admin + entitled + allowed role → 200 with data.
    const txCorr = await findTx(D_P2, -200);
    const okReq = new NextRequest(
      `http://localhost/api/transactions/${txCorr.id}/explanation?companyId=${A.companyId}`,
      { method: 'GET', headers: { Authorization: `Bearer ${A.token}` } },
    );
    const okRes = await explainGET(okReq, {
      params: Promise.resolve({ id: txCorr.id }),
    } as never);
    expect(okRes.status).toBe(200);
    const okBody = (await okRes.json()) as {
      explanation: { source: string; label: string } | null;
    };
    expect(okBody.explanation).not.toBeNull();
    expect(okBody.explanation!.source).toBe('USER_CORRECTION');
    expect(okBody.explanation!.label.length).toBeGreaterThan(0);

    // 5b. RBAC: role outside ['company_admin','employee'] → 403.
    const viewerReq = new NextRequest(
      `http://localhost/api/transactions/${txCorr.id}/explanation?companyId=${A.companyId}`,
      { method: 'GET', headers: { Authorization: `Bearer ${viewerToken}` } },
    );
    const viewerRes = await explainGET(viewerReq, {
      params: Promise.resolve({ id: txCorr.id }),
    } as never);
    expect(viewerRes.status).toBe(403);
    const viewerBody = (await viewerRes.json()) as { code?: string };
    expect(viewerBody.code).toBe('FORBIDDEN');

    // 5c. RBAC: no membership in the target tenant → 403.
    const outsiderReq = new NextRequest(
      `http://localhost/api/transactions/${txCorr.id}/explanation?companyId=${A.companyId}`,
      { method: 'GET', headers: { Authorization: `Bearer ${outsiderToken}` } },
    );
    const outsiderRes = await explainGET(outsiderReq, {
      params: Promise.resolve({ id: txCorr.id }),
    } as never);
    expect(outsiderRes.status).toBe(403);

    // 5d. Entitlement: company without banking entitlement → 403 MODULE_*.
    const entReq = new NextRequest(
      `http://localhost/api/transactions/${txCorr.id}/explanation?companyId=${C.companyId}`,
      { method: 'GET', headers: { Authorization: `Bearer ${C.token}` } },
    );
    const entRes = await explainGET(entReq, {
      params: Promise.resolve({ id: txCorr.id }),
    } as never);
    expect(entRes.status).toBe(403);
    const entBody = (await entRes.json()) as { code?: string };
    expect(/^MODULE_/.test(entBody.code ?? '')).toBe(true);
  });
});
