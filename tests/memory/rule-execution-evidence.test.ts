// §GAP8-2B — Rule execution feedback → statistical memory (ROADMAP GAP #8)
// Evidence is ADVISORY: company-scoped, traceable, queryable — and it can
// NEVER promote confidence, create permanent knowledge, or change a
// classification. C11 policy is untouched: evidence stays `tentative`.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  recordRuleExecutionEvidence,
  getRuleExecutionEvidence,
  createAdapter,
  RULE_EVIDENCE_TYPE,
} from '../../src/memory/classification-knowledge';
import type { MemoryAdapter } from '../../src/memory/adapter';
import { db } from '@/lib/db';
import { createTestCompany, clearDatabase } from '../helpers/factories';

function adapter(): MemoryAdapter {
  return createAdapter(db, (fn) => db.$transaction(fn));
}

describe('§GAP8-2B — rule execution evidence (statistical, advisory)', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  it('T1: a successful rule match produces statistical evidence', async () => {
    const company = await createTestCompany('Rule Evidence Co');
    const a = adapter();

    const result = await recordRuleExecutionEvidence(a, company.id, {
      kind: 'RULE_MATCHED',
      ruleId: 'rule_acme_1',
      glAccountId: 'gl_revenue_1',
      originalDescription: 'ACME SUPPLY PAYMENT',
      direction: 'credit',
      transactionId: 'hash_tx_1',
    });
    expect(result.ok).toBe(true);

    const evidence = await getRuleExecutionEvidence(a, company.id);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]!.evidence.kind).toBe('RULE_MATCHED');
    expect(evidence[0]!.itemId).toBeTruthy();
  });

  it('T2: evidence is company-scoped at the persistence layer', async () => {
    const companyA = await createTestCompany('Evidence Tenant A');
    const a = adapter();

    await recordRuleExecutionEvidence(a, companyA.id, {
      kind: 'RULE_MATCHED',
      ruleId: 'rule_scoped',
      glAccountId: 'gl_1',
      originalDescription: 'SCOPED DESCRIPTION',
      direction: 'debit',
      transactionId: 'hash_scoped_1',
    });

    // Rows themselves carry the tenant scope (no cross-tenant leakage).
    const rows = await db.memoryItem.findMany({
      where: { type: RULE_EVIDENCE_TYPE, companyId: companyA.id },
      select: { companyId: true },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.companyId).toBe(companyA.id);

    const raw = await db.memoryItem.findFirst({ where: { type: RULE_EVIDENCE_TYPE, companyId: companyA.id } });
    expect(raw).not.toBeNull();
    expect(raw!.companyId).toBe(companyA.id);
  });

  it('T3: evidence records rule identity and full provenance', async () => {
    const company = await createTestCompany('Evidence Provenance Co');
    const a = adapter();

    await recordRuleExecutionEvidence(a, company.id, {
      kind: 'RULE_MATCHED',
      ruleId: 'rule_provenance_9',
      glAccountId: 'gl_target_7',
      originalDescription: 'VENDOR PAYMENT REF 77',
      direction: 'debit',
      transactionId: 'hash_provenance_9',
    });

    const evidence = await getRuleExecutionEvidence(a, company.id, { ruleId: 'rule_provenance_9' });
    expect(evidence).toHaveLength(1);
    expect(evidence[0]!.evidence).toMatchObject({
      kind: 'RULE_MATCHED',
      ruleId: 'rule_provenance_9',
      glAccountId: 'gl_target_7',
      originalDescription: 'VENDOR PAYMENT REF 77',
      direction: 'debit',
      transactionId: 'hash_provenance_9',
    });
  });

  it('T4: repeated successful rule executions NEVER auto-promote confidence', async () => {
    const company = await createTestCompany('Evidence Confidence Co');
    const a = adapter();

    for (let i = 0; i < 3; i++) {
      const result = await recordRuleExecutionEvidence(a, company.id, {
        kind: 'RULE_MATCHED',
        ruleId: 'rule_repeat_1',
        glAccountId: 'gl_repeat',
        originalDescription: 'REPEAT DESCRIPTION',
        direction: 'credit',
        transactionId: `hash_repeat_${i}`,
      });
      expect(result.ok).toBe(true);
    }

    // All evidence rows stay at the default C11 level.
    const items = await db.memoryItem.findMany({
      where: { type: RULE_EVIDENCE_TYPE, companyId: company.id },
      select: { confidence: true },
    });
    expect(items).toHaveLength(3);
    expect(items.every((i) => i.confidence === 'tentative')).toBe(true);

    // No confidence evolution was logged for any of them.
    const logCount = await db.confidenceLog.count({
      where: { itemId: { in: (await db.memoryItem.findMany({ where: { type: RULE_EVIDENCE_TYPE, companyId: company.id }, select: { id: true } })).map((i) => i.id) } },
    });
    expect(logCount).toBe(0);

    // Evidence never creates identity or treatment knowledge as a side effect.
    expect(await db.companyKnowledge.count({ where: { companyId: company.id } })).toBe(0);
    expect(
      await db.memoryItem.count({ where: { companyId: company.id, type: { not: RULE_EVIDENCE_TYPE } } }),
    ).toBe(0);
  });

  it('T4b: RULE_NOT_MATCHED is recorded without inventing a rule identity', async () => {
    const company = await createTestCompany('Evidence NoMatch Co');
    const a = adapter();

    const result = await recordRuleExecutionEvidence(a, company.id, {
      kind: 'RULE_NOT_MATCHED',
      originalDescription: 'UNCOVERED VENDOR',
      direction: 'credit',
      transactionId: 'hash_nomatch_1',
    });
    expect(result.ok).toBe(true);

    const evidence = await getRuleExecutionEvidence(a, company.id, { kind: 'RULE_NOT_MATCHED' });
    expect(evidence).toHaveLength(1);
    expect(evidence[0]!.evidence.ruleId).toBeUndefined();
  });

  it('T4c: insufficient-context events are rejected instead of recorded', async () => {
    const company = await createTestCompany('Evidence Validation Co');
    const a = adapter();

    // Match without a winning rule identity → not enough context.
    const noRule = await recordRuleExecutionEvidence(a, company.id, {
      kind: 'RULE_MATCHED',
      glAccountId: 'gl_x',
      originalDescription: 'X',
      direction: 'any',
    });
    expect(noRule.ok).toBe(false);

    // Override that does not actually change the GL → not an override.
    const noChange = await recordRuleExecutionEvidence(a, company.id, {
      kind: 'RULE_OVERRIDDEN',
      ruleId: 'rule_x',
      previousGlAccountId: 'gl_same',
      glAccountId: 'gl_same',
      originalDescription: 'X',
      direction: 'any',
    });
    expect(noChange.ok).toBe(false);

    expect(await db.memoryItem.count({ where: { companyId: company.id } })).toBe(0);
  });

  it('T7: cross-company reads cannot see another tenant’s evidence', async () => {
    const companyA = await createTestCompany('Evidence Tenant X');
    const companyB = await createTestCompany('Evidence Tenant Y');
    const a = adapter();

    await recordRuleExecutionEvidence(a, companyA.id, {
      kind: 'RULE_MATCHED',
      ruleId: 'rule_tenant_iso',
      glAccountId: 'gl_1',
      originalDescription: 'TENANT ISOLATION DESCRIPTION',
      direction: 'debit',
      transactionId: 'hash_tenant_iso_1',
    });

    // Tenant B sees nothing — same ruleId, same adapter, different scope.
    const seenByB = await getRuleExecutionEvidence(a, companyB.id, { ruleId: 'rule_tenant_iso' });
    expect(seenByB).toHaveLength(0);

    const typeScanB = await a.getByType(companyB.id, RULE_EVIDENCE_TYPE);
    expect(typeScanB).toHaveLength(0);

    // Tenant A still sees its own row.
    const seenByA = await getRuleExecutionEvidence(a, companyA.id, { ruleId: 'rule_tenant_iso' });
    expect(seenByA).toHaveLength(1);
  });

  it('idempotent: the same anchored event is recorded exactly once', async () => {
    const company = await createTestCompany('Evidence Idempotent Co');
    const a = adapter();

    const event = {
      kind: 'RULE_MATCHED' as const,
      ruleId: 'rule_idem_1',
      glAccountId: 'gl_idem',
      originalDescription: 'IDEMPOTENT DESCRIPTION',
      direction: 'credit' as const,
      transactionId: 'hash_idem_1',
    };
    const first = await recordRuleExecutionEvidence(a, company.id, event);
    const second = await recordRuleExecutionEvidence(a, company.id, event);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(
      await db.memoryItem.count({ where: { type: RULE_EVIDENCE_TYPE, companyId: company.id } }),
    ).toBe(1);
  });
});
