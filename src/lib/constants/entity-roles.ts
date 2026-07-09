import { z } from 'zod';

export const ENTITY_ROLES = [
  'INQUILINO',
  'PROVEEDOR',
  'SOCIO',
  'CLIENTE',
  'EMPLEADO',
  'TARJETA_CREDITO',
  'PRESTAMO',
  'GASTO_OPERATIVO',
  'INGRESO',
  'OTRO',
  'IGNORADA',
] as const;

export type EntityRole = (typeof ENTITY_ROLES)[number];

/** Roles exposed to user-facing dropdowns (excludes internal IGNORADA). */
export const UI_ROLES = ENTITY_ROLES.filter((r) => r !== 'IGNORADA');

/** Zod schema for role fields — accepts any string to support custom roles */
export const entityRoleSchema = z.string();

/**
 * Maps each role to the transaction direction it expects.
 * - 'credit': roles that typically receive money (CLIENTE, INGRESO, INQUILINO)
 * - 'debit': roles that typically pay money (PROVEEDOR, EMPLEADO, GASTO_OPERATIVO, TARJETA_CREDITO, PRESTAMO)
 * - 'mixed': roles that can go either way (SOCIO)
 * - null: roles without a directional expectation (OTRO, IGNORADA)
 */
/** Human-readable labels for each entity role. */
export const ROLE_LABELS: Record<EntityRole, string> = {
  INQUILINO: 'Inquilino',
  PROVEEDOR: 'Proveedor',
  SOCIO: 'Socio',
  CLIENTE: 'Cliente',
  EMPLEADO: 'Empleado',
  TARJETA_CREDITO: 'Tarjeta de crédito',
  PRESTAMO: 'Préstamo',
  GASTO_OPERATIVO: 'Gasto operativo',
  INGRESO: 'Ingreso',
  OTRO: 'Otro',
  IGNORADA: 'Ignorada',
};

export const EXPECTED_DIRECTION: Record<EntityRole, 'credit' | 'debit' | 'mixed' | null> = {
  CLIENTE: 'credit',
  INGRESO: 'credit',
  INQUILINO: 'credit',
  PROVEEDOR: 'debit',
  EMPLEADO: 'debit',
  GASTO_OPERATIVO: 'debit',
  TARJETA_CREDITO: 'debit',
  PRESTAMO: 'debit',
  SOCIO: 'mixed',
  OTRO: null,
  IGNORADA: null,
};
