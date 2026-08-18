import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import * as fs from 'fs';
import * as path from 'path';
import { db } from '@/lib/db';
import { clearDatabase, createTestUser, createTestCompany, createTestCompanyMember, createTestGlAccount, createTestBankAccount, createTestBankStatement, createTestBankTransaction } from '../helpers/factories';
import { createBackup } from '@/lib/backup';

const log = (...args: unknown[]) => console.log('[EVIDENCE-G4-AB-EXPORT]', ...args);

const mockGetSessionUserId = vi.hoisted(() => vi.fn().mockResolvedValue('user-placeholder'));
const mockCreateAuditLog = vi.hoisted(() => vi.fn());

vi.mock('@/lib/sessions', () => ({
  getSessionUserId: mockGetSessionUserId,
}));

vi.mock('@/lib/audit', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/lib/audit')>();
  mockCreateAuditLog.mockImplementation(mod.createAuditLogWithRetry);
  return {
    ...mod,
    createAuditLogWithRetry: mockCreateAuditLog,
  };
});

const createdCompanyIds = new Set<string>();
const diskTestCompanyIds = new Set<string>();

const BACKUP_DIR = path.join(process.cwd(), 'db', 'backups');
const MANIFEST_PATH = path.join(BACKUP_DIR, 'manifest.json');

function readManifestFile(): { companies?: Array<{ id?: string; name?: string }> } {
  if (!fs.existsSync(MANIFEST_PATH)) return { companies: [] };
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
}

function cleanupDiskArtifacts() {
  if (!fs.existsSync(BACKUP_DIR)) return;
  const manifest = readManifestFile();
  const companies = (manifest.companies || []).filter(
    (c) => !diskTestCompanyIds.has(c.id ?? c.name ?? ''),
  );
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify({ ...manifest, companies }, null, 2));
  for (const file of fs.readdirSync(BACKUP_DIR)) {
    const owner = file.split('_')[0];
    if (diskTestCompanyIds.has(owner)) {
      fs.unlinkSync(path.join(BACKUP_DIR, file));
    }
  }
}

async function cleanup() {
  cleanupDiskArtifacts();
  if (createdCompanyIds.size > 0) {
    await db.companyKnowledge.deleteMany({ where: { companyId: { in: [...createdCompanyIds] } } }).catch(() => {});
    await db.companyMember.deleteMany({ where: { companyId: { in: [...createdCompanyIds] } } }).catch(() => {});
    await db.company.deleteMany({ where: { id: { in: [...createdCompanyIds] } } }).catch(() => {});
    createdCompanyIds.clear();
  }
  await clearDatabase();
}

describe('G4-AB-EXPORT-DOWNLOAD — Export, download, report and backup matrix (A/B)', () => {
  beforeEach(async () => {
    await cleanup();
    vi.restoreAllMocks();
    mockGetSessionUserId.mockResolvedValue('user-placeholder');
  });

  afterEach(async () => {
    await cleanup();
    vi.restoreAllMocks();
  });

  async function seedTenants() {
    const tenantA = await createTestCompany('G4 AB Export Tenant A');
    createdCompanyIds.add(tenantA.id);
    const tenantB = await createTestCompany('G4 AB Export Tenant B');
    createdCompanyIds.add(tenantB.id);
    const attacker = await createTestUser('attacker-g4abex@example.com');
    await createTestCompanyMember(attacker.id, tenantA.id);
    const ownerB = await createTestUser('owner-g4abex@example.com');
    await createTestCompanyMember(ownerB.id, tenantB.id);
    return { tenantA, tenantB, attacker, ownerB };
  }

  it('A-spoof: GET /api/accounting-flow/export?companyId=B — non-member blocked (403)', async () => {
    const { tenantB, attacker } = await seedTenants();
    mockGetSessionUserId.mockResolvedValue(attacker.id);

    const { GET } = await import('@/app/api/accounting-flow/export/route');
    const res = await GET(
      new NextRequest(
        `http://localhost/api/accounting-flow/export?companyId=${tenantB.id}&startDate=2025-01-01&endDate=2025-12-31`,
        { method: 'GET', headers: { 'Content-Type': 'application/json' } },
      ),
    );
    log('A-spoof accounting-flow status:', res.status);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('Forbidden');
  });

  it('B: GET /api/accounting-flow/export?companyId=B — owner exports own cash flow (200 CSV with real data)', async () => {
    const { tenantB, ownerB } = await seedTenants();
    const cashGl = await createTestGlAccount({ companyId: tenantB.id, code: '1000', name: 'Cash B' });
    const expenseGl = await createTestGlAccount({ companyId: tenantB.id, code: '6000', name: 'Expense B' });
    await createTestBankAccount(tenantB.id, cashGl.id, 'Own Bank B');
    await db.journalEntry.create({
      data: {
        companyId: tenantB.id,
        date: new Date('2025-06-15'),
        description: 'Cash inflow test B',
        status: 'posted',
        lines: {
          create: [
            { glAccountId: cashGl.id, debit: 500, credit: 0 },
            { glAccountId: expenseGl.id, debit: 0, credit: 500 },
          ],
        },
      },
    });
    mockGetSessionUserId.mockResolvedValue(ownerB.id);

    const { GET } = await import('@/app/api/accounting-flow/export/route');
    const res = await GET(
      new NextRequest(
        `http://localhost/api/accounting-flow/export?companyId=${tenantB.id}&startDate=2025-01-01&endDate=2025-12-31`,
        { method: 'GET', headers: { 'Content-Type': 'application/json' } },
      ),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    const text = await res.text();
    expect(text).toContain('Cash inflow test B');
    expect(text).toContain('Compañía');
  });

  it('A-spoof: GET /api/reports/export?companyId=B — non-member blocked (403)', async () => {
    const { tenantB, attacker } = await seedTenants();
    mockGetSessionUserId.mockResolvedValue(attacker.id);

    const { GET } = await import('@/app/api/reports/export/route');
    const res = await GET(
      new NextRequest(
        `http://localhost/api/reports/export?companyId=${tenantB.id}&type=trial_balance&format=csv&startDate=2025-01-01&endDate=2025-12-31`,
        { method: 'GET', headers: { 'Content-Type': 'application/json' } },
      ),
    );
    log('A-spoof reports/export status:', res.status);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('Forbidden');
  });

  it('B: GET /api/reports/export?companyId=B — owner exports own trial balance with integrity hash (200 + audit)', async () => {
    const { tenantB, ownerB } = await seedTenants();
    mockGetSessionUserId.mockResolvedValue(ownerB.id);

    const { GET } = await import('@/app/api/reports/export/route');
    const res = await GET(
      new NextRequest(
        `http://localhost/api/reports/export?companyId=${tenantB.id}&type=trial_balance&format=csv&startDate=2025-01-01&endDate=2025-12-31`,
        { method: 'GET', headers: { 'Content-Type': 'application/json' } },
      ),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Integrity-Hash')).toBeTruthy();
    expect(res.headers.get('content-type')).toContain('text/csv');
    const text = await res.text();
    expect(text.length).toBeGreaterThan(0);

    const audit = await db.auditLog.findFirst({
      where: { companyId: tenantB.id, action: 'REPORT_EXPORTED' },
    });
    expect(audit).toBeTruthy();
  });

  it('A-id: GET /api/export/csv — reconciliation with victim bank account of B leaks nothing (200 error.csv)', async () => {
    const { tenantA, tenantB, attacker } = await seedTenants();
    const bankGl = await createTestGlAccount({ companyId: tenantB.id, code: '1000', name: 'Cash B' });
    const bank = await createTestBankAccount(tenantB.id, bankGl.id, 'Victim Bank B');
    const statement = await createTestBankStatement(tenantB.id, bank.id);
    await createTestBankTransaction(tenantB.id, statement.id, {
      date: '2025-06-15',
      amount: 9999,
      description: 'SUPER SECRET VICTIM TX',
    });
    mockGetSessionUserId.mockResolvedValue(attacker.id);

    const { GET } = await import('@/app/api/export/csv/route');
    const res = await GET(
      new NextRequest(
        `http://localhost/api/export/csv?type=reconciliation&companyId=${tenantA.id}&bankAccountId=${bank.id}`,
        { method: 'GET', headers: { 'Content-Type': 'application/json' } },
      ),
    );
    log('A-id export/csv reconciliation status:', res.status);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('Error: Bank account not found');
    expect(text).not.toContain('SUPER SECRET VICTIM TX');
    expect(text).not.toContain('9999');
  });

  it('A-spoof: GET /api/export/csv?companyId=B — non-member blocked (403)', async () => {
    const { tenantB, attacker } = await seedTenants();
    mockGetSessionUserId.mockResolvedValue(attacker.id);

    const { GET } = await import('@/app/api/export/csv/route');
    const res = await GET(
      new NextRequest(`http://localhost/api/export/csv?type=chart_of_accounts&companyId=${tenantB.id}`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    log('A-spoof export/csv status:', res.status);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('Forbidden');
  });

  it('B: GET /api/export/csv — owner exports own chart of accounts (200 CSV with BOM, own codes only)', async () => {
    const { tenantA, tenantB, ownerB } = await seedTenants();
    await createTestGlAccount({ companyId: tenantA.id, code: '9999', name: 'Attacker Hidden Account' });
    const ownGl = await createTestGlAccount({ companyId: tenantB.id, code: '2222', name: 'Own Account B' });
    mockGetSessionUserId.mockResolvedValue(ownerB.id);

    const { GET } = await import('@/app/api/export/csv/route');
    const res = await GET(
      new NextRequest(`http://localhost/api/export/csv?type=chart_of_accounts&companyId=${tenantB.id}`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    const buf = new Uint8Array(await res.arrayBuffer());
    expect([buf[0], buf[1], buf[2]]).toEqual([0xef, 0xbb, 0xbf]);
    const text = new TextDecoder().decode(buf);
    expect(text).toContain('2222');
    expect(text).toContain('Own Account B');
    expect(text).not.toContain('9999');
    expect(text).not.toContain('Attacker Hidden Account');
  });

  it('B: GET /api/export/csv — owner exports own reconciliation CSV (200 with own transactions)', async () => {
    const { tenantA, tenantB, ownerB } = await seedTenants();
    const bankGl = await createTestGlAccount({ companyId: tenantB.id, code: '1000', name: 'Cash B' });
    const bank = await createTestBankAccount(tenantB.id, bankGl.id, 'Own Bank B');
    const statement = await createTestBankStatement(tenantB.id, bank.id);
    await createTestBankTransaction(tenantB.id, statement.id, {
      date: '2025-06-15',
      amount: 123.45,
      description: 'OWN VISIBLE TX',
    });
    await createTestGlAccount({ companyId: tenantA.id, code: '7777', name: 'Attacker Other' });
    mockGetSessionUserId.mockResolvedValue(ownerB.id);

    const { GET } = await import('@/app/api/export/csv/route');
    const res = await GET(
      new NextRequest(
        `http://localhost/api/export/csv?type=reconciliation&companyId=${tenantB.id}&bankAccountId=${bank.id}`,
        { method: 'GET', headers: { 'Content-Type': 'application/json' } },
      ),
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('OWN VISIBLE TX');
    expect(text).toContain('123.45');
  });

  it('A-spoof: GET /api/export/pdf?companyId=B — non-member blocked (403)', async () => {
    const { tenantB, attacker } = await seedTenants();
    mockGetSessionUserId.mockResolvedValue(attacker.id);

    const { GET } = await import('@/app/api/export/pdf/route');
    const res = await GET(
      new NextRequest(`http://localhost/api/export/pdf?type=trial_balance&companyId=${tenantB.id}`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    log('A-spoof export/pdf status:', res.status);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('Forbidden');
  });

  it('B: GET /api/export/pdf — owner exports own PDF report (200 HTML with legalName)', async () => {
    const { tenantB, ownerB } = await seedTenants();
    mockGetSessionUserId.mockResolvedValue(ownerB.id);

    const { GET } = await import('@/app/api/export/pdf/route');
    const res = await GET(
      new NextRequest(`http://localhost/api/export/pdf?type=trial_balance&companyId=${tenantB.id}`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const text = await res.text();
    expect(text).toContain(tenantB.legalName);
  });

  it('A-id: GET /api/reconciliation/report — member of A cannot read reconciliation of B (404 neutral)', async () => {
    const { tenantA, tenantB, attacker } = await seedTenants();
    const bankGl = await createTestGlAccount({ companyId: tenantB.id, code: '1000', name: 'Cash B' });
    const bank = await createTestBankAccount(tenantB.id, bankGl.id, 'Victim Bank B');
    mockGetSessionUserId.mockResolvedValue(attacker.id);

    const { GET } = await import('@/app/api/reconciliation/report/route');
    const res = await GET(
      new NextRequest(
        `http://localhost/api/reconciliation/report?companyId=${tenantA.id}&bankAccountId=${bank.id}`,
        { method: 'GET', headers: { 'Content-Type': 'application/json' } },
      ),
    );
    log('A-id reconciliation/report status:', res.status);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('Bank account not found');
  });

  it('A-spoof: GET /api/reconciliation/report?companyId=B — non-member blocked (403)', async () => {
    const { tenantB, attacker } = await seedTenants();
    const bankGl = await createTestGlAccount({ companyId: tenantB.id, code: '1000', name: 'Cash B' });
    const bank = await createTestBankAccount(tenantB.id, bankGl.id, 'Victim Bank B');
    mockGetSessionUserId.mockResolvedValue(attacker.id);

    const { GET } = await import('@/app/api/reconciliation/report/route');
    const res = await GET(
      new NextRequest(
        `http://localhost/api/reconciliation/report?companyId=${tenantB.id}&bankAccountId=${bank.id}`,
        { method: 'GET', headers: { 'Content-Type': 'application/json' } },
      ),
    );
    log('A-spoof reconciliation/report status:', res.status);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('Forbidden');
  });

  it('B: GET /api/reconciliation/report — owner reads own reconciliation report (200 with balancePerBooks)', async () => {
    const { tenantB, ownerB } = await seedTenants();
    const bankGl = await createTestGlAccount({ companyId: tenantB.id, code: '1000', name: 'Cash B' });
    const bank = await createTestBankAccount(tenantB.id, bankGl.id, 'Own Bank B');
    mockGetSessionUserId.mockResolvedValue(ownerB.id);

    const { GET } = await import('@/app/api/reconciliation/report/route');
    const res = await GET(
      new NextRequest(
        `http://localhost/api/reconciliation/report?companyId=${tenantB.id}&bankAccountId=${bank.id}`,
        { method: 'GET', headers: { 'Content-Type': 'application/json' } },
      ),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('report');
    expect(body.report).toHaveProperty('balancePerBooks');
    expect(body.bankAccount.id).toBe(bank.id);
  });

  it('A-id: GET /api/backup/[filename] — member of A cannot download backup of B (400 invalid filename, no leak)', async () => {
    const { tenantA, tenantB, attacker } = await seedTenants();
    const backup = await createBackup(tenantB.id);
    diskTestCompanyIds.add(tenantB.id);
    mockGetSessionUserId.mockResolvedValue(attacker.id);

    const filename = backup.filename;
    const { GET } = await import('@/app/api/backup/[filename]/route');
    const res = await GET(
      new NextRequest(`http://localhost/api/backup/${filename}?companyId=${tenantA.id}`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      }),
      { params: Promise.resolve({ filename }) },
    );
    log('A-id backup status:', res.status);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Invalid filename');
  });

  it('A-spoof: GET /api/backup/[filename]?companyId=B — non-member blocked (403)', async () => {
    const { tenantB, attacker } = await seedTenants();
    const backup = await createBackup(tenantB.id);
    diskTestCompanyIds.add(tenantB.id);
    mockGetSessionUserId.mockResolvedValue(attacker.id);

    const filename = backup.filename;
    const { GET } = await import('@/app/api/backup/[filename]/route');
    const res = await GET(
      new NextRequest(`http://localhost/api/backup/${filename}?companyId=${tenantB.id}`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      }),
      { params: Promise.resolve({ filename }) },
    );
    log('A-spoof backup status:', res.status);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('Forbidden');
  });

  it('B: GET /api/backup/[filename] — owner downloads own backup (200 with base64 data + audit)', async () => {
    const { tenantB, ownerB } = await seedTenants();
    const backup = await createBackup(tenantB.id);
    diskTestCompanyIds.add(tenantB.id);
    mockGetSessionUserId.mockResolvedValue(ownerB.id);

    const filename = backup.filename;
    const { GET } = await import('@/app/api/backup/[filename]/route');
    const res = await GET(
      new NextRequest(`http://localhost/api/backup/${filename}?companyId=${tenantB.id}`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      }),
      { params: Promise.resolve({ filename }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.filename).toBe(filename);
    expect(body.size).toBe(backup.size);
    expect(body.data).toBeTruthy();

    const decoded = Buffer.from(body.data, 'base64').toString('utf-8');
    expect(decoded).toContain(tenantB.legalName);

    const audit = await db.auditLog.findFirst({
      where: { companyId: tenantB.id, action: 'SECURITY_BACKUP_DOWNLOADED', entityId: filename },
    });
    expect(audit).toBeTruthy();
    const details = JSON.parse(audit?.details ?? '{}');
    expect(details.contractVersion).toBe(1);
    expect(details.size).toBe(backup.size);
  });
});