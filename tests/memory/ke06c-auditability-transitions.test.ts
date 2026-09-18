/**
 * KE-06C — P7 Auditability: Status Transitions + Update PreviousContent
 *
 * Direct PostgreSQL tests proving:
 * T1 — Update: MemoryVersion=OLD, MemoryItem=NEW, TraceabilityLog.previousContent=OLD
 * T2 — Confirm: previousStatus → newStatus persisted in TraceabilityLog
 * T3 — Reject: previousStatus → newStatus + reason persisted
 * T4 — Forget: previousStatus → newStatus + reason persisted
 * T5 — Company isolation for traceability logs
 */
import { PrismaClient, MemoryStatus } from '@prisma/client';
import { MemoryAdapter } from '../../src/memory/adapter';
import { db } from '@/lib/db';

let ADAPTER: MemoryAdapter;
let COMPANY_A: string;
let COMPANY_B: string;
let createdItemIds: string[] = [];

function createAdapter() {
  const runTx = <R>(fn: (tx: any) => Promise<R>) => db.$transaction(fn);
  return new MemoryAdapter(db, runTx);
}

beforeAll(async () => {
  // Create test companies — unique names avoid collision with other test suites
  const companyA = await db.company.create({
    data: { legalName: 'KE06C Company A', entityType: 'BUSINESS', taxId: '30-70000001-7' },
  });
  COMPANY_A = companyA.id;

  const companyB = await db.company.create({
    data: { legalName: 'KE06C Company B', entityType: 'BUSINESS', taxId: '30-70000002-5' },
  });
  COMPANY_B = companyB.id;

  ADAPTER = createAdapter();
});

afterAll(async () => {
  // Delete ONLY what KE-06C created — respect FK order
  for (const id of createdItemIds) {
    await db.traceabilityLog.deleteMany({ where: { itemId: id } });
    await db.confidenceLog.deleteMany({ where: { itemId: id } });
    await db.memoryVersion.deleteMany({ where: { itemId: id } });
    await db.memoryItem.deleteMany({ where: { id } });
  }
  // Delete companies created by this test (after all dependent items removed)
  if (COMPANY_A) {
    await db.company.deleteMany({ where: { id: COMPANY_A } });
  }
  if (COMPANY_B) {
    await db.company.deleteMany({ where: { id: COMPANY_B } });
  }
  await db.$disconnect();
});

describe('KE-06C — P7 Auditability Transitions', () => {
  // ─── T1 — UPDATE ────────────────────────────────────────────────
  it('T1: Update preserves OLD in MemoryVersion, NEW in MemoryItem, OLD in TraceabilityLog.previousContent', async () => {
    // 1. Create item with OLD_CONTENT
    const item = await ADAPTER.record({
      content: 'OLD_CONTENT',
      type: 'fact',
      companyId: COMPANY_A,
      sourceName: 'ke06c-test-source',
      sourceAuthor: 'test-user',
    });
    createdItemIds.push(item.id);

    // 2. Verify initial state
    expect(item.content).toBe('OLD_CONTENT');

    // 3. Update to NEW_CONTENT
    const updated = await ADAPTER.update(item.id, 'NEW_CONTENT', COMPANY_A);
    expect(updated.content).toBe('NEW_CONTENT');

    // 4. MemoryVersion preserves OLD_CONTENT
    const versions = await ADAPTER.getVersionHistory(item.id, COMPANY_A);
    expect(versions.length).toBeGreaterThanOrEqual(2);
    const v1 = versions.find((v) => v.versionNumber === 1);
    expect(v1).toBeDefined();
    expect(v1!.content).toBe('OLD_CONTENT');

    // 5. MemoryItem contains NEW_CONTENT
    const current = await ADAPTER.getById(item.id, COMPANY_A);
    expect(current).not.toBeNull();
    expect(current!.content).toBe('NEW_CONTENT');

    // 6. TraceabilityLog has action='updated' and previousContent=OLD_CONTENT
    const logs = await ADAPTER.getTraceability(item.id, COMPANY_A);
    const updateLog = logs.find((l) => l.action === 'updated');
    expect(updateLog).toBeDefined();
    expect((updateLog!.details as any).previousContent).toBe('OLD_CONTENT');
  });

  // ─── T2 — CONFIRM ───────────────────────────────────────────────
  it('T2: Confirm persists previousStatus → newStatus in TraceabilityLog', async () => {
    // 1. Create item (initial status = active)
    const item = await ADAPTER.record({
      content: 'To confirm',
      type: 'fact',
      companyId: COMPANY_A,
      sourceName: 'ke06c-test-source',
      sourceAuthor: 'test-user',
    });
    createdItemIds.push(item.id);

    // 2. Verify initial status is active
    const before = await ADAPTER.getById(item.id, COMPANY_A);
    expect(before).not.toBeNull();
    expect(before!.status).toBe('active');

    // 3. Confirm
    const confirmed = await ADAPTER.confirm(item.id, COMPANY_A, 'supervisor-1');
    expect(confirmed.status).toBe('confirmed');

    // 4. TraceabilityLog has previousStatus and newStatus
    const logs = await ADAPTER.getTraceability(item.id, COMPANY_A);
    const confirmLog = logs.find((l) => l.action === 'confirmed');
    expect(confirmLog).toBeDefined();
    expect(confirmLog!.actor).toBe('supervisor-1');
    expect((confirmLog!.details as any).previousStatus).toBe('active');
    expect((confirmLog!.details as any).newStatus).toBe('confirmed');
  });

  // ─── T3 — REJECT ────────────────────────────────────────────────
  it('T3: Reject persists previousStatus → newStatus + reason in TraceabilityLog', async () => {
    // 1. Create item
    const item = await ADAPTER.record({
      content: 'To reject',
      type: 'fact',
      companyId: COMPANY_A,
      sourceName: 'ke06c-test-source',
      sourceAuthor: 'test-user',
    });
    createdItemIds.push(item.id);

    // 2. Verify initial status
    const before = await ADAPTER.getById(item.id, COMPANY_A);
    expect(before).not.toBeNull();
    expect(before!.status).toBe('active');

    // 3. Reject
    const rejected = await ADAPTER.reject(item.id, COMPANY_A, 'supervisor-2', 'Inaccurate data');
    expect(rejected.status).toBe('rejected');

    // 4. TraceabilityLog has previousStatus, newStatus, actor, reason
    const logs = await ADAPTER.getTraceability(item.id, COMPANY_A);
    const rejectLog = logs.find((l) => l.action === 'rejected');
    expect(rejectLog).toBeDefined();
    expect(rejectLog!.actor).toBe('supervisor-2');
    expect((rejectLog!.details as any).previousStatus).toBe('active');
    expect((rejectLog!.details as any).newStatus).toBe('rejected');
    expect((rejectLog!.details as any).reason).toBe('Inaccurate data');
  });

  // ─── T4 — FORGET ────────────────────────────────────────────────
  it('T4: Forget persists previousStatus → newStatus + reason in TraceabilityLog', async () => {
    // 1. Create item
    const item = await ADAPTER.record({
      content: 'To forget',
      type: 'fact',
      companyId: COMPANY_A,
      sourceName: 'ke06c-test-source',
      sourceAuthor: 'test-user',
    });
    createdItemIds.push(item.id);

    // 2. Verify initial status
    const before = await ADAPTER.getById(item.id, COMPANY_A);
    expect(before).not.toBeNull();
    expect(before!.status).toBe('active');

    // 3. Forget
    const forgotten = await ADAPTER.forget(item.id, 'Outdated information', COMPANY_A);
    expect(forgotten.status).toBe('forgotten');

    // 4. TraceabilityLog has previousStatus, newStatus, reason
    const logs = await ADAPTER.getTraceability(item.id, COMPANY_A);
    const forgetLog = logs.find((l) => l.action === 'forgotten');
    expect(forgetLog).toBeDefined();
    expect((forgetLog!.details as any).previousStatus).toBe('active');
    expect((forgetLog!.details as any).newStatus).toBe('forgotten');
    expect((forgetLog!.details as any).reason).toBe('Outdated information');
  });

  // ─── T5 — COMPANY ISOLATION ─────────────────────────────────────
  it('T5: Company B cannot read Company A traceability logs', async () => {
    // 1. Create item for Company A
    const item = await ADAPTER.record({
      content: 'Company A private',
      type: 'fact',
      companyId: COMPANY_A,
      sourceName: 'ke06c-test-source',
      sourceAuthor: 'test-user',
    });
    createdItemIds.push(item.id);

    // 2. Confirm it (creates traceability)
    await ADAPTER.confirm(item.id, COMPANY_A, 'auditor');

    // 3. Company A can read traceability
    const logsA = await ADAPTER.getTraceability(item.id, COMPANY_A);
    expect(logsA.length).toBeGreaterThanOrEqual(1);

    // 4. Company B cannot read traceability (returns empty)
    const logsB = await ADAPTER.getTraceability(item.id, COMPANY_B);
    expect(logsB).toHaveLength(0);
  });
});
