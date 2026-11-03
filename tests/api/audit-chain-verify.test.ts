/**
 * S10 — First-admin bootstrap hardening
 *   - BOOTSTRAP_SETUP_TOKEN gates the first-admin promotion (register flow +
 *     finalizeRegistration), and without the token the promotion still happens
 *     but is recorded as a security event.
 *
 * S12 — Audit chain activation
 *   - createAuditLogWithRetry writes hash/previousHash for NEW rows;
 *   - verifyAuditChain tolerates the mixed hashed/unhashed history;
 *   - GET /api/audit/chain-verify exposes the verdict to company_admin.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { createAuditLogWithRetry } from '@/lib/audit';
import { computeAuditHash, verifyAuditChain } from '@/lib/journal-hash';
import { AuthService } from '@/lib/services/auth.service';
import { createSession } from '@/lib/sessions';
import { createTestUser, createTestCompany, clearDatabase } from '../helpers/factories';
import { GET as chainVerifyGET } from '../../src/app/api/audit/chain-verify/route';
import { POST as registerPOST } from '../../src/app/api/auth/register/route';

const SETUP_TOKEN = 'test-bootstrap-setup-token';
const GRANT_PREFIX = 'auth:first-admin-bootstrap:';
const ROUTE_CONTEXT = { params: Promise.resolve({}) };

function registerRequest(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return new NextRequest('http://localhost/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

function registrationInput(email: string) {
  return {
    email,
    password: 'password123',
    firstName: 'First',
    lastName: 'Admin',
    companyName: `Bootstrap ${email}`,
    entityType: 'BUSINESS' as const,
  };
}

/** Runs the confirmation step the way /api/auth/verify does: inside the caller tx. */
async function finalizeRegistration(email: string, input?: ReturnType<typeof registrationInput>) {
  return db.$transaction((tx) =>
    AuthService.finalizeRegistration(tx, email, new Date(), input),
  );
}

async function promotedAuditRows() {
  return db.auditLog.findMany({ where: { action: 'SECURITY_FIRST_ADMIN_PROMOTED' } });
}

const originalSetupToken = process.env.BOOTSTRAP_SETUP_TOKEN;

beforeEach(async () => {
  delete process.env.BOOTSTRAP_SETUP_TOKEN;
  await clearDatabase();
  // The audit chain is one global sequence: this suite owns its starting point.
  await db.auditLog.deleteMany({});
  await db.systemConfig.deleteMany({ where: { key: { startsWith: GRANT_PREFIX } } });
});

afterEach(async () => {
  await db.auditLog.deleteMany({});
  await db.systemConfig.deleteMany({ where: { key: { startsWith: GRANT_PREFIX } } });
  await clearDatabase();
  if (originalSetupToken === undefined) {
    delete process.env.BOOTSTRAP_SETUP_TOKEN;
  } else {
    process.env.BOOTSTRAP_SETUP_TOKEN = originalSetupToken;
  }
});

// ─────────────────────────────────────────────────────────────────────
// S12 — createAuditLogWithRetry activates the hash chain
// ─────────────────────────────────────────────────────────────────────
describe('S12 — createAuditLogWithRetry writes the audit hash chain', () => {
  it('writes hash + previousHash so a fresh chain verifies', async () => {
    const company = await createTestCompany('Chain Write Co');

    const first = await createAuditLogWithRetry({
      companyId: company.id,
      action: 'TEST_CHAIN_FIRST',
      entity: 'AuditLog',
      entityId: 'first',
    });
    const second = await createAuditLogWithRetry({
      companyId: company.id,
      action: 'TEST_CHAIN_SECOND',
      entity: 'AuditLog',
      entityId: 'second',
    });

    expect(first.hash).toBeTruthy();
    expect(first.previousHash).toBeNull();
    expect(second.previousHash).toBe(first.hash);
    expect(second.hash).toBe(
      computeAuditHash({
        id: second.id,
        companyId: company.id,
        userId: null,
        action: 'TEST_CHAIN_SECOND',
        entity: 'AuditLog',
        entityId: 'second',
        details: null,
        previousHash: first.hash,
      }),
    );

    const verdict = await verifyAuditChain();
    expect(verdict.valid).toBe(true);
    expect(verdict.members).toBe(2);
    expect(verdict.legacyRows).toBe(0);
  });

  it('keeps the mixed hashed/unhashed history valid', async () => {
    const company = await createTestCompany('Chain Mixed Co');
    // Rows written before chaining was activated: persisted without a seal.
    await db.auditLog.create({ data: { companyId: company.id, action: 'LEGACY_A', entity: 'AuditLog' } });
    await db.auditLog.create({ data: { companyId: company.id, action: 'LEGACY_B', entity: 'AuditLog' } });

    const seeded = await db.auditLog.findMany({ where: { companyId: company.id } });
    expect(seeded.every((row) => row.hash === null)).toBe(true);

    await createAuditLogWithRetry({ companyId: company.id, action: 'TEST_MIXED_1', entity: 'AuditLog' });
    await createAuditLogWithRetry({ companyId: company.id, action: 'TEST_MIXED_2', entity: 'AuditLog' });

    const verdict = await verifyAuditChain();
    expect(verdict.valid).toBe(true);
    expect(verdict.reasonCode).toBeUndefined();
    expect(verdict.members).toBe(2);
    expect(verdict.legacyRows).toBe(2);
  });

  it('detects tampering with a chained row', async () => {
    const company = await createTestCompany('Chain Tamper Co');
    const target = await createAuditLogWithRetry({
      companyId: company.id,
      action: 'TEST_TAMPER_TARGET',
      entity: 'AuditLog',
    });
    await createAuditLogWithRetry({ companyId: company.id, action: 'TEST_TAMPER_AFTER', entity: 'AuditLog' });

    await db.auditLog.update({
      where: { id: target.id },
      data: { action: 'TEST_TAMPER_MUTATED' },
    });

    const verdict = await verifyAuditChain();
    expect(verdict.valid).toBe(false);
    expect(verdict.reasonCode).toBe('HASH_MISMATCH');
    expect(verdict.firstBreak?.entryId).toBe(target.id);
  });
});

// ─────────────────────────────────────────────────────────────────────
// S12 — GET /api/audit/chain-verify
// ─────────────────────────────────────────────────────────────────────
describe('S12 — GET /api/audit/chain-verify', () => {
  async function adminSession(email: string) {
    const admin = await createTestUser(email);
    const company = await createTestCompany(`Chain Verify ${email}`);
    await db.companyMember.create({
      data: { userId: admin.id, companyId: company.id, role: 'company_admin' },
    });
    const token = await createSession(admin.id);
    return { admin, company, token };
  }

  it('returns the audit chain verdict scoped to the caller company for a company_admin', async () => {
    const { company, token } = await adminSession('chain-verify-admin@example.com');
    await createAuditLogWithRetry({ companyId: company.id, action: 'CHAIN_VERIFY_ROW', entity: 'AuditLog' });

    const res = await chainVerifyGET(
      new NextRequest(`http://localhost/api/audit/chain-verify?companyId=${company.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
      ROUTE_CONTEXT,
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.companyId).toBe(company.id);
    expect(body.audit.valid).toBe(true);
    expect(body.audit.members).toBe(1);
    expect(body.audit.companyRows).toBe(1);
    // Journal verification is company-scoped and cheap: exposed alongside.
    expect(body.journal.valid).toBe(true);
  });

  it('rejects a viewer (company_admin required)', async () => {
    const viewer = await createTestUser('chain-verify-viewer@example.com');
    const company = await createTestCompany('Chain Verify Viewer Co');
    await db.companyMember.create({
      data: { userId: viewer.id, companyId: company.id, role: 'viewer' },
    });
    const token = await createSession(viewer.id);

    const res = await chainVerifyGET(
      new NextRequest(`http://localhost/api/audit/chain-verify?companyId=${company.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
      ROUTE_CONTEXT,
    );

    expect(res.status).toBe(403);
  });

  it('counts only the caller company rows while verifying the global chain', async () => {
    const { company, token } = await adminSession('chain-verify-scope@example.com');
    const other = await createTestCompany('Unrelated Chain Co');

    await createAuditLogWithRetry({ companyId: company.id, action: 'SCOPE_MINE', entity: 'AuditLog' });
    await createAuditLogWithRetry({ companyId: other.id, action: 'SCOPE_FOREIGN', entity: 'AuditLog' });

    const res = await chainVerifyGET(
      new NextRequest(`http://localhost/api/audit/chain-verify?companyId=${company.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
      ROUTE_CONTEXT,
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.audit.valid).toBe(true);
    expect(body.audit.members).toBe(2);
    expect(body.audit.companyRows).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────
// S10 — first-admin promotion hardening
// ─────────────────────────────────────────────────────────────────────
describe('S10 — first-admin promotion without BOOTSTRAP_SETUP_TOKEN', () => {
  it('still promotes the first confirmed registration and records a security event', async () => {
    const email = 'first-admin@example.com';
    const user = await finalizeRegistration(email, registrationInput(email));

    expect(user.platformRole).toBe('super_admin');

    const events = await promotedAuditRows();
    expect(events).toHaveLength(1);
    expect(events[0].entity).toBe('User');
    expect(events[0].entityId).toBe(user.id);
    // Platform-level event: the promoted user has no company scope of its own.
    expect(events[0].companyId).toBeNull();
  });

  it('promotes a pending pre-existing account and records the same security event', async () => {
    const email = 'pending-first-admin@example.com';
    const pending = await db.user.create({
      data: {
        email,
        passwordHash: 'placeholder',
        firstName: 'Pending',
        lastName: 'Admin',
        platformRole: 'user',
      },
    });

    const user = await finalizeRegistration(email);
    expect(user.id).toBe(pending.id);
    expect(user.platformRole).toBe('super_admin');
    expect(await promotedAuditRows()).toHaveLength(1);
  });
});

describe('S10 — registration is unchanged when no BOOTSTRAP_SETUP_TOKEN is configured', () => {
  it('accepts the registration without any token and writes no bootstrap grant', async () => {
    const email = 'plain-registration@example.com';

    const res = await registerPOST(
      registerRequest({ ...registrationInput(email), setupToken: 'ignored-without-operator-config' }),
      ROUTE_CONTEXT,
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.requiresVerification).toBe(true);
    expect(body.email).toBe(email);
    expect(await db.systemConfig.count({ where: { key: { startsWith: GRANT_PREFIX } } })).toBe(0);
    expect(await db.user.count({ where: { email } })).toBe(0);
  });
});

describe('S10 — first-admin promotion with BOOTSTRAP_SETUP_TOKEN', () => {
  it('refuses the promotion when no setup token was presented', async () => {
    process.env.BOOTSTRAP_SETUP_TOKEN = SETUP_TOKEN;
    const email = 'no-token@example.com';

    const user = await finalizeRegistration(email, registrationInput(email));

    expect(user.platformRole).toBe('user');
    expect(await promotedAuditRows()).toHaveLength(0);
    // Registration itself still completes.
    expect(user.companyMemberships).toHaveLength(1);
  });

  it('refuses the promotion when the presented token does not match', async () => {
    process.env.BOOTSTRAP_SETUP_TOKEN = SETUP_TOKEN;
    const email = 'wrong-token@example.com';

    const res = await registerPOST(
      registerRequest(registrationInput(email), { 'x-bootstrap-token': 'not-the-token' }),
      ROUTE_CONTEXT,
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('Token de inicialización inválido.');

    const user = await finalizeRegistration(email, registrationInput(email));
    expect(user.platformRole).toBe('user');
    expect(await promotedAuditRows()).toHaveLength(0);
  });

  it('rejects a registration that presents no token at all', async () => {
    process.env.BOOTSTRAP_SETUP_TOKEN = SETUP_TOKEN;
    const email = 'missing-token@example.com';

    const res = await registerPOST(registerRequest(registrationInput(email)), ROUTE_CONTEXT);

    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('Se requiere un token de inicialización.');
    expect(await db.user.count({ where: { email } })).toBe(0);
  });

  it('accepts the token from the x-bootstrap-token header and promotes the confirmed account', async () => {
    process.env.BOOTSTRAP_SETUP_TOKEN = SETUP_TOKEN;
    const email = 'header-token@example.com';

    const res = await registerPOST(
      registerRequest(registrationInput(email), { 'x-bootstrap-token': SETUP_TOKEN }),
      ROUTE_CONTEXT,
    );
    expect(res.status).toBe(200);

    const user = await finalizeRegistration(email, registrationInput(email));
    expect(user.platformRole).toBe('super_admin');
    expect(await promotedAuditRows()).toHaveLength(1);
  });

  it('accepts the token from the request body and consumes the grant once', async () => {
    process.env.BOOTSTRAP_SETUP_TOKEN = SETUP_TOKEN;
    const email = 'body-token@example.com';

    const res = await registerPOST(
      registerRequest({ ...registrationInput(email), setupToken: SETUP_TOKEN }),
      ROUTE_CONTEXT,
    );
    expect(res.status).toBe(200);

    const user = await finalizeRegistration(email, registrationInput(email));
    expect(user.platformRole).toBe('super_admin');

    // Single use: the grant cannot authorize a second promotion.
    expect(await db.systemConfig.count({ where: { key: { startsWith: GRANT_PREFIX } } })).toBe(0);

    const secondEmail = 'after-grant@example.com';
    const second = await finalizeRegistration(secondEmail, registrationInput(secondEmail));
    expect(second.platformRole).toBe('user');
  });
});
