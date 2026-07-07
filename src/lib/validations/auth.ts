import { z } from 'zod';

export const loginSchema = z.object({
  email: z
    .string()
    .email('Formato de correo electrónico inválido')
    .min(1, 'El correo electrónico es requerido'),
  password: z.string().min(1, 'La contraseña es requerida'),
});

export const registerSchema = z.object({
  email: z
    .string()
    .email('Formato de correo electrónico inválido')
    .min(1, 'El correo electrónico es requerido'),
  password: z.string().min(8, 'La contraseña debe tener al menos 8 caracteres'),
  firstName: z.string().min(1, 'El nombre es requerido'),
  lastName: z.string().min(1, 'El apellido es requerido'),
  companyName: z.string().min(1, 'El nombre de la empresa es requerido'),
  taxId: z.string().optional().nullable(),
  entityType: z.enum(['INDIVIDUAL', 'BUSINESS']).default('BUSINESS'),
});

export type LoginInput = z.infer<typeof loginSchema>;
export type RegisterInput = z.infer<typeof registerSchema>;
