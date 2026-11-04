import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { expect, it } from 'vitest';
import { createMaintenanceGate } from '@/lib/backup-maintenance.mjs';

it('resumes only the exact maintenance identity and serializes recovery owners', async () => {
  const root = path.resolve('tests/backup-company/.scratch/resume-' + crypto.randomUUID());
  const first = createMaintenanceGate(root);
  const owner = first.beginMaintenance();
  await owner.drain({ timeoutMs: 0 });
  const second = createMaintenanceGate(root);
  expect(() => second.resumeMaintenance(crypto.randomUUID())).toThrow();
  const resumed = second.resumeMaintenance(owner.id);
  await resumed.drain({ timeoutMs: 0 });
  let finish!: () => void;
  const work = owner.runRecovery(() => new Promise<void>(resolve => { finish = resolve; }));
  await expect(resumed.runRecovery(async () => {})).rejects.toThrow();
  expect(() => resumed.release()).toThrow();
  finish(); await work;
  await resumed.runRecovery(async () => expect(second.status()).toEqual({ marked: true, leases: 0 }));
  resumed.release();
  expect(first.status()).toEqual({ marked: false, leases: 0 });
  await expect(owner.runRecovery(async () => {})).rejects.toThrow();
});
