import { describe, it, expect, beforeEach } from 'vitest';
import { clearDatabase, createTestCompany, createTestGlAccount, createTestUser } from '../helpers/factories';
import { saveContext, findContext } from '@/lib/services/entity-context-service';
import { db } from '@/lib/db';

describe('saveContext()', () => {
  let companyId: string;
  let userId: string;

  beforeEach(async () => {
    await clearDatabase();
    const company = await createTestCompany('Entity Context Test Co');
    companyId = company.id;
    const user = await createTestUser('entity-test@example.com');
    userId = user.id;
  });

  it('creates a record with valid input and returns it', async () => {
    const ctx = await saveContext({
      companyId,
      pattern: 'AMERICAN EXPRESS',
      role: 'TARJETA_CREDITO',
      source: 'user',
    });

    expect(ctx).toBeDefined();
    expect(ctx.id).toBeDefined();
    expect(ctx.companyId).toBe(companyId);
    expect(ctx.role).toBe('TARJETA_CREDITO');
    expect(ctx.source).toBe('user');
  });

  it('uppercases the role', async () => {
    const ctx = await saveContext({
      companyId,
      pattern: 'HOME DEPOT',
      role: 'proveedor',
    });

    expect(ctx.role).toBe('PROVEEDOR');
  });

  it('normalizes the pattern (lowercase, strips prefixes)', async () => {
    const ctx = await saveContext({
      companyId,
      pattern: 'Zelle payment to LAURA QUIJANO',
      role: 'SOCIO',
    });

    expect(ctx.pattern).toBe('laura quijano');
  });

  it('serializes roles array as JSON string', async () => {
    const ctx = await saveContext({
      companyId,
      pattern: 'JUAN PEREZ',
      role: 'CLIENTE',
      roles: ['CLIENTE', 'PROVEEDOR'],
    });

    const parsed = JSON.parse(ctx.roles!);
    expect(parsed).toEqual(['CLIENTE', 'PROVEEDOR']);
  });

  it('stores roles as null when not provided', async () => {
    const ctx = await saveContext({
      companyId,
      pattern: 'TEST ENTITY',
      role: 'GASTO_OPERATIVO',
    });

    expect(ctx.roles).toBeNull();
  });

  it('upserts: same companyId+pattern updates role instead of creating duplicate', async () => {
    const first = await saveContext({
      companyId,
      pattern: 'UBER',
      role: 'GASTO_OPERATIVO',
    });

    const second = await saveContext({
      companyId,
      pattern: 'uber',
      role: 'INGRESO',
    });

    // Same ID — upsert updated the record
    expect(second.id).toBe(first.id);
    expect(second.role).toBe('INGRESO');

    // Only one record in DB
    const all = await db.entityContext.findMany({
      where: { companyId, pattern: 'uber' },
    });
    expect(all).toHaveLength(1);
  });

  it('creates an audit log entry when userId is provided', async () => {
    const ctx = await saveContext({
      companyId,
      pattern: 'LYFT',
      role: 'INGRESO',
      userId,
    });

    const logs = await db.auditLog.findMany({
      where: { entityId: ctx.id },
    });
    expect(logs).toHaveLength(1);
    expect(logs[0].action).toBe('ENTITY_CONTEXT_ASSIGNED');
    expect(logs[0].userId).toBe(userId);
  });

  it('does NOT create an audit log when userId is omitted', async () => {
    const ctx = await saveContext({
      companyId,
      pattern: 'TURO',
      role: 'INGRESO',
    });

    const logs = await db.auditLog.findMany({
      where: { entityId: ctx.id },
    });
    expect(logs).toHaveLength(0);
  });

  it('stores transactionDirection when provided', async () => {
    const ctx = await saveContext({
      companyId,
      pattern: 'RENTA VEHICULOS',
      role: 'INGRESO',
      transactionDirection: 'credit',
    });

    expect(ctx.transactionDirection).toBe('credit');
  });

  it('stores transactionDirection as null when not provided', async () => {
    const ctx = await saveContext({
      companyId,
      pattern: 'SERVICIOS VARIOS',
      role: 'GASTO_OPERATIVO',
    });

    expect(ctx.transactionDirection).toBeNull();
  });

  it('stores glAccountId when provided', async () => {
    const gl = await createTestGlAccount({ companyId, code: '4010', name: 'Ingresos Financieros' });

    const ctx = await saveContext({
      companyId,
      pattern: 'TURO',
      role: 'INGRESO',
      glAccountId: gl.id,
    });

    expect(ctx.glAccountId).toBe(gl.id);
  });

  it('stores glAccountId as null when not provided', async () => {
    const ctx = await saveContext({
      companyId,
      pattern: 'NO_GL_ENTITY',
      role: 'GASTO_OPERATIVO',
    });

    expect(ctx.glAccountId).toBeNull();
  });

  it('defaults source to "user" when not specified', async () => {
    const ctx = await saveContext({
      companyId,
      pattern: 'DEFAULT SOURCE',
      role: 'OTRO',
    });

    expect(ctx.source).toBe('user');
  });

  it('accepts "ai" as source', async () => {
    const ctx = await saveContext({
      companyId,
      pattern: 'AI CLASSIFIED',
      role: 'PROVEEDOR',
      source: 'ai',
    });

    expect(ctx.source).toBe('ai');
  });
});

describe('findContext()', () => {
  let companyId: string;
  let otherCompanyId: string;

  beforeEach(async () => {
    await clearDatabase();
    const company = await createTestCompany('Find Context Test Co');
    companyId = company.id;
    const other = await createTestCompany('Other Co');
    otherCompanyId = other.id;

    // Seed two contexts
    await saveContext({ companyId, pattern: 'UBER', role: 'GASTO_OPERATIVO' });
    await saveContext({ companyId, pattern: 'HOME DEPOT', role: 'PROVEEDOR' });
    // Different company
    await saveContext({ companyId: otherCompanyId, pattern: 'UBER', role: 'OTRO' });
  });

  it('returns context when description contains the pattern exactly', async () => {
    const ctx = await findContext(companyId, 'UBER');
    expect(ctx).not.toBeNull();
    expect(ctx!.role).toBe('GASTO_OPERATIVO');
  });

  it('returns context when description embeds the pattern (partial match)', async () => {
    // findContext normalizes the description, then checks if it includes any context pattern
    const ctx = await findContext(
      companyId,
      'Zelle payment to HOME DEPOT for supplies',
    );
    expect(ctx).not.toBeNull();
    expect(ctx!.role).toBe('PROVEEDOR');
  });

  it('returns null when description does not match any pattern', async () => {
    const ctx = await findContext(companyId, 'SOME RANDOM COMPANY');
    expect(ctx).toBeNull();
  });

  it('returns null for a different company', async () => {
    // UBER exists in otherCompany as OTRO but shouldn't be found
    const ctx = await findContext(otherCompanyId, 'HOME DEPOT');
    expect(ctx).toBeNull();
  });

  it('includes glAccount relation when available', async () => {
    const gl = await createTestGlAccount({ companyId, code: '5010', name: 'Proveedores' });
    await saveContext({
      companyId,
      pattern: 'AMAZON',
      role: 'PROVEEDOR',
      glAccountId: gl.id,
    });

    const ctx = await findContext(companyId, 'AMAZON');
    expect(ctx).not.toBeNull();
    expect(ctx!.glAccount).not.toBeNull();
    expect(ctx!.glAccount!.code).toBe('5010');
    expect(ctx!.glAccount!.name).toBe('Proveedores');
  });
});
