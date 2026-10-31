import { expect, it } from 'vitest';
import { recoveryDecision } from '@/lib/backup-recovery-decision';

it('keeps ambiguous DB outcomes fenced instead of replaying files', () => {
  expect(recoveryDecision('unknown', 'before')).toBe('blocked');
  expect(recoveryDecision('unknown', 'after')).toBe('blocked');
  expect(recoveryDecision('unknown', 'diverged')).toBe('blocked');
});
it('uses commit evidence and exact file generation before deciding reconciliation', () => {
  expect(recoveryDecision('committed', 'before')).toBe('apply-after');
  expect(recoveryDecision('committed', 'after')).toBe('complete');
  expect(recoveryDecision('absent', 'before')).toBe('aborted');
  expect(recoveryDecision('absent', 'after')).toBe('apply-before');
  expect(recoveryDecision('committed', 'diverged')).toBe('blocked');
  expect(recoveryDecision('absent', 'diverged')).toBe('blocked');
});
