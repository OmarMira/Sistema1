if (typeof process === 'undefined' || !process.versions?.node) {
  throw new Error('Requires Node.js runtime (not Edge)');
}

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const digest = (payload) => crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
function inspect(target) {
    const parent = path.dirname(target);
    if (parent !== target)
        inspect(parent);
    try {
        if (fs.lstatSync(target).isSymbolicLink())
            throw new Error('RECOVERY_JOURNAL: links forbidden');
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
    }
}
function location(root, id) {
    if (!path.isAbsolute(root) || !uuid.test(id))
        throw new Error('RECOVERY_JOURNAL: invalid location');
    const target = path.join(root, id + '.json');
    inspect(target);
    return target;
}
function validate(value) {
    if (!value || !uuid.test(value.operationId) || typeof value.companyId !== 'string' || !value.companyId ||
        !/^[a-f0-9]{64}$/.test(value.checksum) || !Array.isArray(value.files))
        throw new Error('RECOVERY_JOURNAL: invalid payload');
    if (value.maintenanceId !== undefined && !uuid.test(value.maintenanceId))
        throw new Error('RECOVERY_JOURNAL: invalid maintenance identity');
    if (value.safetyFilename !== undefined && !/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\.json$/.test(value.safetyFilename))
        throw new Error('RECOVERY_JOURNAL: invalid safety filename');
    if (value.logoUrl !== undefined && !/^\/uploads\/logos\/[a-zA-Z0-9_.-]+$/.test(value.logoUrl))
        throw new Error('RECOVERY_JOURNAL: invalid logo URL');
    const keys = new Set();
    for (const file of value.files) {
        if (!file || typeof file.key !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(file.key) || keys.has(file.key))
            throw new Error('RECOVERY_JOURNAL: invalid file key');
        keys.add(file.key);
        for (const bytes of [file.before, file.after]) {
            if (bytes !== null && (typeof bytes !== 'string' || Buffer.from(bytes, 'base64').toString('base64') !== bytes))
                throw new Error('RECOVERY_JOURNAL: invalid bytes');
        }
    }
}
/** Immutable intent, flushed before any protected mutation. A partial write is
 * deliberately retained and blocks reconciliation; it is never repaired by guess.
 * Durability across power loss still requires platform/storage acceptance tests.
 */
export function createRecoveryJournal(root, payload) {
    validate(payload);
    const target = location(root, payload.operationId);
    fs.mkdirSync(root, { recursive: true });
    inspect(root);
    const fd = fs.openSync(target, 'wx', 0o600);
    try {
        fs.writeFileSync(fd, JSON.stringify({ version: 1, payload, digest: digest(payload) }), 'utf8');
        fs.fsyncSync(fd);
    }
    finally {
        fs.closeSync(fd);
    }
}
export function readRecoveryJournal(root, id) {
    const target = location(root, id);
    if (!fs.lstatSync(target).isFile())
        throw new Error('RECOVERY_JOURNAL: invalid file');
    const record = JSON.parse(fs.readFileSync(target, 'utf8'));
    validate(record.payload);
    if (record.version !== 1 || record.payload.operationId !== id || record.digest !== digest(record.payload))
        throw new Error('RECOVERY_JOURNAL: damaged intent');
    return record.payload;
}
