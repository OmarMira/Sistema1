import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { createMaintenanceGate } from '@/lib/backup-maintenance.mjs';

it('never admits normal work during competing resumed recovery', async () => {
  const root = path.resolve('tests/backup-company/.scratch/release-race-' + crypto.randomUUID());
  const gate = createMaintenanceGate(root);
  const owner = gate.beginMaintenance();
  await owner.drain({ timeoutMs: 0 });
  const resumed = gate.resumeMaintenance(owner.id);
  await resumed.drain({ timeoutMs: 0 });
  const unlink = fs.unlinkSync;
  let finish!: () => void;
  let work: Promise<unknown> | undefined;
  const spy = vi.spyOn(fs, 'unlinkSync').mockImplementation(target => {
    if (target === path.join(root, 'maintenance.json')) {
      spy.mockRestore();
      work = resumed.runRecovery(() => new Promise<void>(resolve => { finish = resolve; }));
    }
    return unlink(target);
  });
  try {
    try { owner.release(); } catch { /* Refusing release is safe. */ }
    if (finish) {
      expect(gate.status().marked).toBe(true);
      expect(() => gate.acquireNormalOperation()).toThrow();
    } else if (work) {
      await expect(work).rejects.toThrow();
      work = undefined;
    } else {
      expect(gate.status().marked).toBe(true);
    }
  } finally { spy.mockRestore(); finish?.(); await work; }
});
