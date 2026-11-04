import type { RecoveryJournal } from './backup-recovery-journal-runtime.mjs';
export function recoveryFileImage(target: string): string | null;
export function reconcileRecoveryFiles(journal: RecoveryJournal, targets: Readonly<Record<string, string>>, receipt: 'committed' | 'absent' | 'unknown'): 'complete' | 'aborted' | 'blocked';
export function companyConfigImage(before: string | null, companyId: string, value: Record<string, unknown> | null): string;
