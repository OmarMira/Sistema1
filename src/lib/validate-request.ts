import { NextResponse } from 'next/server';
import { z } from 'zod';
import { sanitizeInput } from './sanitize';

/**
 * Valida el cuerpo de una petición entrante contra un schema de Zod.
 *
 * @param req - La petición Request de Next.js
 * @param schema - Schema Zod para validar el cuerpo
 * @returns Los datos validados O una respuesta NextResponse con error 400
 *
 * @example
 * const result = await validateRequest(req, LoginSchema);
 * if (result instanceof NextResponse) return result; // Retorna el error
 * const { email, password } = result; // Datos seguros tipados
 */
export async function validateRequest<T>(
  req: Request,
  schema: z.ZodSchema<T>,
): Promise<T | NextResponse> {
  // Endpoints that do NOT require body validation (e.g., logout)
  const skipValidationPaths = ['/api/auth/logout'];

  const url = new URL(req.url);
  if (skipValidationPaths.includes(url.pathname)) {
    // Endpoints like logout may have no body — return empty rather than error
    try {
      const body = await req.json();
      return (body ?? {}) as unknown as T;
    } catch {
      return ({} as unknown as T);
    }
  }

  try {
    const json = await req.json();

    // 1. Validate with Zod FIRST (shape + types)
    const result = schema.safeParse(json);
    if (!result.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: result.error.flatten() },
        { status: 400 },
      );
    }

    // 2. THEN sanitize strings in the validated data (XSS prevention)
    const sanitizeObj = (obj: unknown): unknown => {
      if (typeof obj === 'string') {
        return sanitizeInput(obj);
      }
      if (Array.isArray(obj)) {
        return obj.map(sanitizeObj);
      }
      if (obj && typeof obj === 'object') {
        const cleaned: Record<string, unknown> = {};
        for (const [key, val] of Object.entries(obj)) {
          cleaned[key] = sanitizeObj(val);
        }
        return cleaned;
      }
      return obj;
    };

    return sanitizeObj(result.data) as T;
  } catch (err: unknown) {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
}
