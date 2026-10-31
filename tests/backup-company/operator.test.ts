import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { createMaintenanceGate } from '@/lib/backup-maintenance.mjs';
import { createRecoveryJournal } from '@/lib/backup-recovery-journal';

it('requires exact offline confirmation and lock identity, then clears only that lock', async () => {
  const root = path.resolve('tests/backup-company/.scratch/operator-' + crypto.randomUUID());
  const program = path.join(root, 'program'), data = path.join(root, 'data');
  fs.mkdirSync(program, { recursive: true });
  const gateRoot = path.join(data, 'config', 'backup-maintenance');
  const gate = createMaintenanceGate(gateRoot), owner = gate.beginMaintenance();
  await owner.drain({ timeoutMs: 0 });
  const operationId = crypto.randomUUID();
  const journalRoot = path.join(data, 'config', 'backup-recovery');
  createRecoveryJournal(journalRoot, { operationId, companyId: 'tenant', maintenanceId: owner.id, checksum: 'a'.repeat(64), files: [] });
  const lock = path.join(gateRoot, 'recovery.json');
  fs.writeFileSync(lock, JSON.stringify({ version: 1, kind: 'recovery', id: owner.id }));
  const digest = crypto.createHash('sha256').update(fs.readFileSync(lock)).digest('hex');
  const journal = fs.readFileSync(path.join(journalRoot, operationId + '.json'));
  const script = path.resolve('scripts/company-recovery.mjs');
  const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { cwd: program, env: { ...process.env, ACCOUNTEXPRESS_DATA_DIR: data }, encoding: 'utf8', timeout: 5000 });
  const inspection = run('inspect', '--operation', operationId);
  expect(inspection.status).toBe(0); expect(inspection.stderr).toBe('');
  expect(JSON.parse(inspection.stdout)).toMatchObject({ operationId, companyId: 'tenant', maintenanceId: owner.id, recoveryLockSha256: digest });
  const rejected = run('release-lock', '--operation', operationId, '--maintenance-id', owner.id, '--lock-sha256', digest);
  expect(rejected.status).toBe(1); expect(rejected.stdout).toBe('');
  expect(rejected.stderr.trim()).toBe('RECOVERY_OPERATOR: --confirm-stopped is required');
  expect(crypto.createHash('sha256').update(fs.readFileSync(lock)).digest('hex')).toBe(digest);
  for (const [maintenanceId, lockDigest, message] of [
    [crypto.randomUUID(), digest, 'maintenance identity mismatch'],
    [owner.id, '0'.repeat(64), 'recovery lock digest mismatch'],
  ]) {
    const denied = run('release-lock', '--operation', operationId, '--maintenance-id', maintenanceId, '--lock-sha256', lockDigest, '--confirm-stopped');
    expect(denied.status).toBe(1); expect(denied.stdout).toBe('');
    expect(denied.stderr.trim()).toBe('RECOVERY_OPERATOR: ' + message);
    expect(crypto.createHash('sha256').update(fs.readFileSync(lock)).digest('hex')).toBe(digest);
    expect(fs.readFileSync(path.join(journalRoot, operationId + '.json'))).toEqual(journal);
    expect(gate.status()).toEqual({ marked: true, leases: 0 });
  }
  const accepted = run('release-lock', '--operation', operationId, '--maintenance-id', owner.id, '--lock-sha256', digest, '--confirm-stopped');
  expect(accepted.status).toBe(0); expect(accepted.stderr).toBe('');
  expect(JSON.parse(accepted.stdout).status).toBe('lock-released-maintenance-closed');
  expect(fs.existsSync(lock)).toBe(false); expect(gate.status()).toEqual({ marked: true, leases: 0 });
  expect(fs.readFileSync(path.join(journalRoot, operationId + '.json'))).toEqual(journal);
});
