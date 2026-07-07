import { z } from 'zod';

export const VALID_STATES = [
  'AL',
  'AK',
  'AZ',
  'AR',
  'CA',
  'CO',
  'CT',
  'DE',
  'FL',
  'GA',
  'HI',
  'ID',
  'IL',
  'IN',
  'IA',
  'KS',
  'KY',
  'LA',
  'ME',
  'MD',
  'MA',
  'MI',
  'MN',
  'MS',
  'MO',
  'MT',
  'NE',
  'NV',
  'NH',
  'NJ',
  'NM',
  'NY',
  'NC',
  'ND',
  'OH',
  'OK',
  'OR',
  'PA',
  'RI',
  'SC',
  'SD',
  'TN',
  'TX',
  'UT',
  'VT',
  'VA',
  'WA',
  'WV',
  'WI',
  'WY',
];

export const ZIP_CODE_REGEX = /^\d{5}(-\d{4})?$/;
export const PHONE_REGEX = /^\+?1?[-.\s]?\(?[2-9]\d{2}\)?[-.\s]?\d{3}[-.\s]?\d{4}$/;

export const usAddressClientSchema = z.object({
  streetLine1: z.string().min(1, 'La calle es requerida').max(100),
  streetLine2: z.string().max(100).optional().nullable().default(''),
  city: z.string().min(1, 'La ciudad es requerida').max(50),
  state: z
    .string()
    .length(2, 'El estado debe ser de 2 letras')
    .refine((val) => VALID_STATES.includes(val.toUpperCase()), {
      message: 'Estado de EE.UU. inválido',
    }),
  zipCode: z.string().regex(ZIP_CODE_REGEX, 'Código Postal (ZIP) inválido'),
  phone: z
    .string()
    .regex(PHONE_REGEX, 'Número de teléfono de EE.UU. inválido')
    .optional()
    .nullable()
    .or(z.literal('')),
});

export type UsAddressClientInput = z.infer<typeof usAddressClientSchema>;
