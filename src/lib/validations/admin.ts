import { z } from 'zod';

const emailField = z
  .string()
  .email('Formato de correo electrónico inválido')
  .min(1, 'El correo electrónico es requerido');
const nameField = z.string().min(1, 'Campo requerido').max(100);
const passwordField = z.string().min(6, 'La contraseña debe tener al menos 6 caracteres');

export const createUserSchema = z.object({
  email: emailField,
  firstName: nameField,
  lastName: nameField,
  password: passwordField,
  role: z.enum(['company_admin', 'employee', 'viewer', 'super_admin']).default('company_admin'),
  phone: z.string().optional(),
  streetLine1: z.string().optional(),
  streetLine2: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  zipCode: z.string().optional(),
});

export const updateUserSchema = z.object({
  email: emailField.optional(),
  firstName: nameField.optional(),
  lastName: nameField.optional(),
  password: passwordField.optional(),
  role: z.enum(['company_admin', 'employee', 'viewer', 'super_admin']).optional(),
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
