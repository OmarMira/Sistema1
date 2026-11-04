export interface RecoveryJournal {
  operationId: string;
  companyId: string;
  checksum: string;
  maintenanceId?: string;
  logoUrl?: string;
  safetyFilename?: string;
  files: Array<{ key: string; before: string | null; after: string | null }>;
}
export function createRecoveryJournal(root: string, payload: RecoveryJournal): void;
export function readRecoveryJournal(root: string, id: string): RecoveryJournal;
