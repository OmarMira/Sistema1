import { z } from 'zod';

const emailField = z
  .string()
  .email('Formato de correo electrónico inválido')
  .min(1, 'El correo electrónico es requerido');
const nameField = z.string().min(1, 'Campo requerido').max(100);
const passwordField = z.string().min(6, 'La contraseña debe tener al menos 6 caracteres');

// Business rule: 'super_admin' is a global system role and can never be assigned
// from company-level admin flows. Invitations via /api/users may only assign
// membership roles; the global role is reserved for /api/admin endpoints (requireSuperAdmin).
// Do NOT merge these arrays — the split is the security boundary.
export const INVITABLE_ROLES = ['company_admin', 'employee', 'viewer'] as const;
export const ADMIN_ASSIGNABLE_ROLES = [...INVITABLE_ROLES, 'super_admin'] as const;

const userFields = {
  email: emailField,
  firstName: nameField,
  lastName: nameField,
  password: passwordField,
  phone: z.string().optional(),
  streetLine1: z.string().optional(),
  streetLine2: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  zipCode: z.string().optional(),
};

export const createUserSchema = z.object({
  ...userFields,
  role: z.enum(INVITABLE_ROLES).default('company_admin'),
});

export const createAdminUserSchema = z.object({
  ...userFields,
  role: z.enum(ADMIN_ASSIGNABLE_ROLES).default('company_admin'),
});

export const updateUserSchema = z.object({
  email: emailField.optional(),
  firstName: nameField.optional(),
  lastName: nameField.optional(),
  password: passwordField.optional(),
  role: z.enum(ADMIN_ASSIGNABLE_ROLES).optional(),
  isActive: z.boolean().optional(),
  phone: z.string().optional(),
  streetLine1: z.string().optional(),
  streetLine2: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  zipCode: z.string().optional(),
});

export const ADMIN_USER_ROLES = ['company_admin', 'employee', 'viewer', 'super_admin'] as const;

export const createAdminCompanySchema = z.object({
  legalName: z.string().min(1, 'El nombre legal es requerido').max(200),
  taxId: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().email().optional().or(z.literal('')),
  streetLine1: z.string().optional(),
  streetLine2: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  zipCode: z.string().optional(),
});

export const updateAdminCompanySchema = z.object({
  legalName: z.string().min(1).max(200).optional(),
  taxId: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().email().optional().or(z.literal('')),
  isActive: z.boolean().optional(),
  streetLine1: z.string().optional(),
  streetLine2: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  zipCode: z.string().optional(),
});
