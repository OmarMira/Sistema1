import { describe, it, expect } from 'vitest';

describe('Network barrier (setup.ts)', () => {
  it('blocks unmocked fetch with [NETWORK BARRIER] error', () => {
    expect(() => fetch('https://example.invalid')).toThrow('[NETWORK BARRIER]');
  });

  it('blocks unmocked fetch with Request object', () => {
    const req = new Request('https://example.invalid');
    expect(() => fetch(req)).toThrow('[NETWORK BARRIER]');
  });
});
