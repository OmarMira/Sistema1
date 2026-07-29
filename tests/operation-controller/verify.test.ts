import { describe, it, expect } from 'vitest';
import { verify } from '../../src/internal/operation-controller/verify';
import type { ExecutionContract, Operation } from '../../src/internal/operation-controller/types';

function makeContract(operation: Operation, target: string, expectedState?: Record<string, string>): ExecutionContract {
  return {
    intentId: 'test-intent',
    resourceType: 'file',
    operation,
    target,
    allowedEffects: [],
    forbiddenEffects: [],
    budget: { maxChanges: 1 },
    expectedState: expectedState ?? {},
  };
}

describe('verify', () => {
  it('modify exitoso', () => {
    const r = verify(makeContract('modify', 'a.txt', { 'a.txt': 'new' }), { 'a.txt': 'old', 'b.txt': 'stable' }, { 'a.txt': 'new', 'b.txt': 'stable' });
    expect(r.passed).toBe(true);
  });

  it('create exitoso', () => {
    const r = verify(makeContract('create', 'a.txt', { 'a.txt': 'content' }), { 'b.txt': 'stable' }, { 'b.txt': 'stable', 'a.txt': 'content' });
    expect(r.passed).toBe(true);
  });

  it('delete exitoso', () => {
    const r = verify(makeContract('delete', 'a.txt'), { 'a.txt': 'old', 'b.txt': 'stable' }, { 'b.txt': 'stable' });
    expect(r.passed).toBe(true);
  });

  it('read exitoso', () => {
    const r = verify(makeContract('read', 'a.txt'), { 'a.txt': 'data', 'b.txt': 'stable' }, { 'a.txt': 'data', 'b.txt': 'stable' });
    expect(r.passed).toBe(true);
  });

  it('modify con mutacion lateral falla', () => {
    const r = verify(makeContract('modify', 'a.txt', { 'a.txt': 'new' }), { 'a.txt': 'old', 'b.txt': 'stable' }, { 'a.txt': 'new', 'b.txt': 'changed' });
    expect(r.passed).toBe(false);
    expect(r.reason).toBe('lateral_mutation');
  });

  it('delete con archivo nuevo lateral falla', () => {
    const r = verify(makeContract('delete', 'a.txt'), { 'a.txt': 'old' }, { 'c.txt': 'new' });
    expect(r.passed).toBe(false);
    expect(r.reason).toBe('lateral_mutation');
  });

  it('create sin expectedState falla', () => {
    const r = verify(makeContract('create', 'a.txt'), {}, { 'a.txt': 'x' });
    expect(r.passed).toBe(false);
    expect(r.reason).toBe('expected_state_missing');
  });

  it('modify sin target despues falla', () => {
    const r = verify(makeContract('modify', 'a.txt', { 'a.txt': 'new' }), { 'a.txt': 'old' }, {});
    expect(r.passed).toBe(false);
    expect(r.reason).toBe('target_deleted_instead');
  });

  it('create sobre target existente falla', () => {
    const r = verify(makeContract('create', 'a.txt', { 'a.txt': 'new' }), { 'a.txt': 'old' }, { 'a.txt': 'new' });
    expect(r.passed).toBe(false);
    expect(r.reason).toBe('target_already_existed');
  });

  it('modify sobre target inexistente falla', () => {
    const r = verify(makeContract('modify', 'a.txt', { 'a.txt': 'new' }), {}, { 'a.txt': 'new' });
    expect(r.passed).toBe(false);
    expect(r.reason).toBe('target_did_not_exist');
  });

  it('delete sobre target inexistente falla', () => {
    const r = verify(makeContract('delete', 'a.txt'), {}, {});
    expect(r.passed).toBe(false);
    expect(r.reason).toBe('target_did_not_exist');
  });

  it('execute lanza unsupported_operation', () => {
    const r = verify(makeContract('execute', 'a.txt'), {}, {});
    expect(r.passed).toBe(false);
    expect(r.reason).toBe('unsupported_operation');
  });

  it('normaliza rutas con backslash', () => {
    const r = verify(makeContract('modify', 'dir\\file.txt', { 'dir\\file.txt': 'new' }), { 'dir/file.txt': 'old' }, { 'dir/file.txt': 'new' });
    expect(r.passed).toBe(true);
  });
});