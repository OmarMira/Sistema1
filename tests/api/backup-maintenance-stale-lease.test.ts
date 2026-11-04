import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMaintenanceGate } from '@/lib/backup-maintenance.mjs';
import { RUNTIME_DIR } from '@/lib/config/paths';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'fs';
import path from 'path';

const ROOT = path.join(RUNTIME_DIR, 'backup-maintenance');
const LEASES = path.join(ROOT, 'leases');

function writeLease(id: string, record: Record<string, unknown>) {
  const fd = fs.openSync(path.join(LEASES, `${id}.json`), 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(record), 'utf8'); } finally { fs.closeSync(fd); }
}

function deadPid(): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
    child.on('exit', () => resolve(child.pid!));
  });
}

describe('maintenance gate reaps dead-process normal leases', () => {
  beforeEach(() => {
    fs.rmSync(ROOT, { recursive: true, force: true });
    fs.mkdirSync(LEASES, { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(ROOT, { recursive: true, force: true });
  });

  it('drains a transition when the only blocking lease belongs to a dead process', async () => {
    const pid = await deadPid();
    writeLease(crypto.randomUUID(), { version: 1, kind: 'normal', id: undefined, pid } as Record<string, unknown>);
    // Fix the id to match the filename (same contract as writeRecord).
    const name = fs.readdirSync(LEASES)[0];
    const record = JSON.parse(fs.readFileSync(path.join(LEASES, name), 'utf8'));
    record.id = name.slice(0, -5);
    fs.writeFileSync(path.join(LEASES, name), JSON.stringify(record), 'utf8');

    const gate = createMaintenanceGate(ROOT);
    const owner = gate.beginMaintenance();
    // Before the reaping fix this threw 'Maintenance drain timed out': the
    // dead process's lease file blocked the transition forever.
    await owner.drain({ timeoutMs: 2000 });
    owner.release();
    expect(fs.existsSync(path.join(ROOT, 'maintenance.json'))).toBe(false);
    // The dead lease file is reaped, not merely ignored.
    expect(fs.readdirSync(LEASES)).toHaveLength(0);
  });

  it('still blocks while a live process holds a normal lease', async () => {
    const gate = createMaintenanceGate(ROOT);
    const lease = gate.acquireNormalOperation();
    const owner = gate.beginMaintenance();
    // A live holder keeps the drain from completing.
    await expect(owner.drain({ timeoutMs: 50 })).rejects.toThrow();
    lease.release();
    // Once the holder releases, the transition drains and closes cleanly.
    await owner.drain({ timeoutMs: 2000 });
    owner.release();
    expect(fs.existsSync(path.join(ROOT, 'maintenance.json'))).toBe(false);
  });
});
