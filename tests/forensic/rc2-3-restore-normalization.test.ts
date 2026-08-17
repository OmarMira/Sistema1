import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { db } from '@/lib/db';
import {
  restoreBackup,
  normalizeRestoredUserRole,
  normalizeRestoredMembershipRole,
  createBackup,
  type BackupData,
} from '@/lib/backup';
import { createTestUser, createTestCompany, createTestCompanyMember, clearDatabase } from '../helpers/factories';

const log = (...args: unknown[]) => console.log('[EVIDENCE]', ...args);

function buildBackup(
  company: { id: string; legalName: string },
  overrides: Partial<{
    userRole: unknown;
    memberRole: unknown;
    userExtra?: Record<string, unknown>[];
    memberExtra?: Record<string, unknown>[];
    withHash?: boolean;
  }> = {},
): BackupData {
  const user = {
    id: `rc2-3-user-${crypto.randomUUID()}`,
    email: `rc2-3-${crypto.randomUUID()}@example.com`,
    firstName: 'RC',
    lastName: 'Three',
    role: overrides.userRole ?? 'super_admin',
    isActive: true,
  };
  const member = {
    id: `rc2-3-member-${crypto.randomUUID()}`,
    userId: user.id,
    companyId: company.id,
    role: overrides.memberRole ?? 'company_admin',
    joinedAt: new Date().toISOString(),
  };
  const companyData = {
    id: company.id,
    legalName: company.legalName,
    entityType: 'BUSINESS',
    taxId: '12-3456789',
    isActive: true,
  };
  const backupData: BackupData = {
    manifest: {
      version: '1.0.0',
      createdAt: new Date().toISOString(),
      companyId: company.id,
      companyInfo: { id: company.id, legalName: company.legalName, taxId: '12-3456789' },
      recordCounts: {
        company: 1,
        glAccounts: 0,
        bankAccounts: 0,
        bankStatements: 0,
        bankTransactions: 0,
        bankRules: 0,
        journalEntries: 0,
        journalLines: 0,
        fiscalPeriods: 0,
        companyMembers: 1 + (overrides.memberExtra?.length ?? 0),
        users: 1 + (overrides.userExtra?.length ?? 0),
        systemConfig: 0,
        companyConfig: false,
      },
    },
    data: {
      company: [companyData],
      users: [user, ...(overrides.userExtra ?? [])],
      companyMembers: [member, ...(overrides.memberExtra ?? [])],
      glAccounts: [],
      bankAccounts: [],
      bankStatements: [],
      bankTransactions: [],
      bankRules: [],
      journalEntries: [],
      journalLines: [],
      fiscalPeriods: [],
      systemConfig: [],
      companyConfig: null,
    },
  };
  return backupData;
}

describe('RC2-3 — restore role normalization (actor-gated super_admin)', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  afterAll(async () => {
    log('AFTER-ALL: remaining @example.com users =', await db.user.count({ where: { email: { contains: '@example.com' } } }));
  });

  it('N1: normal actor + backup User.role="super_admin" → persisted as "user"', async () => {
    const company = await createTestCompany('N1 Co');
    await createTestUser('n1-actor@example.com');
    await createTestCompanyMember((await db.user.findUnique({ where: { email: 'n1-actor@example.com' } }))!.id, company.id);
    const backupData = buildBackup(company, { userRole: 'super_admin', memberRole: 'company_admin' });

    const actor = await db.user.findUnique({ where: { email: 'n1-actor@example.com' } });
    const result = await restoreBackup(company.id, backupData, actor!.id, {
      restoringActorIsSuperAdmin: false,
    });
    const restoredUser = await db.user.findUnique({ where: { id: backupData.data.users[0].id as string } });

    log('N1: success =', result.success, '| stored user role =', restoredUser?.role);
    expect(result.success).toBe(true);
    expect(restoredUser?.role).toBe('user');
  });

  it('N2: global super_admin actor + backup User.role="super_admin" → preserved as "super_admin"', async () => {
    const company = await createTestCompany('N2 Co');
    const actor = await db.user.create({
      data: {
        email: 'n2-super@example.com',
        passwordHash: 'x',
        firstName: 'A',
        lastName: 'B',
        role: 'super_admin',
      },
    });
    await createTestCompanyMember(actor.id, company.id);
    const backupData = buildBackup(company, { userRole: 'super_admin', memberRole: 'company_admin' });

    const result = await restoreBackup(company.id, backupData, actor.id, {
      restoringActorIsSuperAdmin: true,
    });
    const restoredUser = await db.user.findUnique({ where: { id: backupData.data.users[0].id as string } });

    log('N2: success =', result.success, '| stored user role =', restoredUser?.role);
    expect(result.success).toBe(true);
    expect(restoredUser?.role).toBe('super_admin');
  });

  it('N3: bootstrap restore + backup User.role="super_admin" → preserved as "super_admin"', async () => {
    const company = await createTestCompany('N3 Co');
    // The bootstrap route runs restore with userId='system_bootstrap', which the
    // audit RESTORE_COMPLETED row references by FK. In the real bootstrap flow
    // that user is itself restored from the backup, so include it here too.
    const backupData = buildBackup(company, {
      userRole: 'super_admin',
      memberRole: 'company_admin',
      userExtra: [{ id: 'system_bootstrap', email: 'sys-boot@example.com', firstName: 'Sys', lastName: 'Boot', role: 'super_admin', isActive: true }],
      memberExtra: [{ id: 'sys-boot-member', userId: 'system_bootstrap', companyId: company.id, role: 'company_admin', joinedAt: new Date().toISOString() }],
    });

    const result = await restoreBackup(company.id, backupData, 'system_bootstrap', { bootstrap: true });
    const restoredUser = await db.user.findUnique({ where: { id: backupData.data.users[0].id as string } });
    const bootUser = await db.user.findUnique({ where: { id: 'system_bootstrap' } });

    log('N3: success =', result.success, '| stored user role =', restoredUser?.role, '| sys-boot role =', bootUser?.role);
    expect(result.success).toBe(true);
    expect(restoredUser?.role).toBe('super_admin');
    expect(bootUser?.role).toBe('super_admin');
  });

  it('N4: User.role legacy "company_admin" → "user"', async () => {
    const company = await createTestCompany('N4 Co');
    const actor = await createTestUser('n4-actor@example.com');
    await createTestCompanyMember(actor.id, company.id);
    const backupData = buildBackup(company, { userRole: 'company_admin', memberRole: 'company_admin' });

    const result = await restoreBackup(company.id, backupData, actor.id);
    const restoredUser = await db.user.findUnique({ where: { id: backupData.data.users[0].id as string } });

    log('N4: success =', result.success, '| stored user role =', restoredUser?.role);
    expect(result.success).toBe(true);
    expect(restoredUser?.role).toBe('user');
  });

  it('N5: User.role "employee"/"viewer" → "user"', async () => {
    const company = await createTestCompany('N5 Co');
    const actor = await createTestUser('n5-actor@example.com');
    await createTestCompanyMember(actor.id, company.id);

    for (const legacy of ['employee', 'viewer']) {
      const backupData = buildBackup(company, {
        userRole: legacy,
        memberRole: 'company_admin',
        userExtra: [{ id: `u-${legacy}`, email: `emp-${legacy}@example.com`, firstName: 'X', lastName: 'Y', role: legacy, isActive: true }],
        memberExtra: [{ id: `m-${legacy}`, userId: `u-${legacy}`, companyId: company.id, role: 'company_admin', joinedAt: new Date().toISOString() }],
      });
      const r = await restoreBackup(company.id, backupData, actor.id);
      const stored = await db.user.findUnique({ where: { id: `u-${legacy}` } });
      log('N5:', legacy, '→ stored =', stored?.role, '| success =', r.success);
      expect(r.success).toBe(true);
      expect(stored?.role).toBe('user');
    }
  });

  it('N6: User.role arbitrary value → "user"', async () => {
    const company = await createTestCompany('N6 Co');
    const actor = await createTestUser('n6-actor@example.com');
    await createTestCompanyMember(actor.id, company.id);
    const backupData = buildBackup(company, { userRole: 'garbage', memberRole: 'company_admin' });

    const result = await restoreBackup(company.id, backupData, actor.id);
    const restoredUser = await db.user.findUnique({ where: { id: backupData.data.users[0].id as string } });

    log('N6: success =', result.success, '| stored user role =', restoredUser?.role);
    expect(result.success).toBe(true);
    expect(restoredUser?.role).toBe('user');
  });

  it('N7: CompanyMember.role legacy "super_admin" → "company_admin"', async () => {
    const company = await createTestCompany('N7 Co');
    const actor = await createTestUser('n7-actor@example.com');
    await createTestCompanyMember(actor.id, company.id);
    const backupData = buildBackup(company, { userRole: 'user', memberRole: 'super_admin' });

    const result = await restoreBackup(company.id, backupData, actor.id);
    const storedMember = await db.companyMember.findUnique({ where: { id: backupData.data.companyMembers[0].id as string } });

    log('N7: success =', result.success, '| stored member role =', storedMember?.role);
    expect(result.success).toBe(true);
    expect(storedMember?.role).toBe('company_admin');
  });

  it('N8: CompanyMember.role arbitrary value → "viewer" (minimum privilege)', async () => {
    const company = await createTestCompany('N8 Co');
    const actor = await createTestUser('n8-actor@example.com');
    await createTestCompanyMember(actor.id, company.id);
    const backupData = buildBackup(company, { userRole: 'user', memberRole: 'unknown-role' });

    const result = await restoreBackup(company.id, backupData, actor.id);
    const storedMember = await db.companyMember.findUnique({ where: { id: backupData.data.companyMembers[0].id as string } });

    log('N8: success =', result.success, '| stored member role =', storedMember?.role);
    expect(result.success).toBe(true);
    expect(storedMember?.role).toBe('viewer');
  });

  it('N9: valid contract roles are preserved unchanged (User + membership)', async () => {
    const company = await createTestCompany('N9 Co');
    const otherCompany = await createTestCompany('N9 Other Co');
    const actor = await createTestUser('n9-actor@example.com');
    await createTestCompanyMember(actor.id, company.id);
    const backupData = buildBackup(company, {
      userRole: 'super_admin',
      memberRole: 'company_admin',
      userExtra: [
        { id: 'u-super', email: 'n9-super@example.com', firstName: 'S', lastName: 'A', role: 'super_admin', isActive: true },
        { id: 'u-viewer', email: 'n9-viewer@example.com', firstName: 'V', lastName: 'B', role: 'user', isActive: true },
      ],
      memberExtra: [
        { id: 'm-ca', userId: 'u-super', companyId: company.id, role: 'company_admin', joinedAt: new Date().toISOString() },
        { id: 'm-emp', userId: 'u-viewer', companyId: company.id, role: 'employee', joinedAt: new Date().toISOString() },
        { id: 'm-view', userId: 'u-viewer', companyId: otherCompany.id, role: 'viewer', joinedAt: new Date().toISOString() },
      ],
    });

    // Member rows point at two different companies; restore only inserts the
    // target company's memberships so the viewer row for otherCompany is not
    // part of this restore's companyMembers scope. Keep the analysis on valid
    // tenant roles actually inserted by this restore.
    backupData.data.companyMembers = backupData.data.companyMembers.filter(
      (m) => m.companyId === company.id,
    );

    // No actor-gate: without a trusted context, super_admin must demote to user.
    const result = await restoreBackup(company.id, backupData, actor.id);
    const superUser = await db.user.findUnique({ where: { id: 'u-super' } });
    const viewerUser = await db.user.findUnique({ where: { id: 'u-viewer' } });
    const mCA = await db.companyMember.findUnique({ where: { id: 'm-ca' } });
    const mEmp = await db.companyMember.findUnique({ where: { id: 'm-emp' } });

    log('N9: success =', result.success,
      '| u-super =', superUser?.role,
      '| u-viewer =', viewerUser?.role,
      '| m-ca =', mCA?.role, '| m-emp =', mEmp?.role);
    expect(result.success).toBe(true);
    expect(superUser?.role).toBe('user'); // no trusted actor-gate in this restore
    expect(viewerUser?.role).toBe('user');
    expect(mCA?.role).toBe('company_admin');
    expect(mEmp?.role).toBe('employee');
  });

  it('N10: no invalid role value is ever persisted after restore (invariant sweep)', async () => {
    const company = await createTestCompany('N10 Co');
    const actor = await createTestUser('n10-actor@example.com');
    await createTestCompanyMember(actor.id, company.id);
    const backupData = buildBackup(company, {
      userRole: 'super_admin',
      memberRole: 'super_admin',
      userExtra: [
        { id: 'u-bad', email: 'n10-bad@example.com', firstName: 'B', lastName: 'C', role: 'company_admin', isActive: true },
        { id: 'u-weird', email: 'n10-weird@example.com', firstName: 'W', lastName: 'D', role: 'zzz', isActive: true },
      ],
      memberExtra: [
        { id: 'm-bad', userId: 'u-bad', companyId: company.id, role: 'employee', joinedAt: new Date().toISOString() },
        { id: 'm-weird', userId: 'u-weird', companyId: company.id, role: 'zzz', joinedAt: new Date().toISOString() },
        { id: 'm-card', userId: 'u-weird', companyId: company.id, role: 'admin', joinedAt: new Date().toISOString() },
      ],
    });

    // The two memberships for u-weird in the same company would violate the
    // unique constraint [userId, companyId]; collapse them so this test focuses
    // on the role-normalization invariant, not Prisma uniqueness.
    backupData.data.companyMembers = [backupData.data.companyMembers[0], backupData.data.companyMembers[1]];

    const result = await restoreBackup(company.id, backupData, actor.id);
    expect(result.success).toBe(true);

    const users = await db.user.findMany({ where: { id: { in: ['u-bad', 'u-weird'] } }, select: { role: true } });
    const members = await db.companyMember.findMany({ where: { companyId: company.id }, select: { role: true } });

    const validUserRoles = ['user', 'super_admin'];
    const validMemberRoles = ['company_admin', 'employee', 'viewer'];
    const badUserRoles = users.filter((u) => !validUserRoles.includes(u.role));
    const badMemberRoles = members.filter((m) => !validMemberRoles.includes(m.role));

    log('N10: stored user roles =', users.map((u) => u.role), '| stored member roles =', members.map((m) => m.role));
    expect(badUserRoles).toHaveLength(0);
    expect(badMemberRoles).toHaveLength(0);
  });

  it('N11: audit RESTORE_COMPLETED records normalized counts without sensitive data', async () => {
    const company = await createTestCompany('N11 Co');
    const actor = await createTestUser('n11-actor@example.com');
    await createTestCompanyMember(actor.id, company.id);
    const backupData = buildBackup(company, {
      userRole: 'super_admin',
      memberRole: 'super_admin',
      userExtra: [{ id: 'u-11', email: 'n11-u@example.com', firstName: 'X', lastName: 'Y', role: 'company_admin', isActive: true }],
      memberExtra: [{ id: 'm-11', userId: 'u-11', companyId: company.id, role: 'zzz', joinedAt: new Date().toISOString() }],
    });

    const result = await restoreBackup(company.id, backupData, actor.id, { restoringActorIsSuperAdmin: false });
    expect(result.success).toBe(true);

    const audit = await db.auditLog.findFirst({ where: { companyId: company.id, action: 'RESTORE_COMPLETED' } });
    const details = JSON.parse(audit?.details ?? '{}');
    log('N11: audit details =', JSON.stringify(details));
    expect(details.contractVersion).toBe(1);
    expect(details.normalizedUserRoles).toBe(2); // actor-gated super_admin demoted + company_admin→user
    expect(details.normalizedMembershipRoles).toBe(2); // super_admin→company_admin + zzz→viewer
    expect(JSON.stringify(details)).not.toContain('passwordHash');
    expect(JSON.stringify(details)).not.toContain('@example.com');
  });

  it('N12: real createBackup→restore round-trip normalizes any legacy role back to contract', async () => {
    const user = await createTestUser('n12-user@example.com');
    const company = await createTestCompany('N12 Co');
    await createTestCompanyMember(user.id, company.id);

    // The test factory still persists the legacy User.role='company_admin'
    // (mimicking a pre-RC2 DB). A real backup of this user therefore contains
    // 'company_admin', and restore MUST fold it back to 'user'.
    const userInDb = await db.user.findUnique({ where: { id: user.id } });
    const backup = await createBackup(company.id);
    const backupData = JSON.parse(Buffer.from(backup.data, 'base64').toString('utf-8')) as BackupData;
    const target = backupData.data.users.find((u) => u.id === user.id);
    log('N12: backup user role =', target?.role, '| db user role =', userInDb?.role);
    expect(target?.role).toBe('company_admin'); // legacy fixture role rides into the backup

    const result = await restoreBackup(company.id, backupData, user.id);
    const stored = await db.user.findUnique({ where: { id: user.id } });
    expect(result.success).toBe(true);
    expect(stored?.role).toBe('user'); // RC2-3 folds legacy global role back to 'user'
  });
});

describe('RC2-3 — pure normalization helpers', () => {
  it('normalizeRestoredUserRole collapses every non-super_admin value to user', () => {
    expect(normalizeRestoredUserRole('super_admin', { bootstrap: false, restoringActorIsSuperAdmin: true })).toBe('super_admin');
    expect(normalizeRestoredUserRole('super_admin', { bootstrap: true, restoringActorIsSuperAdmin: false })).toBe('super_admin');
    expect(normalizeRestoredUserRole('super_admin', { bootstrap: false, restoringActorIsSuperAdmin: false })).toBe('user');
    expect(normalizeRestoredUserRole('user', { bootstrap: false, restoringActorIsSuperAdmin: false })).toBe('user');
    expect(normalizeRestoredUserRole('company_admin', { bootstrap: false, restoringActorIsSuperAdmin: false })).toBe('user');
    expect(normalizeRestoredUserRole('employee', { bootstrap: false, restoringActorIsSuperAdmin: false })).toBe('user');
    expect(normalizeRestoredUserRole('viewer', { bootstrap: false, restoringActorIsSuperAdmin: false })).toBe('user');
    expect(normalizeRestoredUserRole('anything-else', { bootstrap: false, restoringActorIsSuperAdmin: false })).toBe('user');
    expect(normalizeRestoredUserRole(null, { bootstrap: false, restoringActorIsSuperAdmin: false })).toBe('user');
    expect(normalizeRestoredUserRole(undefined, { bootstrap: false, restoringActorIsSuperAdmin: false })).toBe('user');
  });

  it('normalizeRestoredMembershipRole preserves known tenant roles and folds legacy/unknown safely', () => {
    expect(normalizeRestoredMembershipRole('company_admin')).toBe('company_admin');
    expect(normalizeRestoredMembershipRole('employee')).toBe('employee');
    expect(normalizeRestoredMembershipRole('viewer')).toBe('viewer');
    expect(normalizeRestoredMembershipRole('super_admin')).toBe('company_admin');
    expect(normalizeRestoredMembershipRole('anything-else')).toBe('viewer');
    expect(normalizeRestoredMembershipRole(null)).toBe('viewer');
    expect(normalizeRestoredMembershipRole(undefined)).toBe('viewer');
  });
});