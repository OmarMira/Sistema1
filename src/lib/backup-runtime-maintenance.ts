if (typeof process === 'undefined' || !process.versions?.node) {
  throw new Error('backup-runtime-maintenance.ts requires Node.js runtime (not Edge)');
}
import path from 'node:path';
import { RUNTIME_DIR } from './config/paths';
import { createMaintenanceGate } from './backup-maintenance.mjs';
import { pruneBackups, type BackupPruneResult } from './backup-storage';
import { logger } from './logger';

// Runtime facade has a distinct basename from the plain-Node .mjs implementation.
// Construction performs no storage access; every process uses the same root.
const gate = createMaintenanceGate(path.join(RUNTIME_DIR, 'backup-maintenance'));
export const acquireNormalOperation = () => gate.acquireNormalOperation();
export const withNormalOperation: typeof gate.withNormalOperation = fn => gate.withNormalOperation(fn);
export const withRuntimeOperation: typeof gate.withRuntimeOperation = fn => gate.withRuntimeOperation(fn);
export const withRuntimeOperationSync: typeof gate.withRuntimeOperationSync = fn => gate.withRuntimeOperationSync(fn);
export const maintenanceStatus = () => gate.status();
export const beginMaintenance = () => gate.beginMaintenance();

/**
 * S6 — backup retention inside the existing maintenance cycle.
 *
 * This is the audited retention entry point: it runs under the same maintenance
 * admission the rest of the runtime maintenance work (session cleanup, etc.)
 * uses, applies `pruneBackups()` and records one `BACKUP_PRUNED` audit row per
 * company whose files were removed, with the filenames in the details. The
 * storage layer also prunes opportunistically at publish time (see
 * `publishBackup`) so disk growth is bounded even between cycle runs; that path
 * cannot write audit rows because it runs synchronously inside the publish
 * critical section, which is why the audit lives here.
 *
 * `@/lib/audit` is imported lazily: this facade must stay importable from
 * plain-Node/operator contexts and from tests that never touch a database.
 */
export async function runBackupRetention(): Promise<BackupPruneResult> {
  return gate.withRuntimeOperation(async () => {
    const result = pruneBackups();
    if (!result.pruned.length) return result;
    const { createAuditLogWithRetry } = await import('@/lib/audit');
    const byCompany = new Map<string, string[]>();
    for (const entry of result.pruned) {
      const filenames = byCompany.get(entry.companyId);
      if (filenames) filenames.push(entry.filename);
      else byCompany.set(entry.companyId, [entry.filename]);
    }
    for (const [companyId, filenames] of byCompany) {
      try {
        await createAuditLogWithRetry({
          companyId,
          userId: null,
          action: 'BACKUP_PRUNED',
          entity: 'Backup',
          details: JSON.stringify({
            contractVersion: 1,
            reason: 'retention',
            filenames,
            count: filenames.length,
            policy: result.policy,
          }),
        });
      } catch (error) {
        // Files are already gone; a failed audit row must not abort the cycle.
        logger.error('BACKUP_PRUNED_AUDIT_ERROR', { companyId, error: String(error) });
      }
    }
    return result;
  });
}
