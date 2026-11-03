if (typeof process === 'undefined' || !process.versions?.node) {
  throw new Error('backup-maintenance.mjs requires Node.js runtime (not Edge)');
}
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';

const normalContext = new AsyncLocalStorage();
// Scope lifetimes are shorter than durable lease ownership: detached callbacks
// cannot inherit authority after the callback which created them has completed.
function scoped(context, fn) {
  const parent = normalContext.getStore();
  const pending = new Set();
  let live = true;
  const scope = { ...context, pending, active: () => live && context.active() };
  const work = (async () => {
    try { return await normalContext.run(scope, fn); }
    finally {
      live = false;
      while (pending.size) await Promise.allSettled([...pending]);
    }
  })();
  if (parent?.root === context.root && parent.active()) {
    parent.pending.add(work);
    void work.then(() => parent.pending.delete(work), () => parent.pending.delete(work));
  }
  return work;
}

function scopedSync(context, fn, settled = () => {}) {
  const parent = normalContext.getStore();
  const pending = new Set();
  let live = true;
  const scope = { ...context, pending, active: () => live && context.active() };
  try {
    const value = normalContext.run(scope, fn);
    if (value && typeof value.then === 'function') {
      const returned = Promise.resolve(value);
      pending.add(returned);
      void returned.then(() => pending.delete(returned), () => pending.delete(returned));
      throw new TypeError('Synchronous operation returned a promise');
    }
    return value;
  } finally {
    live = false;
    if (!pending.size) settled();
    else {
      const completion = (async () => {
        try { while (pending.size) await Promise.allSettled([...pending]); }
        finally { settled(); }
      })();
      if (parent?.root === context.root && parent.active()) {
        parent.pending.add(completion);
        void completion.then(() => parent.pending.delete(completion), () => parent.pending.delete(completion));
      }
      void completion.catch(() => {});
    }
  }
}

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

const invalidDataRoot = 'ACCOUNTEXPRESS_DATA_DIR must be an absolute directory separate from program files.';

function realLocation(input) {
  let ancestor = path.resolve(input);
  const missing = [];
  while (!fs.existsSync(ancestor)) {
    missing.unshift(path.basename(ancestor));
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error(invalidDataRoot);
    ancestor = parent;
  }
  if (!fs.statSync(ancestor).isDirectory()) throw new Error(invalidDataRoot);
  return path.join(fs.realpathSync.native(ancestor), ...missing);
}

function contains(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

// Shared unchanged application validation, usable by plain Node MJS scripts.
export function configuredDataRoot() {
  const value = process.env.ACCOUNTEXPRESS_DATA_DIR;
  if (!value) return undefined;
  if (!path.isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)) throw new Error(invalidDataRoot);
  if (process.platform === 'win32' && (!/^[a-z]:[\\/]/i.test(value) || value.slice(3).split(/[\\/]/).filter(Boolean).some(part =>
    /[<>:"|?*]/.test(part) || /[. ]$/.test(part) || /^(CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(part)))) throw new Error(invalidDataRoot);
  const selected = path.resolve(value);
  if (selected === path.parse(selected).root) throw new Error(invalidDataRoot);
  const data = realLocation(selected), program = realLocation(process.cwd());
  if (data === path.parse(data).root || contains(data, program) || contains(program, data)) throw new Error(invalidDataRoot);
  return data;
}

export function runtimeDirectory() {
  const data = configuredDataRoot();
  return data ? path.join(data, 'config') : path.join(process.cwd(), '.data');
}

/** One shared root for every cooperating process; construction is read/write-free. */
export function createMaintenanceGate(storageRoot) {
  if (typeof storageRoot !== 'string' || !path.isAbsolute(storageRoot)) {
    throw new TypeError('Maintenance root must be absolute');
  }
  const root = path.resolve(storageRoot);
  const leasesDir = path.join(root, 'leases');
  const marker = path.join(root, 'maintenance.json');
  const recoveryLock = path.join(root, 'recovery.json');
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
      return { marked, leases: leaseIds().length };
    });
  }
  /** Every live normal-operation lease identity, in directory order. */
  function leaseIds() {
    const ids = [];
    for (const name of fs.readdirSync(leasesDir)) {
      const id = name.slice(0, -5);
      if (!name.endsWith('.json') || !uuid.test(id)) throw new Error('Corrupt maintenance lease name');
      if (readRecord(path.join(leasesDir, name), 'normal', id)) ids.push(id);
    }
    return ids;
  }
  /**
   * Leases that still block a transition, i.e. every live lease except the exact
   * identity of the operation that requested it. Corrupt lease state refuses like
   * status(): a damaged lease directory must never be read as "drained".
   */
  function blockingLeases(excluded) {
    if (!inspect(root, true)) return 0;
    if (!inspect(leasesDir, true)) throw new Error('Missing maintenance lease directory');
    return leaseIds().filter(id => id !== excluded).length;
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
        id,
        async run(fn) {
          if (!active) throw new MaintenanceAdmissionError('Normal lease owner released');
          ++running;
          try { return await scoped({ kind: 'normal', root, lease, active: () => active }, fn); }
          finally { --running; }
        },
        runSync(fn, settled) {
          if (!active) throw new MaintenanceAdmissionError('Normal lease owner released');
          ++running;
          return scopedSync({ kind: 'normal', root, lease, active: () => active }, fn, () => {
            --running;
            settled?.();
          });
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
    if (inherited?.root === root && inherited.kind === 'normal' && inherited.active()) return inherited.lease.run(fn);
    const lease = acquireNormalOperation();
    try { return await lease.run(fn); }
    finally { lease.release(); }
  }
  function withRuntimeOperation(fn) {
    const inherited = normalContext.getStore();
    if (inherited?.root === root && inherited.kind === 'recovery') {
      if (!inherited.active()) return Promise.reject(new MaintenanceAdmissionError('Recovery scope expired'));
      return scoped({ ...inherited, active: inherited.authority }, fn);
    }
    return withNormalOperation(fn);
  }
  function withRuntimeOperationSync(fn) {
    // Execute the callback synchronously, but retain admission through any
    // accidentally returned promise or nested work. Never release inflight work.
    const inherited = normalContext.getStore();
    const recovery = inherited?.root === root && inherited.kind === 'recovery';
    if (recovery && !inherited.active()) throw new MaintenanceAdmissionError('Recovery scope expired');
    const nested = inherited?.root === root && inherited.kind === 'normal' && inherited.active();
    const lease = recovery ? null : nested ? inherited.lease : acquireNormalOperation();
    if (recovery) return scopedSync({ ...inherited, active: inherited.authority }, fn);
    return lease.runSync(fn, () => { if (!nested) lease.release(); });
  }
  /**
   * Publish the maintenance marker and return its owner capability.
   *
   * A transition requested BY an admitted operation passes
   * `excludeCurrentOperation: true`: the drain, the recovery admission check and
   * the release then ignore that one lease identity, captured here inside the
   * caller's own scope. Without it the caller's admission edge would deadlock its
   * own drain and the marker could never be released by the operation that
   * published it. Every OTHER live lease still blocks, so ordinary requests stay
   * fenced (they are refused at acquireNormalOperation while the marker exists)
   * and an operation cannot widen its own admission. Outside an admitted
   * operation the flag is inert; `resumeMaintenance` never excludes anything.
   */
  function beginMaintenance(options) {
    if (options !== undefined && options !== null) {
      if (typeof options !== 'object' || Array.isArray(options) ||
          Object.keys(options).some(key => key !== 'excludeCurrentOperation')) {
        throw new TypeError('Invalid maintenance options');
      }
    }
    return guarded(() => {
      initialize();
      assertUnmarked(); // Validate corrupt leases before publishing a marker.
      const id = randomUUID();
      const excluded = options?.excludeCurrentOperation === true ? currentLeaseId() : null;
      writeRecord(marker, { version: 1, kind: 'maintenance', id });
      return maintenanceOwner(id, excluded);
    });
  }
  /** Identity of the lease this call runs under, if any. */
  function currentLeaseId() {
    const inherited = normalContext.getStore();
    return inherited?.root === root && inherited.kind === 'normal' && inherited.active()
      ? inherited.lease.id
      : null;
  }
  function resumeMaintenance(id) {
    return guarded(() => {
      if (!uuid.test(id)) throw new Error('Invalid maintenance identity');
      if (!readRecord(marker, 'maintenance', id)) throw new Error('Maintenance owner unavailable');
      return maintenanceOwner(id, null);
    });
  }
  function maintenanceOwner(id, excludedLeaseId = null) {
      let active = true;
      let drained = false;
      let running = false;
      function owned() {
        if (!active || !readRecord(marker, 'maintenance', id)) {
          throw new MaintenanceAdmissionError('Maintenance owner unavailable');
        }
      }
      function lockRecovery() {
        writeRecord(recoveryLock, { version: 1, kind: 'recovery', id });
        // The marker could have been released before exclusive acquisition.
        // Revalidate ownership under the same lock that protects release.
        try { owned(); }
        catch (error) { fs.unlinkSync(recoveryLock); throw error; }
      }
      return Object.freeze({
        id,
        excludedLeaseId,
        async drain({ timeoutMs = 5000 } = {}) {
          if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 30000) {
            throw new TypeError('Drain timeout must be between 0 and 30000 milliseconds');
          }
          const deadline = performance.now() + timeoutMs;
          while (true) {
            const done = guarded(() => { owned(); return blockingLeases(excludedLeaseId) === 0; });
            if (done) { drained = true; return; }
            if (performance.now() >= deadline) throw new MaintenanceAdmissionError('Maintenance drain timed out');
            await new Promise(resolve => setTimeout(resolve, Math.min(10, Math.max(1, deadline - performance.now()))));
          }
        },
        async runRecovery(fn) {
          guarded(() => {
            owned();
            if (!drained || blockingLeases(excludedLeaseId) !== 0) throw new MaintenanceAdmissionError('Maintenance not drained');
            if (running) throw new MaintenanceAdmissionError('Recovery already running');
            // Exclusive across resumed owner instances and cooperating processes.
            // A crash leaves this lock blocking: never auto-delete a stale owner.
            lockRecovery();
            running = true;
          });
          // Only runtime guards accept this owned callback capability. Normal
          // admission (especially HTTP) always remains closed while marked.
          const authority = () => { guarded(owned); return active && running; };
          try { return await scoped({ kind: 'recovery', root, active: authority, authority }, fn); }
          finally {
            guarded(() => {
              if (!readRecord(recoveryLock, 'recovery', id)) throw new Error('Recovery lock lost');
              fs.unlinkSync(recoveryLock);
            });
            running = false;
          }
        },
        release() {
          return guarded(() => {
            owned();
            if (running) throw new MaintenanceAdmissionError('Recovery still running');
            if (!drained || blockingLeases(excludedLeaseId) !== 0) throw new MaintenanceAdmissionError('Maintenance not drained');
            lockRecovery();
            try { fs.unlinkSync(marker); active = false; }
            finally { fs.unlinkSync(recoveryLock); }
          });
        },
      });
  }
  return Object.freeze({ status, acquireNormalOperation, withNormalOperation, withRuntimeOperation, withRuntimeOperationSync, beginMaintenance, resumeMaintenance });
}
