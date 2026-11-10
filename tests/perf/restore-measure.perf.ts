/**
 * Portable company-restore MEASUREMENT harness — measurement only.
 *
 * It never changes production behaviour, thresholds, timeouts or expectations.
 * It builds a synthetic company snapshot with N journal entries (≈2 lines each
 * plus proportional GlAccounts/BankAccounts/BankStatements), then times the
 * phases of the REAL portable restore path separately:
 *
 *   validateMs  validateRestoreSource(companyId, text, { recovery: 'portable' })
 *   publishMs   publishBackup(safety filename, sealed safety snapshot text)
 *               (the real restore publishes this inside its own transaction)
 *   restoreMs   the full restoreCompanyBackupCoordinated(companyId, text, mode)
 * The standalone validateMs/publishMs are contextual, not subtracted from the
 * full run. Test-only wrappers report inclusive spans from that actual run:
 * validation, capture, publication, transaction and each delegate operation.
 * Nested spans overlap: never sum them as exclusive buckets. SQL spans measure
 * client-observed awaits, not database-server CPU. Payload counts are expectations;
 * committed results are exported again and validated to verify persisted counts.
 *
 * It prints one JSON line per size with spansInclusive, expectedPayloadCounts,
 * persistedCounts and countsVerified. A timeout is an observed result, not a
 * successful restoration; failed runs cannot establish per-row throughput.
 * Run each size in a separate process with a fresh scratch root to avoid catalog
 * growth between sizes. Compare repeated runs before drawing scaling conclusions.
 *
 * Safety: refuses anything but the disposable cluster
 * 127.0.0.1:55432/accountexpress_test (checked in the runner config and here),
 * writes only into the ACCOUNTEXPRESS_DATA_DIR scratch root, reads no .env, no
 * real backups and no operator database. Every size uses a fresh company id and
 * purges its own synthetic rows before the next size.
 *
 * Run (one invocation per size list; see scripts/perf-restore-measure.vitest.config.mts).
 * `--reporter=verbose` is required: the default vitest reporter hides stdout when
 * the process is not attached to a terminal.
 *
 *   DATABASE_URL='postgresql://postgres:testpw@127.0.0.1:55432/accountexpress_test?schema=public' \
 *   ACCOUNTEXPRESS_DATA_DIR="$(mktemp -d "$TEMP/s1-perf-restore.XXXXXX")" \
 *   PERF_SIZES=1000,10000 SESSION_SECRET=synthetic-perf-only HMAC_SECRET=synthetic-perf-only \
 *   npx vitest run --config scripts/perf-restore-measure.vitest.config.mts --reporter=verbose
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

// Test-only interception: real implementations run unchanged. These inclusive
// spans overlap (transaction includes its SQL and safety capture includes reads).
// They must never be added together or presented as exclusive phase totals.
const probe = vi.hoisted(() => ({
  active: false,
  failJournalInsert: 0,
  journalInsertCalls: 0,
  spans: {} as Record<string, { calls: number; succeeded: number; failed: number; ms: number }>,
  async time<T>(name: string, run: () => Promise<T>): Promise<T> {
    if (!this.active) return run();
    const span = this.spans[name] ??= { calls: 0, succeeded: 0, failed: 0, ms: 0 };
    span.calls++;
    const start = performance.now();
    try { const value = await run(); span.succeeded++; return value; }
    catch (error) { span.failed++; throw error; }
    finally { span.ms += performance.now() - start; }
  },
  sync<T>(name: string, run: () => T): T {
    if (!this.active) return run();
    const span = this.spans[name] ??= { calls: 0, succeeded: 0, failed: 0, ms: 0 };
    span.calls++;
    const start = performance.now();
    try { const value = run(); span.succeeded++; return value; }
    catch (error) { span.failed++; throw error; }
    finally { span.ms += performance.now() - start; }
  },
}));

vi.mock('@/lib/backup-validation', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/backup-validation')>();
  return { ...actual,
    validateRestoreSource: (...args: Parameters<typeof actual.validateRestoreSource>) =>
      probe.sync('validateSource', () => actual.validateRestoreSource(...args)),
    validateRestoreDestination: (...args: Parameters<typeof actual.validateRestoreDestination>) =>
      probe.sync('validateDestination', () => actual.validateRestoreDestination(...args)),
  };
});
vi.mock('@/lib/backup', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/backup')>();
  return { ...actual,
    captureCompanySnapshot: (...args: Parameters<typeof actual.captureCompanySnapshot>) =>
      probe.time('safetyCapture', () => actual.captureCompanySnapshot(...args)),
  };
});
vi.mock('@/lib/backup-storage', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/backup-storage')>();
  return { ...actual,
    publishBackup: (...args: Parameters<typeof actual.publishBackup>) =>
      probe.sync('safetyPublish', () => actual.publishBackup(...args)),
  };
});
vi.mock('@/lib/db', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/db')>();
  return { ...actual,
    withCompanyBackupTransaction: (run: (tx: any) => Promise<unknown>, options: any) =>
      probe.time('transactionInclusive', () => actual.withCompanyBackupTransaction(async tx => {
        const wrapped = new Proxy(tx, {
          get(target, key) {
            const value = Reflect.get(target, key);
            if (typeof value === 'function') return value.bind(target);
            if (!value || typeof value !== 'object') return value;
            return new Proxy(value, {
              get(delegate, method) {
                const call = Reflect.get(delegate, method);
                if (typeof call !== 'function') return call;
                return (...args: unknown[]) => probe.time(`sql.${String(key)}.${String(method)}`, () => {
                  if (probe.active && key === 'journalEntry' && ['create', 'createMany'].includes(String(method))) {
                    probe.journalInsertCalls++;
                    if (probe.failJournalInsert === probe.journalInsertCalls) {
                      throw new Error('PERF_INJECTED_JOURNAL_INSERT_FAILURE');
                    }
                  }
                  return call.apply(delegate, args);
                });
              },
            });
          },
        });
        return run(wrapped);
      }, options)),
  };
});

vi.mock('@/lib/logger', () => ({ logger: { slowQuery: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/metrics', () => ({ trackQueryDuration: vi.fn() }));

import { captureCompanySnapshot } from '@/lib/backup';
import { sealSnapshot } from '@/lib/backup-format';
import { validateRestoreSource } from '@/lib/backup-validation';
import { publishBackup, readCompanyConfig } from '@/lib/backup-storage';
import { reconcileCompanyBackupRecovery, restoreCompanyBackupCoordinated } from '@/lib/backup-restore';
import { db, withCompanyBackupTransaction } from '@/lib/db';
import { maintenanceStatus } from '@/lib/backup-runtime-maintenance';
import { computeEntryHashV2 } from '@/lib/journal-hash';

type Row = Record<string, any>;
type Tables = Record<string, Row[]>;

const round = (value: number) => Math.round(value * 100) / 100;
/** Models the replacement pass never inserts (Company is UPDATEd, User is a
 * reference resolved against the destination, SystemConfig is never restorable). */
const NOT_INSERTED = ['Company', 'User', 'SystemConfig'];

const SIZES = (process.env.PERF_SIZES ?? '1000,10000')
  .split(',')
  .map(value => Number(value.trim()))
  .filter(value => Number.isInteger(value) && value > 0);

const DATA_ROOT = process.env.ACCOUNTEXPRESS_DATA_DIR as string;
let raw: PrismaClient;

/* ─── synthetic payload (built with the project's own hashing helpers) ─── */

async function insertBatches(rows: Row[], run: (batch: Row[]) => Promise<unknown>, batchSize = 500) {
  for (let index = 0; index < rows.length; index += batchSize) {
    await run(rows.slice(index, index + batchSize));
  }
}

async function seedCompany(client: PrismaClient, companyId: string, userId: string, size: number) {
  const base = Date.UTC(2026, 0, 1);
  const glCount = Math.max(4, Math.ceil(size / 100));
  const bankCount = Math.max(1, Math.ceil(size / 1000));

  await client.user.create({ data: {
    id: userId, email: `${companyId}@example.invalid`, passwordHash: 'synthetic-not-a-real-credential',
    firstName: 'Perf', lastName: 'Harness', platformRole: 'user', isActive: true,
  } });
  await client.company.create({ data: {
    id: companyId, legalName: `Perf Restore ${companyId}`, taxId: null, logo: null, isActive: true,
  } });
  await client.companyMember.create({ data: { companyId, userId, role: 'company_admin' } });

  const glAccounts: Row[] = [];
  for (let index = 0; index < glCount; index += 1) {
    glAccounts.push({
      id: `${companyId}_ga_${index}`, companyId, code: `code_${index}`, name: `Account ${index}`,
      accountType: 'asset', normalBalance: 'debit', balance: '0.00', isActive: true, isSystem: false,
    });
  }
  const bankAccounts: Row[] = [];
  const bankStatements: Row[] = [];
  for (let index = 0; index < bankCount; index += 1) {
    const bankAccountId = `${companyId}_ba_${index}`;
    bankAccounts.push({
      id: bankAccountId, companyId, accountName: `Bank ${index}`, bankName: 'Perf Bank',
      glAccountId: glAccounts[index % glCount].id, balance: '0.00', initialBalance: '0.00', currency: 'USD', isActive: true,
    });
    const start = new Date(base + index * 86_400_000);
    bankStatements.push({
      id: `${companyId}_bs_${index}`, companyId, bankAccountId, startDate: start,
      endDate: new Date(start.getTime() + 86_400_000), format: 'CSV',
      openingBalance: '0.00', closingBalance: '0.00', totalCredits: '0.00', totalDebits: '0.00',
    });
  }

  const entries: Row[] = [];
  const lines: Row[] = [];
  let previousHash: string | null = null;
  let lastEntryId = '';
  for (let index = 0; index < size; index += 1) {
    const id = `${companyId}_je_${index}`;
    const date = new Date(base + index * 60_000);
    const description = `Perf entry ${index}`;
    const amount = (((index % 97) + 1)).toFixed(2);
    const dayLines = [
      { glAccountId: glAccounts[index % glCount].id, debit: amount, credit: '0.00', description: `debit ${index}` },
      { glAccountId: glAccounts[(index + 1) % glCount].id, debit: '0.00', credit: amount, description: `credit ${index}` },
    ];
    const hash = computeEntryHashV2({
      id, companyId, date, description, reference: null, previousHash,
      lines: dayLines.map(line => ({ glAccountId: line.glAccountId, debit: line.debit, credit: line.credit, description: line.description })),
    });
    entries.push({
      id, companyId, date, description, reference: null, status: 'posted',
      hash, previousHash, hashVersion: 'v2', createdAt: date, updatedAt: date,
    });
    dayLines.forEach((line, position) => lines.push({ id: `${id}_l${position}`, entryId: id, ...line }));
    previousHash = hash;
    lastEntryId = id;
  }

  await insertBatches(glAccounts, batch => client.glAccount.createMany({ data: batch as any }));
  await insertBatches(bankAccounts, batch => client.bankAccount.createMany({ data: batch as any }));
  await insertBatches(bankStatements, batch => client.bankStatement.createMany({ data: batch as any }));
  await insertBatches(entries, batch => client.journalEntry.createMany({ data: batch as any }));
  await insertBatches(lines, batch => client.journalLine.createMany({ data: batch as any }));
  await client.journalChainHead.create({ data: { companyId, lastHash: previousHash, lastEntryId } });

  return { glCount, bankCount, entries: size, lines: lines.length };
}

/** The payload under test: the project's real exporter, sealed like production. */
async function buildSnapshotText(companyId: string) {
  const snapshot = await withCompanyBackupTransaction(
    tx => captureCompanySnapshot(tx as any, companyId, readCompanyConfig(companyId)),
    { isolationLevel: 'RepeatableRead' },
  );
  sealSnapshot(snapshot.backupData);
  return { snapshot, text: JSON.stringify(snapshot.backupData, null, 2) };
}

async function purge(client: PrismaClient, companyId: string, userId: string) {
  // Explicit FK order: the disposable database is ours, but never leave state behind.
  await client.auditLog.deleteMany({ where: { companyId } });
  await client.bankTransaction.deleteMany({ where: { statement: { companyId } } });
  await client.bankStatement.deleteMany({ where: { companyId } });
  await client.bankAccount.deleteMany({ where: { companyId } });
  await client.journalLine.deleteMany({ where: { entry: { companyId } } });
  await client.journalEntry.deleteMany({ where: { companyId } });
  await client.journalChainHead.deleteMany({ where: { companyId } });
  await client.reconciliationPeriod.deleteMany({ where: { companyId } });
  await client.ruleApplyRecord.deleteMany({ where: { companyId } });
  await client.companyMember.deleteMany({ where: { companyId } });
  await client.glAccount.deleteMany({ where: { companyId } });
  await client.company.deleteMany({ where: { id: companyId } });
  await client.user.deleteMany({ where: { id: userId } });
}

/**
 * A `not_confirmed` restore deliberately leaves the maintenance marker closed
 * (the production contract: never auto-replay). The harness is a sequence of
 * independent measurements, so it settles that operation through the SAME
 * documented recovery entry point before the next size.
 */
async function settleMaintenance(companyId: string, operationId: string | null): Promise<string> {
  if (!maintenanceStatus().marked) return 'clean';
  if (!operationId) return 'marked_without_operation';
  const reconciled = await reconcileCompanyBackupRecovery(companyId, operationId);
  return `reconciled:${reconciled.status}${maintenanceStatus().marked ? ':still-marked' : ''}`;
}

beforeAll(async () => {
  raw = new PrismaClient();
  // The container reports its OWN listener address/port, so the client-side
  // target (55432) is asserted from DATABASE_URL — exactly what Prisma used —
  // and the server side is recorded as evidence.
  const configured = new URL(process.env.DATABASE_URL as string);
  if (configured.port !== '55432' || configured.pathname.replace(/^\//, '') !== 'accountexpress_test') {
    throw new Error(`[PERF SAFETY] DATABASE_URL targets ${configured.host}${configured.pathname}; refusing to measure outside the disposable cluster`);
  }
  const identity = await raw.$queryRawUnsafe<Array<Row>>(
    `SELECT current_database() AS db, inet_server_port() AS serverport, host(inet_server_addr()) AS serverhost,`
    + ` current_setting('data_directory') AS datadirectory, current_setting('server_version') AS version`,
  );
  const target = identity[0] ?? {};
  if (target.db !== 'accountexpress_test') {
    throw new Error(`[PERF SAFETY] connected database is ${String(target.db)}; refusing to measure outside the disposable cluster`);
  }
  console.log(`# harness=portable-restore-measurement db=${target.db} clientTarget=${configured.host}:${configured.port}`
    + ` server=${target.serverhost}:${target.serverport} pg=${target.version} dataDirectory=${target.datadirectory}`
    + ` node=${process.version} dataDir=${DATA_ROOT} sizes=${SIZES.join(',')}`);
});

afterAll(async () => {
  await raw?.$disconnect();
  await db.$disconnect();
  // Scratch root created by the runner outside the worktree; safe to remove here.
  if (DATA_ROOT && path.basename(DATA_ROOT).startsWith('s1-perf-restore')) {
    fs.rmSync(DATA_ROOT, { recursive: true, force: true });
  }
});

for (const size of SIZES) {
  it(`measures the portable restore of ${size} journal entries`, async () => {
    const companyId = `perf_${size}_${crypto.randomBytes(4).toString('hex')}`;
    const userId = `${companyId}_usr`;
    try {
      const seeded = await seedCompany(raw, companyId, userId, size);
      const { text } = await buildSnapshotText(companyId);
      const authenticatedDigest = crypto.createHash('sha256').update(text, 'utf8').digest('hex');
      const mode = { recovery: 'portable' as const, authenticatedDigest };
      const payloadBytes = Buffer.byteLength(text, 'utf8');

      // 1. Source validation (the restore repeats this inside its own call).
      const tValidate = performance.now();
      const validated = validateRestoreSource(companyId, text, mode);
      const validateMs = performance.now() - tValidate;
      const tables: Tables = validated.tables;

      // 2. Safety snapshot publication, measured exactly as the restore does it
      //    (capture is untimed here so this phase isolates publishBackup).
      const tCapture = performance.now();
      const safety = await withCompanyBackupTransaction(
        tx => captureCompanySnapshot(tx as any, companyId, readCompanyConfig(companyId)),
        { isolationLevel: 'RepeatableRead' },
      );
      sealSnapshot(safety.backupData);
      const safetyText = JSON.stringify(safety.backupData, null, 2);
      const safetyCaptureMs = performance.now() - tCapture;

      const tPublish = performance.now();
      publishBackup(safety.filename, safetyText);
      const publishMs = performance.now() - tPublish;

      // 3. The full coordinated portable restore. A timeout is data, not a crash.
      let restoreMs = 0;
      let outcome = '';
      let detail = '';
      let operationId: string | null = null;
      probe.spans = {};
      probe.journalInsertCalls = 0;
      probe.active = true;
      const tRestore = performance.now();
      try {
        const result = await restoreCompanyBackupCoordinated(companyId, text, mode);
        restoreMs = performance.now() - tRestore;
        operationId = result.operationId ?? null;
        outcome = result.status === 'committed' ? 'committed' : 'not_confirmed';
        detail = `${result.status}${result.error ? ` | ${result.error}` : ''}`;
      } catch (error) {
        restoreMs = performance.now() - tRestore;
        const message = error instanceof Error ? error.message : String(error);
        outcome = /^([A-Z][A-Z0-9_]+):/.exec(message)?.[1] ?? 'thrown';
        detail = message;
      }
      probe.active = false;
      // Standalone validation/publication are contextual measurements, NOT spans
      // subtracted from the restore: the real call repeats them internally.

      const inserted = Object.entries(tables).filter(([model]) => !NOT_INSERTED.includes(model));
      const rowsByTable = Object.fromEntries(inserted.map(([model, rows]) => [model, rows.length]));
      const rows = inserted.reduce((total, [, modelRows]) => total + modelRows.length, 0);

      const persistedCounts: Record<string, number> = {};
      if (outcome === 'committed') {
        const restored = await buildSnapshotText(companyId);
        const actualTables = validateRestoreSource(companyId, restored.text, {
          recovery: 'portable',
          authenticatedDigest: crypto.createHash('sha256').update(restored.text, 'utf8').digest('hex'),
        }).tables;
        for (const [model, sourceRows] of inserted) {
          // Restore adds an operational audit receipt; source AuditLog is empty
          // in this synthetic fixture. Report it, but do not call it payload data.
          persistedCounts[model] = actualTables[model].length;
          if (model !== 'AuditLog') expect(persistedCounts[model], model).toBe(sourceRows.length);
          if (model === 'JournalEntry' || model === 'JournalLine') {
            const comparable = (values: Row[]) => values.map(({ lines: _nested, ...row }) => row)
              .sort((a, b) => String(a.id).localeCompare(String(b.id)));
            expect(comparable(actualTables[model]), `${model} original scalar values`).toEqual(comparable(sourceRows));
          }
        }
      }
      const settlement = await settleMaintenance(companyId, operationId);
      // Print diagnostics BEFORE assertions: failure evidence is as important as
      // successful timings and must survive an expected-outcome mismatch.
      // Inclusive spans are reported separately from contextual standalone times.
      console.log(JSON.stringify({
        size, rows,
        validateMs: round(validateMs), publishMs: round(publishMs), restoreMs: round(restoreMs),
        outcome,
        spansInclusive: Object.fromEntries(Object.entries(probe.spans).map(([name, span]) =>
          [name, { ...span, ms: round(span.ms) }])),
        expectedPayloadCounts: rowsByTable, persistedCounts,
        countsVerified: outcome === 'committed',
      }));
      console.log(`# size=${size} seeded=${JSON.stringify({ entries: seeded.entries, lines: seeded.lines, glAccounts: seeded.glCount, bankAccounts: seeded.bankCount, bankStatements: seeded.bankCount, members: 1, users: 1 })}`
        + ` rowsByTable=${JSON.stringify(rowsByTable)}`
        + ` payloadBytes=${payloadBytes} safetyBytes=${Buffer.byteLength(safetyText, 'utf8')}`
        + ` standaloneSafetyCaptureMs=${round(safetyCaptureMs)}`
        + ` insertedExtras=journalChainHead+auditReceipt settlement=${settlement} detail=${JSON.stringify(detail)}`);
      if (process.env.PERF_EXPECT_BATCH === '1') {
        expect(outcome).toBe('committed');
        for (const model of ['journalEntry', 'journalLine']) {
          expect(probe.spans[`sql.${model}.create`]?.calls ?? 0, `${model} per-row calls`).toBe(0);
          expect(probe.spans[`sql.${model}.createMany`]?.succeeded ?? 0, `${model} bounded batches`).toBeGreaterThan(0);
          expect(probe.spans[`sql.${model}.createMany`].calls).toBeLessThan(size);
        }
      }
    } finally {
      await purge(raw, companyId, userId);
      const leftovers = await raw.company.count({ where: { id: companyId } });
      const auditLeft = await raw.auditLog.count({ where: { companyId } });
      if (leftovers || auditLeft) console.log(`# warn size=${size} purgeLeftovers company=${leftovers} audit=${auditLeft}`);
    }
  });
}

it('rolls back replacement after a later journal insert fails and keeps maintenance closed', async () => {
  const companyId = `perf_rollback_${crypto.randomBytes(4).toString('hex')}`;
  const userId = `${companyId}_usr`;
  let operationId: string | null = null;
  // Ignore ordering only. Export manifests have fresh ids/timestamps; compare
  // complete exported data, including stored ids, values, hashes and dates.
  function canonical(value: any): any {
    if (Array.isArray(value)) return value.map(canonical).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    return value;
  }
  try {
    await seedCompany(raw, companyId, userId, 501);
    const { snapshot, text } = await buildSnapshotText(companyId);
    const before = canonical(snapshot.backupData.data);
    probe.spans = {};
    probe.journalInsertCalls = 0;
    probe.failJournalInsert = 2;
    probe.active = true;
    const result = await restoreCompanyBackupCoordinated(companyId, text, {
      recovery: 'portable', authenticatedDigest: crypto.createHash('sha256').update(text, 'utf8').digest('hex'),
    });
    probe.active = false;
    operationId = result.operationId;
    expect(result.status).toBe('reconciliation_required');
    expect(result.error).toContain('PERF_INJECTED_JOURNAL_INSERT_FAILURE');
    expect(probe.journalInsertCalls).toBe(2);
    expect(maintenanceStatus().marked).toBe(true);
    const after = await raw.$transaction(async tx => {
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      return captureCompanySnapshot(tx as any, companyId, readCompanyConfig(companyId));
    }, { isolationLevel: 'RepeatableRead' });
    expect(canonical(after.backupData.data)).toEqual(before);
    expect(await raw.journalEntry.count({ where: { companyId } })).toBe(501);
    expect(await raw.journalLine.count({ where: { entry: { companyId } } })).toBe(1002);
    expect(await raw.auditLog.count({ where: { companyId } })).toBe(0);
    expect(await settleMaintenance(companyId, operationId)).toBe('reconciled:aborted');
    expect(maintenanceStatus().marked).toBe(false);
  } finally {
    probe.active = false;
    probe.failJournalInsert = 0;
    await settleMaintenance(companyId, operationId);
    await purge(raw, companyId, userId);
  }
});
