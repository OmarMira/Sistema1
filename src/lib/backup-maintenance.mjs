import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';

const normalContext = new AsyncLocalStorage();
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const missing = error => error?.code === 'ENOENT';

export class MaintenanceAdmissionError extends Error {
  statusCode = 503;
  code = 'BACKUP_MAINTENANCE';
  constructor(message = 'Maintenance admission unavailable', cause) {
    super(message, { cause });
  }
}

// Storage is trusted against hostile local replacement. Still refuse links and
// unexpected types instead of silently following a configured junction/symlink.
function inspect(target, directory) {
  const parent = path.dirname(target);
  if (parent !== target) inspect(parent, true);
  let stat;
  try { stat = fs.lstatSync(target); }
  catch (error) { if (missing(error)) return false; throw error; }
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) {
    throw new Error('Invalid maintenance storage type');
  }
  return true;
}

function readRecord(target, kind, id) {
  if (!inspect(target, false)) return null;
  let value;
  try { value = JSON.parse(fs.readFileSync(target, 'utf8')); }
  catch (error) { if (missing(error)) return null; throw error; }
  if (value?.version !== 1 || value.kind !== kind || !uuid.test(value.id) ||
      (id !== undefined && value.id !== id) || Object.keys(value).length !== 3) {
    throw new Error('Corrupt maintenance record');
  }
  return value;
}

function writeRecord(target, record) {
  // Never remove a partial record on failure: ambiguity must remain blocking.
  const fd = fs.openSync(target, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(record), 'utf8'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}

/** One shared root for every cooperating process; construction is read/write-free. */
export function createMaintenanceGate(storageRoot) {
  if (typeof storageRoot !== 'string' || !path.isAbsolute(storageRoot)) {
    throw new TypeError('Maintenance root must be absolute');
  }
  const root = path.resolve(storageRoot);
  const leasesDir = path.join(root, 'leases');
  const marker = path.join(root, 'maintenance.json');
  function guarded(fn) {
    try { return fn(); }
    catch (error) {
      if (error instanceof MaintenanceAdmissionError) throw error;
      throw new MaintenanceAdmissionError('Maintenance admission unavailable', error);
    }
  }
  function initialize() {
    inspect(root, true);
    fs.mkdirSync(path.dirname(root), { recursive: true });
    let created = false;
    try { fs.mkdirSync(root); created = true; }
    catch (error) { if (error?.code !== 'EEXIST') throw error; }
    if (created) fs.mkdirSync(leasesDir);
    // An interrupted initialization or deleted lease directory is not repaired.
    if (!inspect(leasesDir, true)) throw new Error('Missing maintenance lease directory');
  }
  function status() {
    return guarded(() => {
      if (!inspect(root, true)) return { marked: false, leases: 0 };
      if (!inspect(leasesDir, true)) throw new Error('Missing maintenance lease directory');
      const marked = readRecord(marker, 'maintenance') !== null;
      let leases = 0;
      for (const name of fs.readdirSync(leasesDir)) {
        const id = name.slice(0, -5);
        if (!name.endsWith('.json') || !uuid.test(id)) throw new Error('Corrupt maintenance lease name');
        if (readRecord(path.join(leasesDir, name), 'normal', id)) ++leases;
      }
      return { marked, leases };
    });
  }
  function assertUnmarked() {
    if (status().marked) throw new MaintenanceAdmissionError();
  }
  function acquireNormalOperation() {
    return guarded(() => {
      initialize();
      assertUnmarked();
      const id = randomUUID();
      const target = path.join(leasesDir, `${id}.json`);
      writeRecord(target, { version: 1, kind: 'normal', id });
      let active = true;
      let running = 0;
      const lease = Object.freeze({
        async run(fn) {
          if (!active) throw new MaintenanceAdmissionError('Normal lease owner released');
          ++running;
          try { return await normalContext.run({ root, lease, active: () => active }, fn); }
          finally { --running; }
        },
        release() {
          return guarded(() => {
            if (!active) return;
            if (running) throw new Error('Normal lease still running');
            if (!readRecord(target, 'normal', id)) throw new Error('Normal lease owner lost');
            fs.unlinkSync(target);
            active = false;
          });
        },
      });
      // Maintenance may publish between the first check and our lease creation.
      // Until this second check passes the caller has performed no normal work.
      try { assertUnmarked(); }
      catch (error) { lease.release(); throw error; }
      return lease;
    });
  }
  async function withNormalOperation(fn) {
    const inherited = normalContext.getStore();
    if (inherited?.root === root && inherited.active()) return inherited.lease.run(fn);
    const lease = acquireNormalOperation();
    try { return await lease.run(fn); }
    finally { lease.release(); }
  }
  function beginMaintenance() {
    return guarded(() => {
      initialize();
      assertUnmarked(); // Validate corrupt leases before publishing a marker.
      const id = randomUUID();
      writeRecord(marker, { version: 1, kind: 'maintenance', id });
      let active = true;
      let drained = false;
      let running = false;
      function owned() {
        if (!active || !readRecord(marker, 'maintenance', id)) {
          throw new MaintenanceAdmissionError('Maintenance owner unavailable');
        }
      }
      return Object.freeze({
        async drain({ timeoutMs = 5000 } = {}) {
          if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 30000) {
            throw new TypeError('Drain timeout must be between 0 and 30000 milliseconds');
          }
          const deadline = performance.now() + timeoutMs;
          while (true) {
            const done = guarded(() => { owned(); return status().leases === 0; });
            if (done) { drained = true; return; }
            if (performance.now() >= deadline) throw new MaintenanceAdmissionError('Maintenance drain timed out');
            await new Promise(resolve => setTimeout(resolve, Math.min(10, Math.max(1, deadline - performance.now()))));
          }
        },
        async runRecovery(fn) {
          guarded(() => {
            owned();
            if (!drained || status().leases !== 0) throw new MaintenanceAdmissionError('Maintenance not drained');
            if (running) throw new MaintenanceAdmissionError('Recovery already running');
            running = true;
          });
          // No normal-admission bypass is installed, including for API handlers.
          try { return await normalContext.run(undefined, fn); }
          finally { running = false; }
        },
        release() {
          return guarded(() => {
            owned();
            if (running) throw new MaintenanceAdmissionError('Recovery still running');
            if (!drained || status().leases !== 0) throw new MaintenanceAdmissionError('Maintenance not drained');
            fs.unlinkSync(marker);
            active = false;
          });
        },
      });
    });
  }
  return Object.freeze({ status, acquireNormalOperation, withNormalOperation, beginMaintenance });
}
