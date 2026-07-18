import { describe, it, expect } from 'vitest';
import {
  importAdapter,
  applyAllAdapter,
  previewAdapter,
  reconAdapter,
  type AdapterRule,
} from '@/lib/services/rule-precedence-adapters';
import type { RuleMatchOutput } from '@/lib/services/rule-precedence-engine';

function match(overrides?: Partial<RuleMatchOutput>): RuleMatchOutput {
  return {
    winner: undefined,
    classification: undefined,
    ...overrides,
  };
}

function rule(overrides: Partial<AdapterRule> & { id: string }): AdapterRule {
  return {
    name: 'Test Rule',
    glAccountId: null,
    debitGlAccountId: null,
    creditGlAccountId: null,
    ...overrides,
  };
}

describe('importAdapter', () => {
  it('returns matchedRuleId and glAccountId from winner when rule is found', () => {
    const rules = [rule({ id: 'r1', glAccountId: 'gl-001' })];
    const m = match({ winner: { ruleId: 'r1', ruleName: 'Test' } });

    const result = importAdapter(m, rules);

    expect(result).toEqual({ matchedRuleId: 'r1', glAccountId: 'gl-001' });
  });

  it('falls back to debitGlAccountId when glAccountId is null', () => {
    const rules = [rule({ id: 'r1', glAccountId: null, debitGlAccountId: 'debit-gl' })];
    const m = match({ winner: { ruleId: 'r1', ruleName: 'Test' } });

    const result = importAdapter(m, rules);

    expect(result).toEqual({ matchedRuleId: 'r1', glAccountId: 'debit-gl' });
  });

  it('falls back to creditGlAccountId when glAccountId and debitGlAccountId are null', () => {
    const rules = [rule({ id: 'r1', glAccountId: null, debitGlAccountId: null, creditGlAccountId: 'credit-gl' })];
    const m = match({ winner: { ruleId: 'r1', ruleName: 'Test' } });

    const result = importAdapter(m, rules);

    expect(result).toEqual({ matchedRuleId: 'r1', glAccountId: 'credit-gl' });
  });

  it('returns null glAccountId when all gl account fields are null', () => {
    const rules = [rule({ id: 'r1', glAccountId: null, debitGlAccountId: null, creditGlAccountId: null })];
    const m = match({ winner: { ruleId: 'r1', ruleName: 'Test' } });

    const result = importAdapter(m, rules);

    expect(result).toEqual({ matchedRuleId: 'r1', glAccountId: null });
  });

  it('returns null/null when there is no winner', () => {
    const rules = [rule({ id: 'r1', glAccountId: 'gl-001' })];
    const m = match({ winner: undefined });

    const result = importAdapter(m, rules);

    expect(result).toEqual({ matchedRuleId: null, glAccountId: null });
  });

  it('returns null glAccountId when winner rule is not in the rules array', () => {
    const rules = [rule({ id: 'r1', glAccountId: 'gl-001' })];
    const m = match({ winner: { ruleId: 'r2', ruleName: 'Missing' } });

    const result = importAdapter(m, rules);

    expect(result).toEqual({ matchedRuleId: 'r2', glAccountId: null });
  });

  it('prioritizes glAccountId over debitGlAccountId and creditGlAccountId', () => {
    const rules = [rule({ id: 'r1', glAccountId: 'gl-001', debitGlAccountId: 'debit-gl', creditGlAccountId: 'credit-gl' })];
    const m = match({ winner: { ruleId: 'r1', ruleName: 'Test' } });

    const result = importAdapter(m, rules);

    expect(result).toEqual({ matchedRuleId: 'r1', glAccountId: 'gl-001' });
  });
});

describe('applyAllAdapter', () => {
  it('returns matchedRuleId and resolvedRule when rule is found', () => {
    const rules = [rule({ id: 'r1', name: 'My Rule', priority: 5, glAccountId: 'gl-001' })];
    const m = match({ winner: { ruleId: 'r1', ruleName: 'My Rule' } });

    const result = applyAllAdapter(m, rules);

    expect(result.matchedRuleId).toBe('r1');
    expect(result.resolvedRule).toEqual({
      id: 'r1',
      name: 'My Rule',
      priority: 5,
      glAccountId: 'gl-001',
      debitGlAccountId: null,
      creditGlAccountId: null,
    });
  });

  it('returns resolvedRule: null when there is no winner', () => {
    const rules = [rule({ id: 'r1', glAccountId: 'gl-001' })];
    const m = match({ winner: undefined });

    const result = applyAllAdapter(m, rules);

    expect(result.matchedRuleId).toBeNull();
    expect(result.resolvedRule).toBeNull();
  });

  it('returns resolvedRule: null when winner rule is not in the rules array', () => {
    const rules = [rule({ id: 'r1', glAccountId: 'gl-001' })];
    const m = match({ winner: { ruleId: 'r2', ruleName: 'Missing' } });

    const result = applyAllAdapter(m, rules);

    expect(result.matchedRuleId).toBe('r2');
    expect(result.resolvedRule).toBeNull();
  });

  it('includes all fields in resolvedRule', () => {
    const rules = [{
      id: 'r1',
      name: 'Full Rule',
      priority: 3,
      glAccountId: 'gl-001',
      debitGlAccountId: 'debit-gl',
      creditGlAccountId: 'credit-gl',
    }];
    const m = match({ winner: { ruleId: 'r1', ruleName: 'Full Rule' } });

    const result = applyAllAdapter(m, rules);

    expect(result.resolvedRule).toEqual({
      id: 'r1',
      name: 'Full Rule',
      priority: 3,
      glAccountId: 'gl-001',
      debitGlAccountId: 'debit-gl',
      creditGlAccountId: 'credit-gl',
    });
  });

  it('does NOT resolve GL account direction-aware (leaves it to the flow)', () => {
    const rules = [rule({ id: 'r1', name: 'Test', priority: 1, glAccountId: 'gl-001', debitGlAccountId: 'debit-gl', creditGlAccountId: 'credit-gl' })];
    const m = match({ winner: { ruleId: 'r1', ruleName: 'Test' } });

    const result = applyAllAdapter(m, rules);

    // All three GL fields are present — the adapter does NOT choose one
    expect(result.resolvedRule?.glAccountId).toBe('gl-001');
    expect(result.resolvedRule?.debitGlAccountId).toBe('debit-gl');
    expect(result.resolvedRule?.creditGlAccountId).toBe('credit-gl');
  });
});

describe('previewAdapter', () => {
  it('returns true when there is a winner', () => {
    const m = match({ winner: { ruleId: 'r1', ruleName: 'Test' } });

    const result = previewAdapter(m);

    expect(result).toBe(true);
  });

  it('returns false when winner is undefined', () => {
    const m = match({ winner: undefined });

    const result = previewAdapter(m);

    expect(result).toBe(false);
  });
});

describe('reconAdapter', () => {
  it('returns winner with ruleId and glAccountId when rule is found', () => {
    const rules = [rule({ id: 'r1', glAccountId: 'gl-001' })];
    const m = match({ winner: { ruleId: 'r1', ruleName: 'Test' } });

    const result = reconAdapter(m, rules);

    expect(result).toEqual({ ruleId: 'r1', glAccountId: 'gl-001' });
  });

  it('returns null when there is no winner', () => {
    const rules = [rule({ id: 'r1', glAccountId: 'gl-001' })];
    const m = match({ winner: undefined });

    const result = reconAdapter(m, rules);

    expect(result).toBeNull();
  });

  it('returns null when winner rule is not in the rules array', () => {
    const rules = [rule({ id: 'r1', glAccountId: 'gl-001' })];
    const m = match({ winner: { ruleId: 'r2', ruleName: 'Missing' } });

    const result = reconAdapter(m, rules);

    expect(result).toBeNull();
  });
});
