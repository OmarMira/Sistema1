/**
 * S19(a) — Account hierarchy must never become a cycle.
 *
 * Before this change:
 *   - PUT /api/accounts/[id] only rejected `parentId === id`, so making an
 *     account the child of its own descendant created a cycle.
 *   - collectDescendantIds (DELETE) and getAccumulatedBalance (GET list)
 *     recursed without a visited set, so a forced cycle looped forever
 *     (stack/DB recursion) instead of answering the request.
 *
 * These tests pin:
 *   - a parent change that would close a cycle is rejected with a clear error
 *     (2-node and 3-node cases, same-company ancestor walk),
 *   - both walkers terminate on a forced cycle,
 *   - normal trees (valid re-parent, descendant delete, journal-line blocker,
 *     cross-company parent) keep their previous behavior.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { PUT as updatePUT, DELETE as deleteDELETE } from '../../src/app/api/accounts/[id]/route';
import { GET as listGET } from '../../src/app/api/accounts/route';
import {
  createTestUser,
  createTestCompany,
  createTestCompanyMember,
  createTestGlAccount,
  createTestJournalEntry,
  clearDatabase,
} from '../helpers/factories';
import { createSession } from '@/lib/sessions';
import { db } from '@/lib/db';
import { initializeDefaultCompanyModuleEntitlements } from '@/lib/services/module-entitlement-initialization';

function putAccount(companyId: string, token: string, id: string, body: Record<string, unknown>) {
  return updatePUT(
    new NextRequest(`http://localhost/api/accounts/${id}?companyId=${companyId}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
}

function deleteAccount(companyId: string, token: string, id: string) {
  return deleteDELETE(
    new NextRequest(`http://localhost/api/accounts/${id}?companyId=${companyId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    }),
    { params: Promise.resolve({ id }) },
  );
}

function listAccounts(companyId: string, token: string) {
  return listGET(
    new NextRequest(`http://localhost/api/accounts?companyId=${companyId}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    }),
    { params: Promise.resolve({}) },
  );
}

async function link(parentId: string, childId: string) {
  await db.glAccount.update({ where: { id: childId }, data: { parentId } });
}

async function seedCompany(email: string, name: string) {
  const user = await createTestUser(email);
  const company = await createTestCompany(name);
  await createTestCompanyMember(user.id, company.id);
  await initializeDefaultCompanyModuleEntitlements(db, company.id);
  const token = await createSession(user.id);
  return { user, company, token };
}

describe('S19(a) — ciclos de jerarquía de cuentas', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  // ── Ciclos rechazados en el cambio de padre ────────────────────────────
  it('rechaza poner un descendiente directo como padre (ciclo de 2)', async () => {
    const { company, token } = await seedCompany('s19a-direct@example.com', 'S19a Direct Co');
    const root = await createTestGlAccount({ companyId: company.id, code: '1100', name: 'Root' });
    const child = await createTestGlAccount({ companyId: company.id, code: '1101', name: 'Child' });
    await link(root.id, child.id);

    const res = await putAccount(company.id, token, root.id, { parentId: child.id });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/descendant/i);
    expect(body.error).toMatch(/circular/i);

    // The rejected update must not be persisted.
    const rootAfter = await db.glAccount.findUniqueOrThrow({ where: { id: root.id } });
    expect(rootAfter.parentId).toBeNull();
    const childAfter = await db.glAccount.findUniqueOrThrow({ where: { id: child.id } });
    expect(childAfter.parentId).toBe(root.id);
  });

  it('rechaza poner un descendiente profundo como padre (ciclo de 3)', async () => {
    const { company, token } = await seedCompany('s19a-deep@example.com', 'S19a Deep Co');
    const a = await createTestGlAccount({ companyId: company.id, code: '1200', name: 'A' });
    const b = await createTestGlAccount({ companyId: company.id, code: '1201', name: 'B' });
    const c = await createTestGlAccount({ companyId: company.id, code: '1202', name: 'C' });
    await link(a.id, b.id);
    await link(b.id, c.id);

    const res = await putAccount(company.id, token, a.id, { parentId: c.id });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/descendant/i);
    expect(body.error).toMatch(/circular/i);

    const aAfter = await db.glAccount.findUniqueOrThrow({ where: { id: a.id } });
    expect(aAfter.parentId).toBeNull();
  });

  it('rechaza también el ciclo formado en la rama intermedia', async () => {
    const { company, token } = await seedCompany('s19a-middle@example.com', 'S19a Middle Co');
    const a = await createTestGlAccount({ companyId: company.id, code: '1300', name: 'A' });
    const b = await createTestGlAccount({ companyId: company.id, code: '1301', name: 'B' });
    const c = await createTestGlAccount({ companyId: company.id, code: '1302', name: 'C' });
    await link(a.id, b.id);
    await link(b.id, c.id);

    // B cannot be re-parented under C (its own child).
    const res = await putAccount(company.id, token, b.id, { parentId: c.id });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/descendant/i);

    const bAfter = await db.glAccount.findUniqueOrThrow({ where: { id: b.id } });
    expect(bAfter.parentId).toBe(a.id);
  });

  // ── PRESERVE: comportamiento previo del código modificado ─────────────
  it('PRESERVE: sigue rechazando una cuenta como su propio padre', async () => {
    const { company, token } = await seedCompany('s19a-self@example.com', 'S19a Self Co');
    const account = await createTestGlAccount({ companyId: company.id, code: '1400', name: 'Self' });

    const res = await putAccount(company.id, token, account.id, { parentId: account.id });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('An account cannot be its own parent');
    const after = await db.glAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(after.parentId).toBeNull();
  });

  it('PRESERVE: permite reasignar a un padre válido fuera de la rama', async () => {
    const { company, token } = await seedCompany('s19a-reparent@example.com', 'S19a Reparent Co');
    const a = await createTestGlAccount({ companyId: company.id, code: '1500', name: 'A' });
    const b = await createTestGlAccount({ companyId: company.id, code: '1501', name: 'B' });
    const other = await createTestGlAccount({ companyId: company.id, code: '1502', name: 'Other' });
    await link(a.id, b.id);

    const res = await putAccount(company.id, token, b.id, { parentId: other.id });

    expect(res.status).toBe(200);
    const after = await db.glAccount.findUniqueOrThrow({ where: { id: b.id } });
    expect(after.parentId).toBe(other.id);
  });

  it('PRESERVE: no permite usar como padre una cuenta de otra empresa', async () => {
    const { company, token } = await seedCompany('s19a-foreign@example.com', 'S19a Foreign Co');
    const foreign = await createTestCompany('S19a Foreign Target Co');
    const account = await createTestGlAccount({ companyId: company.id, code: '1600', name: 'Mine' });
    const foreignAccount = await createTestGlAccount({
      companyId: foreign.id,
      code: '1601',
      name: 'Foreign',
    });

    const res = await putAccount(company.id, token, account.id, { parentId: foreignAccount.id });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('Parent account not found');
  });

  // ── Walkers con visited-set ───────────────────────────────────────────
  it('DELETE termina en un árbol normal y desvincula a los hijos', async () => {
    const { company, token } = await seedCompany('s19a-tree@example.com', 'S19a Tree Co');
    const a = await createTestGlAccount({ companyId: company.id, code: '1700', name: 'A' });
    const b = await createTestGlAccount({ companyId: company.id, code: '1701', name: 'B' });
    const c = await createTestGlAccount({ companyId: company.id, code: '1702', name: 'C' });
    await link(a.id, b.id);
    await link(b.id, c.id);

    const res = await deleteAccount(company.id, token, a.id);

    expect(res.status).toBe(200);
    expect(await db.glAccount.findUnique({ where: { id: a.id } })).toBeNull();
    const bAfter = await db.glAccount.findUniqueOrThrow({ where: { id: b.id } });
    expect(bAfter.parentId).toBeNull();
    const cAfter = await db.glAccount.findUniqueOrThrow({ where: { id: c.id } });
    expect(cAfter.parentId).toBe(b.id);
  });

  it('PRESERVE: DELETE sigue bloqueando si hay asientos en una sub-cuenta', async () => {
    const { company, token } = await seedCompany('s19a-lines@example.com', 'S19a Lines Co');
    const parent = await createTestGlAccount({ companyId: company.id, code: '1800', name: 'Parent' });
    const child = await createTestGlAccount({ companyId: company.id, code: '1801', name: 'Child' });
    const counter = await createTestGlAccount({ companyId: company.id, code: '1802', name: 'Counter' });
    await link(parent.id, child.id);

    await createTestJournalEntry(company.id, {
      date: '2026-06-01',
      description: 'Line in child',
      lines: [
        { glAccountId: child.id, debit: 10, credit: 0 },
        { glAccountId: counter.id, debit: 0, credit: 10 },
      ],
    });

    const res = await deleteAccount(company.id, token, parent.id);

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain('sub-cuenta');
    expect(await db.glAccount.findUnique({ where: { id: parent.id } })).not.toBeNull();
  });

  it('el walker de DELETE ignora descendientes de otra empresa (company-scoped)', async () => {
    const { company, token } = await seedCompany('s19a-scope@example.com', 'S19a Scope Co');
    const foreign = await createTestCompany('S19a Scope Foreign Co');
    const parent = await createTestGlAccount({ companyId: company.id, code: '1900', name: 'Parent' });
    const foreignChild = await createTestGlAccount({
      companyId: foreign.id,
      code: '1901',
      name: 'Foreign child',
    });
    const foreignCounter = await createTestGlAccount({
      companyId: foreign.id,
      code: '1902',
      name: 'Foreign counter',
    });
    // Cross-tenant row (data corruption simulated directly in the DB).
    await link(parent.id, foreignChild.id);
    await createTestJournalEntry(foreign.id, {
      date: '2026-06-01',
      description: 'Foreign line',
      lines: [
        { glAccountId: foreignChild.id, debit: 5, credit: 0 },
        { glAccountId: foreignCounter.id, debit: 0, credit: 5 },
      ],
    });

    const res = await deleteAccount(company.id, token, parent.id);

    // The foreign descendant is not part of this company's hierarchy: it does
    // not block the delete, and the DB FK detaches it.
    expect(res.status).toBe(200);
    expect(await db.glAccount.findUnique({ where: { id: parent.id } })).toBeNull();
    const foreignAfter = await db.glAccount.findUniqueOrThrow({ where: { id: foreignChild.id } });
    expect(foreignAfter.parentId).toBeNull();
  });

  it('GET /api/accounts termina con un ciclo forzado en la jerarquía', async () => {
    const { company, token } = await seedCompany('s19a-get-cycle@example.com', 'S19a Get Cycle Co');
    const a = await createTestGlAccount({ companyId: company.id, code: '2000', name: 'A' });
    const b = await createTestGlAccount({ companyId: company.id, code: '2001', name: 'B' });
    const counter = await createTestGlAccount({ companyId: company.id, code: '2002', name: 'Counter' });
    // Force the cycle that the API now rejects (simulates pre-existing data).
    await link(b.id, a.id);
    await link(a.id, b.id);

    await createTestJournalEntry(company.id, {
      date: '2026-06-01',
      description: 'Direct line on A',
      lines: [
        { glAccountId: a.id, debit: 3, credit: 0 },
        { glAccountId: counter.id, debit: 0, credit: 3 },
      ],
    });

    const res = await listAccounts(company.id, token);

    expect(res.status).toBe(200);
    const body = await res.json();
    const accounts = body.accounts as { id: string; balance: number; directBalance: number }[];
    const accountA = accounts.find((acc) => acc.id === a.id);
    const accountB = accounts.find((acc) => acc.id === b.id);
    expect(accountA).toBeDefined();
    expect(accountB).toBeDefined();
    // Terminates and reports finite numbers instead of recursing forever.
    expect(Number.isFinite(accountA!.balance)).toBe(true);
    expect(Number.isFinite(accountB!.balance)).toBe(true);
    expect(accountA!.directBalance).toBe(3);
    expect(accountB!.directBalance).toBe(0);
    expect(accountA!.balance).toBe(3);
  });

  it('DELETE termina con un ciclo forzado en la jerarquía', async () => {
    const { company, token } = await seedCompany('s19a-del-cycle@example.com', 'S19a Del Cycle Co');
    const a = await createTestGlAccount({ companyId: company.id, code: '2100', name: 'A' });
    const b = await createTestGlAccount({ companyId: company.id, code: '2101', name: 'B' });
    await link(b.id, a.id);
    await link(a.id, b.id);

    const res = await deleteAccount(company.id, token, a.id);

    expect(res.status).toBe(200);
    expect(await db.glAccount.findUnique({ where: { id: a.id } })).toBeNull();
    const bAfter = await db.glAccount.findUniqueOrThrow({ where: { id: b.id } });
    expect(bAfter.parentId).toBeNull();
  });
});
