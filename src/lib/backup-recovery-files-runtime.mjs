import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
function inspect(target) {
    if (!path.isAbsolute(target))
        throw new Error('RECOVERY_FILES: absolute target required');
    const parent = path.dirname(target);
    if (parent !== target)
        inspect(parent);
    try {
        if (fs.lstatSync(target).isSymbolicLink())
            throw new Error('RECOVERY_FILES: links forbidden');
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
    }
}
export function recoveryFileImage(target) {
    inspect(target);
    try {
        if (!fs.lstatSync(target).isFile())
            throw new Error('RECOVERY_FILES: regular file required');
        return fs.readFileSync(target).toString('base64');
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return null;
        throw error;
    }
}
function replace(target, image) {
    inspect(target);
    if (image === null) {
        if (fs.existsSync(target))
            fs.unlinkSync(target);
        return;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temp = path.join(path.dirname(target), '.recovery-' + crypto.randomUUID() + '.tmp');
    const fd = fs.openSync(temp, 'wx', 0o600);
    try {
        fs.writeFileSync(fd, Buffer.from(image, 'base64'));
        fs.fsyncSync(fd);
    }
    finally {
        fs.closeSync(fd);
    }
    try {
        inspect(target);
        fs.renameSync(temp, target);
    }
    finally {
        if (fs.existsSync(temp))
            fs.unlinkSync(temp);
    }
}
/** Caller holds drained maintenance throughout. Targets are trusted application
 * mappings, NEVER archive paths. Partial application is recoverable by the same
 * immutable before/after images; any unrelated generation blocks the whole pass.
 */
export function reconcileRecoveryFiles(journal, targets, receipt) {
    if (receipt === 'unknown')
        return 'blocked';
    const plans = journal.files.map(file => {
        if (!Object.hasOwn(targets, file.key))
            throw new Error('RECOVERY_FILES: unknown target');
        const target = targets[file.key];
        return { file, target, current: recoveryFileImage(target) };
    });
    if (new Set(plans.map(p => path.resolve(p.target))).size !== plans.length)
        throw new Error('RECOVERY_FILES: duplicate targets');
    if (plans.some(p => p.current !== p.file.before && p.current !== p.file.after))
        return 'blocked';
    for (const plan of plans) {
        const desired = receipt === 'committed' ? plan.file.after : plan.file.before;
        if (plan.current !== desired)
            replace(plan.target, desired);
    }
    return receipt === 'committed' ? 'complete' : 'aborted';
}
/** Compose a whole-file image while changing only one own tenant property. */
export function companyConfigImage(before, companyId, value) {
    if (!companyId || ['__proto__', 'constructor', 'prototype'].includes(companyId))
        throw new Error('RECOVERY_FILES: invalid company');
    const config = before === null ? {} : JSON.parse(Buffer.from(before, 'base64').toString('utf8'));
    if (!config || typeof config !== 'object' || Array.isArray(config) ||
        (config.companies !== undefined && (!config.companies || typeof config.companies !== 'object' || Array.isArray(config.companies))))
        throw new Error('RECOVERY_FILES: invalid config');
    const companies = { ...(config.companies ?? {}) };
    if (value === null)
        delete companies[companyId];
    else
        Object.defineProperty(companies, companyId, { value, enumerable: true, configurable: true, writable: true });
    return Buffer.from(JSON.stringify({ ...config, companies }, null, 2), 'utf8').toString('base64');
}
