import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { createSession } from '@/lib/sessions';
import {
  clearDatabase,
  createTestUser,
  createTestCompany,
  createTestCompanyMember,
  createTestGlAccount,
} from '../helpers/factories';
import { GET as exportGET } from '@/app/api/reports/export/route';

/**
 * S23b — the "PDF" export used to answer `Content-Type: application/pdf` with a
 * plain-text placeholder, and the UI called it "PDF Firmado" even though nothing
 * was a PDF and nothing was signed.
 *
 * Contract now: the printable format is a real browser PRINT VIEW (HTML a
 * browser can print/save as PDF), it never claims to be a PDF document and it
 * never claims to be signed.
 */

async function seed(): Promise<{ token: string; companyId: string }> {
  const user = await createTestUser('wave3-export@example.com');
  const company = await createTestCompany('Wave3 Export');
  await createTestCompanyMember(user.id, company.id);
  const token = await createSession(user.id);

  const cash = await createTestGlAccount({
    companyId: company.id,
    code: '1010',
    name: 'Cash',
    accountType: 'asset',
    normalBalance: 'debit',
  });
  const sales = await createTestGlAccount({
    companyId: company.id,
    code: '4010',
    name: 'Sales <script>',
    accountType: 'revenue',
    normalBalance: 'credit',
  });

  await db.journalEntry.create({
    data: {
      companyId: company.id,
      date: new Date('2025-04-10T00:00:00.000Z'),
      description: 'Sale',
      status: 'posted',
      lines: {
        create: [
          { glAccountId: cash.id, debit: 500, credit: 0 },
          { glAccountId: sales.id, debit: 0, credit: 500 },
        ],
      },
    },
  });

  return { token, companyId: company.id };
}

function call(ctx: { token: string; companyId: string }, type: string, format: string) {
  return exportGET(
    new NextRequest(
      `http://localhost/api/reports/export?companyId=${ctx.companyId}&type=${type}&format=${format}&startDate=2025-01-01&endDate=2025-12-31`,
      { headers: { Authorization: `Bearer ${ctx.token}` } },
    ),
    { params: Promise.resolve({}) },
  );
}

describe('S23b — /api/reports/export printable format', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  it('renders a real print view instead of a fake PDF', async () => {
    const ctx = await seed();

    const res = await call(ctx, 'trial_balance', 'print');

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/html');
    expect(res.headers.get('Content-Type')).not.toContain('application/pdf');
    expect(res.headers.get('X-Integrity-Hash')).toBeTruthy();

    const html = await res.text();
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('Imprimir / Guardar como PDF');
    expect(html).toContain('@media print');
    expect(html).toContain('@page');
    // Honest wording: not signed, not an official filing.
    expect(html).toContain('NO está firmado digitalmente');
    expect(html).not.toMatch(/PDF MOCK/i);
    expect(html).not.toMatch(/PDF Firmado/i);
    // Account names are escaped, never injected raw.
    expect(html).toContain('Sales &lt;script&gt;');
    expect(html).not.toContain('<script>');
  });

  it('treats the legacy format=pdf request as the same print view, never as application/pdf', async () => {
    const ctx = await seed();

    const res = await call(ctx, 'balance_sheet', 'pdf');

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('Imprimir / Guardar como PDF');
    expect(html).not.toMatch(/Firmado/);
  });

  it('keeps the CSV export byte-compatible with the previous contract', async () => {
    const ctx = await seed();

    const res = await call(ctx, 'trial_balance', 'csv');

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/csv');
    expect(res.headers.get('Content-Disposition')).toContain('attachment');
    const csv = await res.text();
    expect(csv).toContain('LQ&OM LLC');
    expect(csv).toContain('Código,Cuenta,Tipo,Débito,Crédito,Saldo Neto');
  });

  it('does not offer a "signed PDF" option in the export modal', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/components/reports/ReportExportModal.tsx'),
      'utf8',
    );

    expect(source).not.toMatch(/Firmado/);
    expect(source).not.toMatch(/value="pdf"/);
    expect(source).toContain('value="print"');
    expect(source).toContain('Imprimir / Guardar como PDF');
    // The internal-use warning stays, minus the false signing claim.
    expect(source).toContain('No está firmado digitalmente');
  });
});
