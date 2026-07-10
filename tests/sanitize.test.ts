import { describe, it, expect, vi } from 'vitest';
import sanitizeHtml from 'sanitize-html';
import { sanitizeInput } from '@/lib/sanitize';

vi.mock('sanitize-html', () => ({
  default: vi.fn((value: string) => {
    // Simple HTML tag stripper that mimics sanitize-html with allowedTags: []
    return value.replace(/<\/?[^>]+(>|$)/g, '');
  }),
}));

describe('sanitizeInput', () => {
  it('strips simple HTML tags', () => {
    expect(sanitizeInput('<b>hello</b>')).toBe('hello');
  });

  it('strips script tags', () => {
    expect(sanitizeInput('<script>alert("xss")</script>')).toBe('');
  });

  it('strips nested tags', () => {
    expect(sanitizeInput('<div><p>text</p></div>')).toBe('text');
  });

  it('preserves text without HTML', () => {
    expect(sanitizeInput('hello world')).toBe('hello world');
  });

  it('preserves special characters', () => {
    expect(sanitizeInput('price: $19.99 (tax) & fees')).toBe('price: $19.99 (tax) & fees');
  });

  it('preserves quotes and apostrophes', () => {
    expect(sanitizeInput("it's a \"test\"")).toBe("it's a \"test\"");
  });

  it('returns empty string for empty input', () => {
    expect(sanitizeInput('')).toBe('');
  });

  it('returns empty string for string with only tags', () => {
    expect(sanitizeInput('<br/><hr/>')).toBe('');
  });

  it('strips tags with attributes', () => {
    expect(sanitizeInput('<a href="http://evil.com">click</a>')).toBe('click');
  });

  it('strips self-closing tags', () => {
    expect(sanitizeInput('line1<br/>line2')).toBe('line1line2');
  });

  it('handles multiple lines', () => {
    expect(sanitizeInput('line1\nline2')).toBe('line1\nline2');
  });

  it('preserves text with numbers and symbols', () => {
    expect(sanitizeInput('Ref #12345 (due 05/15)')).toBe('Ref #12345 (due 05/15)');
  });
});
