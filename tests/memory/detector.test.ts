// Memory Core — Detector Tests (7.2 + fixes)
// Tests for deterministic contradiction detection (C7 scope)

import { describe, it, expect } from 'vitest';
import { detectDeterministic } from '../../src/memory/detector';

describe('detectDeterministic — C7 deterministic scope', () => {
  // ─── Negation — same topic → contradiction ──────────────────

  describe('negation detection — SAME topic (contradiction)', () => {
    it('should detect "is true" vs "is false" about same subject', () => {
      const result = detectDeterministic(
        { content: 'The transaction is true' },
        { content: 'The transaction is false' }
      );
      expect(result.isContradiction).toBe(true);
      expect(result.type).toBe('negation');
      expect(result.confidence).toBeGreaterThan(0);
    });

    it('should detect "exists" vs "does not exist" about same subject', () => {
      const result = detectDeterministic(
        { content: 'The account exists' },
        { content: 'The account does not exist' }
      );
      expect(result.isContradiction).toBe(true);
      expect(result.type).toBe('negation');
    });

    it('should detect "can" vs "cannot" about same subject', () => {
      const result = detectDeterministic(
        { content: 'The system can process refunds' },
        { content: 'The system cannot process refunds' }
      );
      expect(result.isContradiction).toBe(true);
      expect(result.type).toBe('negation');
    });

    it('should detect Spanish negation — same subject', () => {
      const result = detectDeterministic(
        { content: 'La transacción es verdadera' },
        { content: 'La transacción es falsa' }
      );
      expect(result.isContradiction).toBe(true);
      expect(result.type).toBe('negation');
    });

    it('should not flag same affirmation as contradiction', () => {
      const result = detectDeterministic(
        { content: 'The transaction is true' },
        { content: 'The transaction is also true' }
      );
      expect(result.isContradiction).toBe(false);
    });
  });

  // ─── Negation — different topic → NOT contradiction ─────────

  describe('negation detection — DIFFERENT topic (NOT contradiction)', () => {
    it('should NOT flag "Account A exists" vs "Account B does not exist"', () => {
      const result = detectDeterministic(
        { content: 'Account A exists' },
        { content: 'Account B does not exist' }
      );
      expect(result.isContradiction).toBe(false);
      expect(result.type).toBe('none');
    });

    it('should NOT flag "Company X is true" vs "Company Y is false"', () => {
      const result = detectDeterministic(
        { content: 'Company X is true' },
        { content: 'Company Y is false' }
      );
      expect(result.isContradiction).toBe(false);
      expect(result.type).toBe('none');
    });

    it('should NOT flag different subjects in Spanish', () => {
      const result = detectDeterministic(
        { content: 'La cuenta de Juan existe' },
        { content: 'La cuenta de Pedro no existe' }
      );
      expect(result.isContradiction).toBe(false);
      expect(result.type).toBe('none');
    });

    it('should NOT flag "can process refunds" vs "cannot process invoices" (different action)', () => {
      const result = detectDeterministic(
        { content: 'The system can process refunds' },
        { content: 'The system cannot process invoices' }
      );
      expect(result.isContradiction).toBe(false);
      expect(result.type).toBe('none');
    });

    it('should NOT flag different subjects with can/cannot', () => {
      const result = detectDeterministic(
        { content: 'The system can process refunds' },
        { content: 'The vendor cannot process refunds' }
      );
      expect(result.isContradiction).toBe(false);
      expect(result.type).toBe('none');
    });
  });

  // ─── Claim/Value contradiction ──────────────────────────────

  describe('claim/value contradiction', () => {
    it('should detect same claim with different boolean values', () => {
      const result = detectDeterministic(
        { content: JSON.stringify({ claim: 'invoice_paid', value: true }) },
        { content: JSON.stringify({ claim: 'invoice_paid', value: false }) }
      );
      expect(result.isContradiction).toBe(true);
      expect(result.type).toBe('claim_value');
      expect(result.confidence).toBe(1.0);
    });

    it('should detect same claim with different string values', () => {
      const result = detectDeterministic(
        { content: JSON.stringify({ claim: 'status', value: 'active' }) },
        { content: JSON.stringify({ claim: 'status', value: 'inactive' }) }
      );
      expect(result.isContradiction).toBe(true);
      expect(result.type).toBe('claim_value');
    });

    it('should not flag different claims as contradiction', () => {
      const result = detectDeterministic(
        { content: JSON.stringify({ claim: 'invoice_paid', value: true }) },
        { content: JSON.stringify({ claim: 'invoice_sent', value: true }) }
      );
      expect(result.isContradiction).toBe(false);
    });

    it('should not flag same claim with same value', () => {
      const result = detectDeterministic(
        { content: JSON.stringify({ claim: 'invoice_paid', value: true }) },
        { content: JSON.stringify({ claim: 'invoice_paid', value: true }) }
      );
      expect(result.isContradiction).toBe(false);
    });
  });

  // ─── No contradiction cases ─────────────────────────────────

  describe('no contradiction cases', () => {
    it('should not flag unrelated texts', () => {
      const result = detectDeterministic(
        { content: 'The company operates in Miami' },
        { content: 'The company has 50 employees' }
      );
      expect(result.isContradiction).toBe(false);
      expect(result.type).toBe('none');
    });

    it('should not flag free text without negation patterns', () => {
      const result = detectDeterministic(
        { content: 'Revenue increased by 10%' },
        { content: 'Revenue increased by 15%' }
      );
      expect(result.isContradiction).toBe(false);
    });
  });

  // ─── BLOCKED_REQUIREMENT documentation ──────────────────────

  describe('BLOCKED_REQUIREMENT documentation', () => {
    it('should not use AI/LLM or external APIs', () => {
      const detectorSource = detectDeterministic.toString();
      expect(detectorSource).not.toMatch(/openai|anthropic|llm|ai\.|fetch\(|axios/);
    });
  });
});
