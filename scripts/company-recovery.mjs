#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createMaintenanceGate, configuredDataRoot, runtimeDirectory } from '../src/lib/backup-maintenance.mjs';
import { readRecoveryJournal } from '../src/lib/backup-recovery-journal-runtime.mjs';
import { recoveryFileImage, reconcileRecoveryFiles } from '../src/lib/backup-recovery-files-runtime.mjs';
import { resolveCompanyLogoTarget } from '../src/lib/backup-logo-target.mjs';
import { recoveryReceiptEvidence } from '../src/lib/backup-recovery-receipt.mjs';

const help = `Company recovery operator (run only with all application/recovery processes stopped)

node scripts/company-recovery.mjs inspect --operation <uuid>
node scripts/company-recovery.mjs release-lock --operation <uuid> --maintenance-id <uuid> --lock-sha256 <sha256|absent> --confirm-stopped
node scripts/company-recovery.mjs reconcile --operation <uuid> --maintenance-id <uuid> --lock-sha256 <sha256|absent> --confirm-stopped

inspect is read-only and never connects to a database. The other commands require
explicit offline confirmation and the exact identity/digest reported by inspect.
release-lock removes only a matching recovery lock; maintenance stays closed.
reconcile uses the explicit DATABASE_URL environment setting, serializes with the
restore transaction, and completes/undoes recorded files from its DB receipt.
Set ACCOUNTEXPRESS_DATA_DIR to the installation data root when applicable.
No command deletes the journal, safety backup, maintenance leases or other data.
Never clear a lock while its owner might still be running.
`;
const fail = message => { throw new Error(`RECOVERY_OPERATOR: ${message}`); };
function argumentsFor(argv) {
  if (argv.length === 0 || (argv.length === 1 && argv[0] === '--help')) return { help: true };
  const [command, ...args] = argv;
  if (!['inspect', 'release-lock', 'reconcile'].includes(command)) fail('unknown command');
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!['--operation', '--maintenance-id', '--lock-sha256', '--confirm-stopped'].includes(key) || Object.hasOwn(options, key)) fail('unknown or duplicate option');
    if (key === '--confirm-stopped') options[key] = true;
    else { const value = args[++i]; if (!value || value.startsWith('--')) fail(`value required for ${key}`); options[key] = value; }
  }
  if (!options['--operation']) fail('--operation is required');
  if (command !== 'inspect' && !options['--confirm-stopped']) fail('--confirm-stopped is required');
  return { command, options };
}
async function main() {
  const parsed = argumentsFor(process.argv.slice(2));
  if (parsed.help) { process.stdout.write(help); return; }
  const { command, options } = parsed;
  const runtime = runtimeDirectory();
  const journal = readRecoveryJournal(path.join(runtime, 'backup-recovery'), options['--operation']);
  if (!journal.maintenanceId) fail('journal has no maintenance identity');
  const root = path.join(runtime, 'backup-maintenance');
  const gate = createMaintenanceGate(root);
  const lockPath = path.join(root, 'recovery.json');
  const lockImage = recoveryFileImage(lockPath);
  const lockHash = lockImage === null ? 'absent' : crypto.createHash('sha256').update(Buffer.from(lockImage, 'base64')).digest('hex');
  if (command === 'inspect') {
    console.log(JSON.stringify({ operationId: journal.operationId, companyId: journal.companyId,
      maintenanceId: journal.maintenanceId, checksum: journal.checksum,
      safetyFilename: journal.safetyFilename ?? null, recoveryLockSha256: lockHash,
      maintenance: gate.status(), fileKeys: journal.files.map(file => file.key) }));
    return;
  }
  if (options['--maintenance-id'] !== journal.maintenanceId) fail('maintenance identity mismatch');
  if (options['--lock-sha256'] !== lockHash) fail('recovery lock digest mismatch');
  const status = gate.status();
  if (!status.marked || status.leases !== 0) fail('maintenance must be marked and drained');
  const owner = gate.resumeMaintenance(journal.maintenanceId);
  if (command === 'reconcile' && !process.env.DATABASE_URL?.trim()) fail('explicit DATABASE_URL is required');
  if (lockImage !== null) {
    const lock = JSON.parse(Buffer.from(lockImage, 'base64').toString('utf8'));
    if (lock.version !== 1 || lock.kind !== 'recovery' || lock.id !== journal.maintenanceId || Object.keys(lock).length !== 3) fail('recovery lock identity mismatch');
    // The offline assertion is a human/operator precondition, not a liveness
    // heuristic. Recheck both generations immediately before disposing the lock.
    if (recoveryFileImage(lockPath) !== lockImage || gate.status().leases !== 0) fail('recovery ownership changed');
    gate.resumeMaintenance(journal.maintenanceId);
    fs.unlinkSync(lockPath);
  }
  if (command === 'release-lock') {
    console.log(JSON.stringify({ status: 'lock-released-maintenance-closed', operationId: journal.operationId }));
    return;
  }
  await owner.drain({ timeoutMs: 0 });
  const { PrismaClient, Prisma } = await import('@prisma/client');
  const database = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
  try {
    const outcome = await owner.runRecovery(async () => {
      const evidence = await database.$transaction(async tx => {
        await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
        await tx.$queryRaw(Prisma.sql`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${journal.companyId}, 729104))`);
        return recoveryReceiptEvidence(journal, await tx.auditLog.findUnique({ where: { id: journal.operationId } }));
      }, { isolationLevel: 'ReadCommitted', maxWait: 5000, timeout: 20000 });
      const targets = { 'company-config': path.join(runtime, 'company-config.json') };
      if (journal.logoUrl) {
        let directory = 'public/uploads/logos';
        const configPath = path.join(process.cwd(), 'rules', 'upload-config.json');
        if (fs.existsSync(configPath)) {
          const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
          if (typeof config?.logo?.path !== 'string') fail('invalid logo storage configuration');
          directory = config.logo.path;
        }
        targets['company-logo'] = resolveCompanyLogoTarget(journal.logoUrl, configuredDataRoot(), directory);
      }
      return reconcileRecoveryFiles(journal, targets, evidence);
    });
    if (outcome === 'blocked') fail('receipt or file generations could not be verified; maintenance stays closed');
    owner.release();
    console.log(JSON.stringify({ status: outcome === 'complete' ? 'committed' : 'aborted', operationId: journal.operationId }));
  } finally { await database.$disconnect(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
