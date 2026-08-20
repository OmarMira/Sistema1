import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const MIGRATION_DIR = path.join(
  process.cwd(),
  'prisma',
  'migrations',
  '20260820104638_p04b_typed_role',
);
const MIGRATION_SQL = fs.readFileSync(path.join(MIGRATION_DIR, 'migration.sql'), 'utf8');
const SCHEMA = fs.readFileSync(path.join(process.cwd(), 'prisma', 'schema.prisma'), 'utf8');

describe('P04-B migration contract', () => {
  it('envuelve toda la migración en una transacción explícita (BEGIN/COMMIT)', () => {
    const beginIdx = MIGRATION_SQL.indexOf('BEGIN;');
    const commitIdx = MIGRATION_SQL.indexOf('COMMIT;');
    expect(beginIdx).toBeGreaterThanOrEqual(0);
    expect(commitIdx).toBeGreaterThan(beginIdx);
  });

  it('incluye el guard fail-closed P04_UNKNOWN_ROLE_DATA ANTES de cualquier ALTER TYPE', () => {
    const guardIdx = MIGRATION_SQL.indexOf('P04_UNKNOWN_ROLE_DATA');
    const alterTypeIdx = MIGRATION_SQL.indexOf('ALTER COLUMN "role" TYPE');
    expect(guardIdx).toBeGreaterThanOrEqual(0);
    expect(alterTypeIdx).toBeGreaterThan(guardIdx);
  });

  it('crea los enums PlatformRole y CompanyRole', () => {
    expect(MIGRATION_SQL).toContain('CREATE TYPE "PlatformRole" AS ENUM');
    expect(MIGRATION_SQL).toContain('CREATE TYPE "CompanyRole" AS ENUM');
  });

  it('convierte las columnas con USING', () => {
    expect(MIGRATION_SQL).toContain('USING');
  });

  it('fija los defaults canónicos (User=user, CompanyMember=company_admin)', () => {
    expect(MIGRATION_SQL).toContain('SET DEFAULT \'user\'::"PlatformRole"');
    expect(MIGRATION_SQL).toContain('SET DEFAULT \'company_admin\'::"CompanyRole"');
  });

  it('no deja ningún artefacto de compensación _p04b_* en la migración productiva', () => {
    expect(MIGRATION_SQL).not.toMatch(/CREATE TABLE "_p04b_/);
    expect(MIGRATION_SQL).not.toMatch(/CREATE TABLE "public"\."_p04b_/);
  });

  it('normaliza legacy conocido antes del cambio de tipo', () => {
    const normalizeUser = MIGRATION_SQL.indexOf("UPDATE \"User\"          SET \"role\" = 'user'");
    const normalizeMember = MIGRATION_SQL.indexOf(
      "UPDATE \"CompanyMember\" SET \"role\" = 'company_admin'",
    );
    const alterTypeIdx = MIGRATION_SQL.indexOf('ALTER COLUMN "role" TYPE');
    expect(normalizeUser).toBeGreaterThanOrEqual(0);
    expect(normalizeMember).toBeGreaterThanOrEqual(0);
    expect(alterTypeIdx).toBeGreaterThan(Math.max(normalizeUser, normalizeMember));
  });
});

describe('P04-B schema contract', () => {
  it('declara los enums PlatformRole y CompanyRole en schema.prisma', () => {
    expect(SCHEMA).toContain('enum PlatformRole {');
    expect(SCHEMA).toContain('enum CompanyRole {');
    expect(SCHEMA).toContain('user');
    expect(SCHEMA).toContain('super_admin');
    expect(SCHEMA).toContain('company_admin');
    expect(SCHEMA).toContain('employee');
    expect(SCHEMA).toContain('viewer');
  });

  it('mapea User.platformRole a la columna física "role" con default user', () => {
    expect(SCHEMA).toContain('platformRole          PlatformRole           @default(user) @map("role")');
  });

  it('tipa CompanyMember.role como CompanyRole con default company_admin', () => {
    expect(SCHEMA).toContain('role      CompanyRole @default(company_admin)');
  });
});