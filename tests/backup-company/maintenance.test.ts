import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createMaintenanceGate } from '../../src/lib/backup-maintenance.mjs';

const roots: string[] = [];
function fixture() {
  const scratch = path.resolve('tests/backup-company/.scratch');
  fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, 'company-maintenance-'));
  roots.push(root);
  return { root, gate: createMaintenanceGate(path.join(root, 'gate')) };
}
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function gateBytes(root: string): string {
  const walk = (dir: string): string[] => fs.readdirSync(dir).sort().flatMap(name => {
    const file = path.join(dir, name);
    return fs.statSync(file).isDirectory() ? walk(file) :
      [path.relative(root, file) + ':' + createHash('sha256').update(fs.readFileSync(file)).digest('hex')];
  });
  return createHash('sha256').update(JSON.stringify(walk(root))).digest('hex');
}

it('independent: keeps a normal owner valid throughout suspended awaited work', async () => {
  const { gate, root } = fixture();
  const lease = gate.acquireNormalOperation();
  let resume!: () => void;
  const paused = new Promise<void>(resolve => { resume = resolve; });
  const work = lease.run(async () => {
    await paused;
    await gate.withNormalOperation(async () => {
      expect(gate.status()).toEqual({ marked: true, leases: 1 });
    });
  });
  const owner = gate.beginMaintenance();
  try {
    const before = gateBytes(root);
    expect(() => lease.release()).toThrow('Maintenance admission unavailable');
    expect(gateBytes(root)).toBe(before);
    await expect(owner.drain({ timeoutMs: 0 })).rejects.toThrow('Maintenance drain timed out');
    expect(gateBytes(root)).toBe(before);
    expect(gate.status()).toEqual({ marked: true, leases: 1 });
  } finally { resume(); await work; lease.release(); }
  await owner.drain({ timeoutMs: 0 });
  owner.release();
});

it('independent: cannot reopen maintenance during suspended awaited recovery', async () => {
  const { gate, root } = fixture();
  const owner = gate.beginMaintenance();
  await owner.drain({ timeoutMs: 0 });
  let resume!: () => void;
  const paused = new Promise<void>(resolve => { resume = resolve; });
  const work = owner.runRecovery(async () => { await paused; });
  try {
    const before = gateBytes(root);
    expect(() => owner.release()).toThrow('Recovery still running');
    expect(gateBytes(root)).toBe(before);
    await expect(owner.runRecovery(async () => true)).rejects.toThrow('Recovery already running');
    expect(gateBytes(root)).toBe(before);
    expect(() => gate.acquireNormalOperation()).toThrow('Maintenance admission unavailable');
    expect(gateBytes(root)).toBe(before);
    expect(gate.status()).toEqual({ marked: true, leases: 0 });
  } finally { resume(); await work; owner.release(); }
  expect(gate.status()).toEqual({ marked: false, leases: 0 });
});

describe('durable cooperating maintenance boundary', () => {
  it('holds a durable normal lease, permits legitimate nesting, and releases on errors', async () => {
    const { root, gate } = fixture();
    await expect(gate.withNormalOperation(async () => {
      expect(gate.status()).toEqual({ marked: false, leases: 1 });
      await gate.withNormalOperation(async () => expect(gate.status().leases).toBe(1));
      expect(fs.readdirSync(path.join(root, 'gate', 'leases'))).toHaveLength(1);
      throw new Error('handler failed');
    })).rejects.toThrow('handler failed');
    expect(gate.status()).toEqual({ marked: false, leases: 0 });
  });

  it('persists maintenance before draining and grants only the live owner recovery capability', async () => {
    const { gate, root } = fixture();
    const lease = gate.acquireNormalOperation();
    const owner = gate.beginMaintenance();
    let mutations = 0;
    await expect(owner.runRecovery(async () => ++mutations)).rejects.toThrow('not drained');
    expect(mutations).toBe(0);
    expect(() => gate.acquireNormalOperation()).toThrow('Maintenance');
    expect(() => createMaintenanceGate(path.join(root, 'gate')).beginMaintenance()).toThrow('Maintenance');
    await expect(owner.drain({ timeoutMs: 0 })).rejects.toThrow('drain');
    expect(gate.status()).toEqual({ marked: true, leases: 1 });
    lease.release();
    await owner.drain({ timeoutMs: 100 });
    await owner.runRecovery(async () => {
      expect(() => owner.release()).toThrow('running');
      expect(() => gate.acquireNormalOperation()).toThrow('Maintenance');
      ++mutations;
    });
    expect(mutations).toBe(1);
    owner.release();
    await expect(owner.runRecovery(async () => ++mutations)).rejects.toThrow('owner');
    expect(gate.status()).toEqual({ marked: false, leases: 0 });
  });

  it('status is read-only; restart cannot release crashed leases or marked recovery', async () => {
    const { root, gate } = fixture();
    expect(gate.status()).toEqual({ marked: false, leases: 0 });
    expect(fs.existsSync(path.join(root, 'gate'))).toBe(false);
    gate.acquireNormalOperation(); // Simulate a lost owner; never guessed dead from PID/time.
    gate.beginMaintenance();
    const before = fs.readdirSync(path.join(root, 'gate', 'leases'));
    const restarted = createMaintenanceGate(path.join(root, 'gate'));
    expect(restarted.status()).toEqual({ marked: true, leases: 1 });
    expect(() => restarted.acquireNormalOperation()).toThrow('Maintenance');
    expect(() => restarted.beginMaintenance()).toThrow('Maintenance');
    expect(fs.readdirSync(path.join(root, 'gate', 'leases'))).toEqual(before);
  });

  it('double-checks maintenance after publishing its lease before entering normal work', async () => {
    const { root, gate } = fixture();
    let owner: ReturnType<typeof gate.beginMaintenance> | undefined;
    const original = fs.fsyncSync;
    const spy = vi.spyOn(fs, 'fsyncSync').mockImplementation(fd => {
      original(fd);
      if (!owner && fs.existsSync(path.join(root, 'gate', 'leases')) &&
          fs.readdirSync(path.join(root, 'gate', 'leases')).length) {
        spy.mockRestore();
        owner = gate.beginMaintenance();
      }
    });
    let writes = 0;
    try {
      await expect(gate.withNormalOperation(async () => ++writes)).rejects.toThrow('Maintenance');
      expect(writes).toBe(0);
      expect(gate.status()).toEqual({ marked: true, leases: 0 });
      await owner!.drain({ timeoutMs: 0 }); owner!.release();
    } finally { spy.mockRestore(); }
  });

  it('keeps failed recovery marked and never gives inherited normal context to recovery', async () => {
    const { gate } = fixture();
    const owner = gate.beginMaintenance();
    await owner.drain({ timeoutMs: 0 });
    await expect(owner.runRecovery(async () => {
      await expect(gate.withNormalOperation(async () => true)).rejects.toThrow('Maintenance');
      throw new Error('reconciliation required');
    })).rejects.toThrow('reconciliation required');
    expect(gate.status()).toEqual({ marked: true, leases: 0 });
    expect(() => gate.acquireNormalOperation()).toThrow('Maintenance');
    owner.release();
  });

  it.each(['marker', 'lease', 'unavailable'])('fails closed for %s storage without cleanup', async kind => {
    const { root, gate } = fixture();
    const dir = path.join(root, 'gate');
    if (kind === 'unavailable') fs.writeFileSync(dir, 'not a directory');
    else {
      const lease = gate.acquireNormalOperation();
      lease.release();
      fs.writeFileSync(kind === 'marker' ? path.join(dir, 'maintenance.json') : path.join(dir, 'leases', 'broken.json'), '{');
    }
    expect(() => gate.status()).toThrow();
    expect(() => gate.acquireNormalOperation()).toThrow();
    expect(() => gate.beginMaintenance()).toThrow();
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('fresh processes cannot reclaim leases or markers left by an exited owner', async () => {
    const { root, gate } = fixture();
    const moduleUrl = new URL('../../src/lib/backup-maintenance.mjs', import.meta.url).href;
    const code = `import { createMaintenanceGate } from ${JSON.stringify(moduleUrl)};
      const gate = createMaintenanceGate(process.argv[1]);
      gate.acquireNormalOperation(); gate.beginMaintenance();
      process.stdout.write('OWNER_EXIT_WITHOUT_RELEASE\\n');`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', code, path.join(root, 'gate')], {
      env: {}, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', text => { stdout += text; });
    child.stderr.on('data', text => { stderr += text; });
    const closed = new Promise<number | null>(resolve => child.once('close', resolve));
    const timer = setTimeout(() => child.kill(), 3000);
    try {
      expect(await closed).toBe(0);
      expect(stdout).toBe('OWNER_EXIT_WITHOUT_RELEASE\n'); expect(stderr).toBe('');
      expect(gate.status()).toEqual({ marked: true, leases: 1 });
      expect(() => gate.acquireNormalOperation()).toThrow('Maintenance');
      expect(() => gate.beginMaintenance()).toThrow('Maintenance');
      expect(gate.status()).toEqual({ marked: true, leases: 1 });
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null) { child.kill(); await closed; }
    }
  });

  it('two real Node processes fence late admissions and drain existing work', async () => {
    const { root, gate } = fixture();
    const moduleUrl = new URL('../../src/lib/backup-maintenance.mjs', import.meta.url).href;
    const code = `import { createMaintenanceGate } from ${JSON.stringify(moduleUrl)};
      const gate = createMaintenanceGate(process.argv[1]);
      const lease = gate.acquireNormalOperation();
      process.stdout.write('LEASED\\n');
      process.stdin.once('data', () => {
        try { gate.acquireNormalOperation(); process.exitCode = 2; }
        catch (error) { process.stdout.write(error.code + '\\n'); }
        lease.release(); process.stdin.destroy();
      });
      setTimeout(() => { process.stderr.write('worker timeout'); process.exit(3); }, 3000).unref();`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', code, path.join(root, 'gate')], {
      env: {}, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', text => { stdout += text; });
    child.stderr.on('data', text => { stderr += text; });
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject); child.once('exit', resolve);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('worker readiness timeout')), 2000);
        child.stdout.on('data', () => { if (stdout.includes('LEASED\n')) { clearTimeout(timer); resolve(); } });
      });
      const owner = gate.beginMaintenance();
      let changed = false;
      await expect(owner.runRecovery(async () => { changed = true; })).rejects.toThrow('not drained');
      expect(changed).toBe(false);
      child.stdin.end('release');
      expect(await exited).toBe(0);
      expect(stdout).toBe('LEASED\nBACKUP_MAINTENANCE\n');
      expect(stderr).toBe('');
      await owner.drain({ timeoutMs: 100 });
      await owner.runRecovery(async () => { changed = true; });
      expect(changed).toBe(true);
      owner.release();
    } finally {
      if (child.exitCode === null) { child.kill(); await exited; }
    }
  });
});
