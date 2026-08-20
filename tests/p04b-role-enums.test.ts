import { describe, it, expect } from 'vitest';
import { PlatformRole, CompanyRole, Prisma } from '@prisma/client';
import {
  normalizeRestoredUserRole,
  normalizeRestoredMembershipRole,
} from '@/lib/backup';

describe('P04-B typed role enums', () => {
  it('PlatformRole acepta únicamente user/super_admin', () => {
    expect(Object.values(PlatformRole).sort()).toEqual(['super_admin', 'user'].sort());
    expect(PlatformRole).not.toHaveProperty('company_admin');
    expect(PlatformRole).not.toHaveProperty('employee');
    expect(PlatformRole).not.toHaveProperty('viewer');
  });

  it('CompanyRole acepta únicamente company_admin/employee/viewer', () => {
    expect(Object.values(CompanyRole).sort()).toEqual(
      ['company_admin', 'employee', 'viewer'].sort(),
    );
    expect(CompanyRole).not.toHaveProperty('user');
    expect(CompanyRole).not.toHaveProperty('super_admin');
  });

  it('employee/viewer nunca son platform roles', () => {
    const platformValues = Object.values(PlatformRole) as string[];
    expect(platformValues).not.toContain('employee');
    expect(platformValues).not.toContain('viewer');
    expect(platformValues).not.toContain('company_admin');
  });

  it('wire role permanece string-compatible (los valores de enum son strings)', () => {
    expect(typeof PlatformRole.user).toBe('string');
    expect(typeof PlatformRole.super_admin).toBe('string');
    expect(typeof CompanyRole.company_admin).toBe('string');
    const wire: string = PlatformRole.super_admin;
    expect(wire).toBe('super_admin');
  });

  it('los tipos Prisma exponen las mismas uniones', () => {
    const pr: Prisma.PlatformRole = 'super_admin';
    const cr: Prisma.CompanyRole = 'employee';
    expect(pr).toBe('super_admin');
    expect(cr).toBe('employee');
  });
});

describe('P04-B restore mappings (contrato backup/restore sin cambios)', () => {
  it('User legacy tenant roles colapsan a user (fail-closed)', () => {
    expect(normalizeRestoredUserRole('company_admin', {})).toBe('user');
    expect(normalizeRestoredUserRole('employee', {})).toBe('user');
    expect(normalizeRestoredUserRole('viewer', {})).toBe('user');
    expect(normalizeRestoredUserRole('anything_else', {})).toBe('user');
  });

  it('super_admin se conserva solo con contexto de autoridad (bootstrap o actor super_admin)', () => {
    expect(normalizeRestoredUserRole('super_admin', { bootstrap: true })).toBe('super_admin');
    expect(normalizeRestoredUserRole('super_admin', { restoringActorIsSuperAdmin: true })).toBe(
      'super_admin',
    );
    // El payload solo nunca otorga super_admin.
    expect(normalizeRestoredUserRole('super_admin', {})).toBe('user');
  });

  it('CompanyMember super_admin se pliega a company_admin', () => {
    expect(normalizeRestoredMembershipRole('super_admin')).toBe('company_admin');
  });

  it('CompanyMember roles conocidos se preservan; desconocidos colapsan a viewer', () => {
    expect(normalizeRestoredMembershipRole('company_admin')).toBe('company_admin');
    expect(normalizeRestoredMembershipRole('employee')).toBe('employee');
    expect(normalizeRestoredMembershipRole('viewer')).toBe('viewer');
    expect(normalizeRestoredMembershipRole('anything_else')).toBe('viewer');
  });
});