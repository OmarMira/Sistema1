import { z } from 'zod';
import { registerSchema } from '@/lib/validations/auth';

// Explicit schemas strip passwords, codes, tokens and any unrecognized fields.
const draftSchema = z.discriminatedUnion('kind', [
  registerSchema.omit({ password: true }).extend({
    kind: z.literal('new'), deliveryFailed: z.boolean(),
  }),
  z.object({ kind: z.literal('existing'), email: z.string().email() }),
]);
export type RegistrationDraft = z.infer<typeof draftSchema>;
const key = 'registration-verification:v1';
let memoryDraft: RegistrationDraft | null = null;

export function saveRegistrationDraft(value: unknown) {
  if (typeof window === 'undefined') return;
  const result = draftSchema.safeParse(value);
  if (!result.success) return;
  memoryDraft = result.data;
  try { window.localStorage.setItem(key, JSON.stringify(result.data)); } catch {
    // Storage may be blocked; the same-tab flow can still continue in memory.
  }
}

export function readRegistrationDraft(): RegistrationDraft | null {
  if (typeof window === 'undefined') return null;
  try {
    const value = window.localStorage.getItem(key);
    const result = draftSchema.safeParse(value ? JSON.parse(value) : null);
    return result.success ? result.data : null;
  } catch { return memoryDraft; }
}

export function clearRegistrationDraft() {
  memoryDraft = null;
  if (typeof window === 'undefined') return;
  try { window.localStorage.removeItem(key); } catch {
    // A storage restriction must not invalidate a successfully verified session.
  }
}
