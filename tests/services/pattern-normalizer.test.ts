import { describe, it, expect } from 'vitest';
import {
  normalizePattern,
  sanitizeDescriptionForDetection,
  sanitizeDescriptionForAdaptive,
} from '@/lib/services/pattern-normalizer';

describe('Pattern Normalizer Service', () => {
  describe('normalizePattern', () => {
    it('should convert to lowercase and trim', () => {
      expect(normalizePattern('  TEST PATTERN  ')).toBe('test pattern');
    });

    it('should strip common transaction prefixes', () => {
      expect(normalizePattern('Zelle payment to John Doe')).toBe('john doe');
      expect(normalizePattern('Payment from Jane Doe')).toBe('jane doe');
      expect(normalizePattern('zelle transfer to Company A')).toBe('company a');
      expect(normalizePattern('check to Vendor B')).toBe('vendor b');
      expect(normalizePattern('withdrawal from account')).toBe('account');
      expect(normalizePattern('deposit to fund')).toBe('fund');
    });

    it('should strip common transaction suffixes', () => {
      expect(normalizePattern('Vendor C conf# 12345')).toBe('vendor c');
      expect(normalizePattern('Vendor D for "services rendered"')).toBe('vendor d');
      expect(normalizePattern('Vendor E; conf# abc987')).toBe('vendor e');
    });

    it('should normalize patterns with generic metadata (DES:/ID:/INDN:)', () => {
      expect(normalizePattern('raiser 12345 des:edi paymnt id:999-888 indn:some')).toBe(
        'raiser 12345 some',
      );
      expect(normalizePattern('lyft.com des:lyft 12-34 id:abc-123 indn:driver')).toBe(
        'lyft.com driver',
      );
    });
  });

  describe('sanitizeDescriptionForDetection', () => {
    it('should apply configured regex patterns to strip noise', () => {
      const config = {
        sanitization: {
          stripPatterns: [
            { name: 'digits', regex: '\\d+', replacement: '' },
            { name: 'zelle', regex: '^zelle\\s+from\\s+', replacement: '', flags: 'i' },
          ],
        },
      };
      expect(sanitizeDescriptionForDetection('Zelle from Vendor 12345', config)).toBe('Vendor');
    });
  });

  describe('sanitizeDescriptionForAdaptive', () => {
    it('should apply noise filters and remove stop words', () => {
      const config = {
        sanitizeNoise: {
          digits: '\\d+',
        },
        patternGeneration: {
          ignoreStopWords: ['from', 'the', 'to'],
        },
      };
      expect(sanitizeDescriptionForAdaptive('Zelle from the Vendor 999', config)).toBe('zelle vendor');
    });
  });
});
