import { describe, it, expect } from 'vitest';
import { validateAccountHolder } from '../../src/lib/validation/account-holder-validator';

describe('validateAccountHolder', () => {
  describe('BUSINESS entity (default)', () => {
    it('should match perfectly equal names', () => {
      const result = validateAccountHolder('LQ & OM LLC', 'LQ & OM LLC');
      expect(result.matches).toBe(true);
      expect(result.requiresApproval).toBe(false);
    });

    it('should match with slight punctuation differences and whitespace variations', () => {
      const result = validateAccountHolder('LQ&OM LLC', 'LQ & OM LLC');
      expect(result.matches).toBe(true);
      expect(result.score).toBeGreaterThanOrEqual(0.85);
      expect(result.requiresApproval).toBe(false);
    });

    it('should match when PDF omits business suffix', () => {
      const result = validateAccountHolder('LQ & OM', 'LQ & OM LLC');
      expect(result.matches).toBe(true);
      expect(result.requiresApproval).toBe(false);
    });

    it('should match when company name omits business suffix', () => {
      const result = validateAccountHolder('LQ & OM LLC', 'LQ & OM');
      expect(result.matches).toBe(true);
      expect(result.requiresApproval).toBe(false);
    });

    it('should require approval for completely different names', () => {
      const result = validateAccountHolder('ANOTHER COMPANY INC', 'LQ & OM LLC');
      expect(result.matches).toBe(false);
      expect(result.score).toBeLessThan(0.5);
      expect(result.requiresApproval).toBe(true);
    });

    it('should match names with different but equivalent suffixes', () => {
      const result = validateAccountHolder('Acme Corp', 'Acme Incorporated');
      expect(result.matches).toBe(true);
      expect(result.requiresApproval).toBe(false);
    });
  });

  describe('INDIVIDUAL entity', () => {
    it('should match same first and last name', () => {
      const result = validateAccountHolder('Juan Perez', 'Juan Perez', 'INDIVIDUAL');
      expect(result.matches).toBe(true);
      expect(result.requiresApproval).toBe(false);
    });

    it('should match with middle name variants', () => {
      const result = validateAccountHolder('Juan Perez', 'Juan Carlos Perez', 'INDIVIDUAL');
      expect(result.matches).toBe(true);
      expect(result.requiresApproval).toBe(false);
    });

    it('should match with reversed name order', () => {
      const result = validateAccountHolder('Perez, Juan', 'Juan Perez', 'INDIVIDUAL');
      expect(result.matches).toBe(true);
      expect(result.requiresApproval).toBe(false);
    });

    it('should require approval for completely different person names', () => {
      const result = validateAccountHolder('Maria Garcia', 'Juan Perez', 'INDIVIDUAL');
      expect(result.matches).toBe(false);
      expect(result.requiresApproval).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('should fallback to require approval on empty values', () => {
      const result = validateAccountHolder('', 'LQ & OM LLC');
      expect(result.matches).toBe(false);
      expect(result.requiresApproval).toBe(true);
    });

    it('should return method info in the result', () => {
      const result = validateAccountHolder('LQ & OM LLC', 'LQ & OM LLC');
      expect(result.method).toBeTruthy();
      expect(result.method).not.toBe('none');
    });
  });
});
