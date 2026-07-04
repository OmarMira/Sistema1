import type { EntityRole } from './entity-roles';

export type ExpectedDirection = 'credit' | 'debit' | 'mixed' | null;

export type RoleDirectionMap = Partial<Record<EntityRole, ExpectedDirection>>;

type AccountMapping = {
  debit: string;
  credit: string;
  fallback: string;
  expectedDirection: ExpectedDirection;
};

export const ROLE_ACCOUNT_MAP: Partial<Record<EntityRole, AccountMapping>> = {
  SOCIO: { debit: '3040', credit: '3010', fallback: '3010', expectedDirection: 'mixed' },
  EMPLEADO: { debit: '6030', credit: '6030', fallback: '6030', expectedDirection: 'debit' },
  INQUILINO: { debit: '4020', credit: '4020', fallback: '4020', expectedDirection: 'credit' },
  CLIENTE: { debit: '4010', credit: '4010', fallback: '4010', expectedDirection: 'credit' },
  TARJETA_CREDITO: { debit: '2020', credit: '2020', fallback: '2020', expectedDirection: 'debit' },
  PRESTAMO: { debit: '2040', credit: '2040', fallback: '2040', expectedDirection: 'debit' },
  PROVEEDOR: { debit: '6070', credit: '6070', fallback: '6070', expectedDirection: 'debit' },
  GASTO_OPERATIVO: { debit: '5000', credit: '5000', fallback: '5000', expectedDirection: 'debit' },
  INGRESO: { debit: '4010', credit: '4010', fallback: '4010', expectedDirection: 'credit' },
};

// Compile-time guard: every non-OTRO/IGNORADA role must have a mapping.
// If a role is missing, this line will fail with "Type 'never' is not assignable to type 'true'".
type _MappedRoles = keyof typeof ROLE_ACCOUNT_MAP;
 
const _roleMapGuard: EntityRole extends _MappedRoles | 'OTRO' | 'IGNORADA' ? true : never = true;
