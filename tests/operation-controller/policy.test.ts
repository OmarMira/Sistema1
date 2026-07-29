import { describe, it, expect } from 'vitest';
import { evaluatePolicy } from '../../src/internal/operation-controller/policy';
import type { Intent, Capability } from '../../src/internal/operation-controller/types';

const baseIntent: Intent = {
  id: 'int-1',
  requester: 'ai-agent',
  target: '/src/main.ts',
  resourceType: 'file',
  operation: 'modify',
  effects: ['modify'],
};

const capability: Capability = {
  requester: 'ai-agent',
  resourceType: 'file',
  operation: 'modify',
  mode: 'granted',
};

describe('evaluatePolicy', () => {
  it('denied when no capability matches', () => {
    const result = evaluatePolicy(baseIntent, []);
    expect(result.mode).toBe('denied');
    expect(result.reason).toBeDefined();
  });

  it('granted when capability matches', () => {
    const result = evaluatePolicy(baseIntent, [capability]);
    expect(result.mode).toBe('granted');
  });

  it('requires-approval when capability specifies it', () => {
    const result = evaluatePolicy(baseIntent, [{ ...capability, mode: 'requires-approval' }]);
    expect(result.mode).toBe('requires-approval');
  });

  it('requires-dual when capability specifies it', () => {
    const result = evaluatePolicy(baseIntent, [{ ...capability, mode: 'requires-dual' }]);
    expect(result.mode).toBe('requires-dual');
  });

  it('accepts duplicated capabilities with the same mode', () => {
    const result = evaluatePolicy(baseIntent, [
      capability,
      { ...capability },
    ]);
    expect(result.mode).toBe('granted');
  });

  it('denied when multiple capabilities conflict', () => {
    const result = evaluatePolicy(baseIntent, [
      { ...capability, mode: 'granted' },
      { ...capability, mode: 'denied' },
    ]);
    expect(result.mode).toBe('denied');
    expect(result.reason).toContain('Ambiguous');
  });

  it('does not match different requester, resource, or operation', () => {
    const wrongRequester = evaluatePolicy({ ...baseIntent, requester: 'other' }, [capability]);
    expect(wrongRequester.mode).toBe('denied');

    const wrongResource = evaluatePolicy({ ...baseIntent, resourceType: 'git' }, [capability]);
    expect(wrongResource.mode).toBe('denied');

    const wrongOp = evaluatePolicy({ ...baseIntent, operation: 'delete' }, [capability]);
    expect(wrongOp.mode).toBe('denied');
  });
});