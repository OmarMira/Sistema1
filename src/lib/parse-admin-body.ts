import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

export type ParsedAdminBody<T> = {
  data: T;
  files: Map<string, File>;
};

export async function parseAdminBody<T>(
  request: NextRequest,
  schema: z.ZodSchema<T>,
  transformFormData?: (raw: Record<string, string>) => Record<string, unknown>,
): Promise<{ ok: true; body: ParsedAdminBody<T> } | { ok: false; error: NextResponse }> {
  const contentType = request.headers.get('content-type') || '';

  if (contentType.includes('multipart/form-data')) {
    const formData = await request.formData();
    const raw: Record<string, string> = {};
    const files = new Map<string, File>();

    for (const [key, value] of formData.entries() as IterableIterator<[string, string | File]>) {
      if (typeof value !== 'string') {
        if (value.size > 0) files.set(key, value);
        continue;
      }
      raw[key] = value;
    }

    const obj = transformFormData ? transformFormData(raw) : raw;

    const result = schema.safeParse(obj);
    if (!result.success) {
      return {
        ok: false,
        error: NextResponse.json(
          { error: 'Validation failed', details: result.error.flatten() },
          { status: 400 },
        ),
      };
    }
    return { ok: true, body: { data: result.data, files } };
  }

  try {
    const json = await request.json();
    const result = schema.safeParse(json);
    if (!result.success) {
      return {
        ok: false,
        error: NextResponse.json(
          { error: 'Validation failed', details: result.error.flatten() },
          { status: 400 },
        ),
      };
    }
    return { ok: true, body: { data: result.data, files: new Map() } };
  } catch {
    return {
      ok: false,
      error: NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }),
    };
  }
}
