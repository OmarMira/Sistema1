import { describe, it, expect } from 'vitest';
import {
  ELIGIBLE_FOR_CLASSIFICATION_FILTER,
  eligibleForClassificationWhere,
} from '@/lib/services/transaction-invariants';

describe('ELIGIBLE_FOR_CLASSIFICATION_FILTER', () => {
  it('contains the five expected fields with correct values', () => {
    expect(ELIGIBLE_FOR_CLASSIFICATION_FILTER).toEqual({
      isReconciled: false,
      isIgnored: false,
      journalEntryId: null,
      matchedRuleId: null,
      glAccountId: null,
    });
  });

  it('is frozen (cannot be mutated)', () => {
    expect(Object.isFrozen(ELIGIBLE_FOR_CLASSIFICATION_FILTER)).toBe(true);
  });
});

describe('eligibleForClassificationWhere', () => {
  it('wraps the invariant filter + extra in AND', () => {
    const result = eligibleForClassificationWhere({
      statementId: { in: ['s1', 's2'] },
    });

    expect(result).toEqual({
      AND: [
        ELIGIBLE_FOR_CLASSIFICATION_FILTER,
        { statementId: { in: ['s1', 's2'] } },
      ],
    });
  });

  it('returns AND with empty extra when no args provided', () => {
    const result = eligibleForClassificationWhere();

    expect(result).toEqual({
      AND: [ELIGIBLE_FOR_CLASSIFICATION_FILTER, {}],
    });
  });

  it('wraps conflicting invariant override in AND without discarding it', () => {
    const result = eligibleForClassificationWhere({ isIgnored: true });

    expect(result).toEqual({
      AND: [
        { isReconciled: false, isIgnored: false, journalEntryId: null, matchedRuleId: null, glAccountId: null },
        { isIgnored: true },
      ],
    });
  });
});
