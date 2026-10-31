import type { RecoveryJournal } from './backup-recovery-journal-runtime.mjs';
export function recoveryReceiptEvidence(journal: RecoveryJournal, receipt: { id: string; companyId: string | null; action: string; details: string | null } | null): 'committed' | 'absent' | 'unknown';
