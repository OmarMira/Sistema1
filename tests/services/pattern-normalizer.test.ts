import { describe, it, expect } from 'vitest';
import { normalizePattern } from '@/lib/services/pattern-normalizer';

describe('Pattern Normalizer Service', () => {
  describe('normalizePattern', () => {
    it('should convert to lowercase and trim', () => {
      expect(normalizePattern('  TEST PATTERN  ')).toBe('test pattern');
    });

    it('should collapse multiple whitespace characters', () => {
      expect(normalizePattern('hello   world')).toBe('hello world');
      expect(normalizePattern('a\t\nb')).toBe('a b');
    });

    it('should strip ASCII punctuation', () => {
      expect(normalizePattern('Vendor, LLC.')).toBe('vendor llc');
      expect(normalizePattern('foo, bar')).toBe('foo bar');
      expect(normalizePattern('a; b! c? d')).toBe('a b c d');
    });

    it('should preserve & and # characters', () => {
      expect(normalizePattern('LQ&OM')).toBe('lq&om');
      expect(normalizePattern('conf# 12345')).toBe('conf# 12345');
    });

    it('should NOT strip transaction prefixes', () => {
      expect(normalizePattern('Zelle payment to John Doe')).toBe('zelle payment to john doe');
      expect(normalizePattern('Payment from Jane Doe')).toBe('payment from jane doe');
    });

    it('should NOT strip metadata tags like DES:/ID:/INDN:', () => {
      expect(normalizePattern('raiser 12345 des:edi paymnt id:999-888 indn:some')).toBe(
        'raiser 12345 desedi paymnt id999888 indnsome',
      );
      expect(normalizePattern('lyft.com des:lyft 12-34 id:abc-123 indn:driver')).toBe(
        'lyftcom deslyft 1234 idabc123 indndriver',
      );
    });
  });
});
