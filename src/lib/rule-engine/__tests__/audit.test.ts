import { describe, it, expect, vi, beforeEach } from 'vitest';
import { persistRuleExecutionAudit } from '../audit';
import type { AuditRecord } from '../types';

const mockCreate = vi.hoisted(() => vi.fn());

vi.mock('@/lib/db', () => ({
  db: {
    ruleExecutionAudit: {
      create: mockCreate,
    },
  },
}));

function makeAuditRecord(overrides?: Partial<AuditRecord>): AuditRecord {
  return {
    engineVersion: '2.1.0',
    transactionId: 'tx-1',
    companyId: 'company-1',
    result: 'winner',
    winnerRuleId: 'rule-1',
    candidateCount: 1,
    trace: {
      engineVersion: '2.1.0',
      events: [{ stage: 'execution', event: 'complete' }],
      truncated: false,
      totalEvents: 1,
      emittedEvents: 1,
    },
    ...overrides,
  };
}

describe('persistRuleExecutionAudit', () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it('inserts audit record into the database', async () => {
    const audit = makeAuditRecord();
    mockCreate.mockResolvedValue({ id: 'audit-1' });

    await persistRuleExecutionAudit(audit);

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate).toHaveBeenCalledWith({
      data: {
        engineVersion: '2.1.0',
        transactionId: 'tx-1',
        companyId: 'company-1',
        result: 'MATCHED',
        winnerRuleId: 'rule-1',
        candidateCount: 1,
        trace: expect.any(String),
      },
    });
  });

  it('maps result winner to MATCHED', async () => {
    const audit = makeAuditRecord({ result: 'winner' });
    mockCreate.mockResolvedValue({ id: 'audit-1' });

    await persistRuleExecutionAudit(audit);

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ result: 'MATCHED' }),
      }),
    );
  });

  it('maps result ambiguous to AMBIGUOUS', async () => {
    const audit = makeAuditRecord({ result: 'ambiguous' });
    mockCreate.mockResolvedValue({ id: 'audit-2' });

    await persistRuleExecutionAudit(audit);

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ result: 'AMBIGUOUS' }),
      }),
    );
  });

  it('maps result no_match to NO_MATCH', async () => {
    const audit = makeAuditRecord({ result: 'no_match' });
    mockCreate.mockResolvedValue({ id: 'audit-3' });

    await persistRuleExecutionAudit(audit);

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ result: 'NO_MATCH' }),
      }),
    );
  });

  it('handles missing winnerRuleId as null', async () => {
    const audit = makeAuditRecord({ result: 'no_match', winnerRuleId: undefined });
    mockCreate.mockResolvedValue({ id: 'audit-4' });

    await persistRuleExecutionAudit(audit);

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ winnerRuleId: null }),
      }),
    );
  });

  it('does not throw when DB create fails (best-effort)', async () => {
    const audit = makeAuditRecord();
    mockCreate.mockRejectedValue(new Error('DB connection lost'));

    await expect(persistRuleExecutionAudit(audit)).resolves.toBeUndefined();
  });

  it('serializes trace as JSON string', async () => {
    const audit = makeAuditRecord();
    mockCreate.mockResolvedValue({ id: 'audit-5' });

    await persistRuleExecutionAudit(audit);

    const callArg = mockCreate.mock.calls[0][0];
    const parsed = JSON.parse(callArg.data.trace);
    expect(parsed).toEqual(audit.trace);
  });

  it('integration: evaluateRules calls persistRuleExecutionAudit', async () => {
    vi.stubEnv('RULE_ENGINE_V2_ENABLED', 'true');
    mockCreate.mockResolvedValue({ id: 'audit-6' });

    const { evaluateRules } = await import('../index');
    const { makeRule, makeTransaction, makeCondition } = await import('./fixtures');

    const rule = makeRule({ conditions: [makeCondition('amount_gt', 500)] });
    const tx = makeTransaction({ amount: 600 });
    const result = evaluateRules({
      transaction: tx,
      context: {
        availableRules: [rule],
        entityContexts: [],
        historicalMatches: [],
        entityResolution: { status: 'not_run' as const },
      },
    });

    expect(result.audit).toBeDefined();
    expect(result.audit!.result).toBe('winner');
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });
});
