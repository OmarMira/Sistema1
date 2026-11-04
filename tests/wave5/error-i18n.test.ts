/**
 * S3 (Wave 5) — stable machine codes on the top user-facing flows, and a
 * frontend helper that turns a known code into the SELECTED locale instead of
 * showing whatever Spanish/English string the server happened to produce.
 *
 * Contract pinned here:
 *  (a) `translateApiError` — a known code renders the locale translation, even
 *      when the server message is different; the specific reason carried in
 *      `details.code` wins over the family code; an unknown code or a missing
 *      code falls back to the SERVER message (never to a raw key, never to a
 *      generic message that hides the server's detail);
 *  (b) the fiscal guard responses (400 invalid date / 403 locked period) carry
 *      FISCAL_DATE_INVALID / FISCAL_PERIOD_LOCKED through `details.code`, and
 *      the import route carries IMPORT_NO_FILE / IMPORT_TOO_LARGE /
 *      IMPORT_TOO_MANY_FILES — all WITHOUT changing `code`, `status` or the
 *      historical Spanish message;
 *  (c) every wired code exists in BOTH locales with a non-empty, locale-native
 *      string (parity: one language can never silently miss a key).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { getTranslation, translations, type Locale } from '@/lib/i18n';
import es from '@/i18n/locales/es';
import en from '@/i18n/locales/en';
import { isTranslatedErrorCode, translateApiError } from '@/i18n/errors';
import { POST as postAdjustment } from '@/app/api/reconciliation/adjustment/route';
import { POST as postImport } from '@/app/api/import/route';
import { createSession } from '@/lib/sessions';
import {
  createTestUser,
  createTestCompany,
  createTestCompanyMember,
  clearDatabase,
} from '../helpers/factories';

// ─── (a) unit: the translation helper ────────────────────────────────

/** Same translator shape the language store builds (miss → humanized key). */
function translatorFor(locale: Locale) {
  const dictionary = translations[locale] as Record<string, unknown>;
  return (key: string) => getTranslation(dictionary, key, key);
}

describe('S3 (a) — translateApiError', () => {
  const tEs = translatorFor('es');
  const tEn = translatorFor('en');

  it('translates a known code into the selected locale, ignoring the server message', () => {
    expect(
      translateApiError({ error: 'No se pueden registrar transacciones…', code: 'FISCAL_PERIOD_LOCKED' }, tEs),
    ).toBe(es.errors.FISCAL_PERIOD_LOCKED);
    expect(translateApiError({ error: 'raw', code: 'FISCAL_PERIOD_LOCKED' }, tEn)).toBe(
      en.errors.FISCAL_PERIOD_LOCKED,
    );
  });

  it('prefers the specific reason in details.code over the family code', () => {
    const body = {
      error: 'Fecha de transacción inválida: "x"',
      code: 'FORBIDDEN',
      details: { code: 'FISCAL_DATE_INVALID' },
    };

    expect(translateApiError(body, tEn)).toBe(en.errors.FISCAL_DATE_INVALID);
  });

  it('passes the server message through when the code is unknown', () => {
    expect(translateApiError({ error: 'Algo salió mal', code: 'SOMETHING_UNTRANSLATED' }, tEs)).toBe(
      'Algo salió mal',
    );
  });

  it('passes the server message through when there is no code at all', () => {
    expect(translateApiError({ error: 'Mensaje sólo del servidor' }, tEs)).toBe(
      'Mensaje sólo del servidor',
    );
  });

  it('never shows a raw key: empty payload falls back to the caller fallback, then to common.error', () => {
    expect(translateApiError(null, tEs, 'Respuesta vacía')).toBe('Respuesta vacía');
    expect(translateApiError({}, tEs)).toBe(es.common.error);
    expect(translateApiError({ error: '   ' }, tEn)).toBe(en.common.error);
  });

  it('isTranslatedErrorCode only accepts codes present in the locales', () => {
    expect(isTranslatedErrorCode('IMPORT_TIMEOUT')).toBe(true);
    expect(isTranslatedErrorCode('NOT_A_WIRED_CODE')).toBe(false);
    expect(isTranslatedErrorCode(undefined)).toBe(false);
    expect(isTranslatedErrorCode(42)).toBe(false);
  });
});

// ─── (b) integration: the codes actually reach the wire ──────────────

async function setup() {
  const user = await createTestUser(`wave5-s3-${Date.now()}@example.com`);
  const company = await createTestCompany('wave5-s3-error-i18n');
  await createTestCompanyMember(user.id, company.id);
  const token = await createSession(user.id);
  return { user, company, token };
}

type Setup = Awaited<ReturnType<typeof setup>>;

function postAdjustmentBody(s: Setup, body: Record<string, unknown>) {
  const request = new NextRequest(
    `http://localhost/api/reconciliation/adjustment?companyId=${s.company.id}`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${s.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ companyId: s.company.id, ...body }),
    },
  );
  return postAdjustment(request, { params: Promise.resolve({}) } as never);
}

function postImportForm(s: Setup, form: FormData) {
  form.append('companyId', s.company.id);
  const request = new NextRequest(`http://localhost/api/import?companyId=${s.company.id}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${s.token}` },
    body: form,
  });
  return postImport(request, { params: Promise.resolve({}) } as never);
}

const ADJUSTMENT_BODY = {
  bankAccountId: 'bank-not-needed-by-the-guard',
  description: 'Adjustment',
  debitAccountId: 'debit-not-needed-by-the-guard',
  creditAccountId: 'credit-not-needed-by-the-guard',
  amount: 10,
};

describe('S3 (b) — fiscal guard carries a stable reason code', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  it('403 for a locked period: details.code = FISCAL_PERIOD_LOCKED, message and code untouched', async () => {
    const s = await setup();
    await db.fiscalPeriod.create({
      data: {
        companyId: s.company.id,
        name: 'May 2026',
        startDate: new Date('2026-05-01T00:00:00.000Z'),
        endDate: new Date('2026-05-31T23:59:59.999Z'),
        isLocked: true,
      },
    });

    const res = await postAdjustmentBody(s, { ...ADJUSTMENT_BODY, date: '2026-05-15' });
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.code).toBe('FORBIDDEN');
    expect(body.details.code).toBe('FISCAL_PERIOD_LOCKED');
    // The historical Spanish message is preserved verbatim (PRESERVE).
    expect(body.error).toBe(
      'No se pueden registrar transacciones en un período cerrado. Período bloqueado: "May 2026".',
    );
    // ...and it is translatable in both locales.
    expect(translateApiError(body, translatorFor('es'))).toBe(es.errors.FISCAL_PERIOD_LOCKED);
    expect(translateApiError(body, translatorFor('en'))).toBe(en.errors.FISCAL_PERIOD_LOCKED);
  });

  it('400 for an unparseable date: details.code = FISCAL_DATE_INVALID, code stays VALIDATION_ERROR', async () => {
    const s = await setup();

    const res = await postAdjustmentBody(s, { ...ADJUSTMENT_BODY, date: 'not-a-date' });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(body.details.code).toBe('FISCAL_DATE_INVALID');
    expect(body.error).toContain('Fecha de transacción inválida');
    expect(translateApiError(body, translatorFor('en'))).toBe(en.errors.FISCAL_DATE_INVALID);
  });

  it('PRESERVE: a date outside every fiscal period is still accepted (historical data)', async () => {
    const s = await setup();
    await db.fiscalPeriod.create({
      data: {
        companyId: s.company.id,
        name: 'May 2026',
        startDate: new Date('2026-05-01T00:00:00.000Z'),
        endDate: new Date('2026-05-31T23:59:59.999Z'),
        isLocked: true,
      },
    });

    const res = await postAdjustmentBody(s, { ...ADJUSTMENT_BODY, date: '2024-05-15' });

    // Past the guard: the request is now rejected by the (missing) bank account,
    // never by the fiscal guard — its code must NOT appear.
    const body = await res.json();
    expect(res.status).not.toBe(403);
    expect(body.details?.code).not.toBe('FISCAL_PERIOD_LOCKED');
  });
});

describe('S3 (b) — import route carries stable reason codes', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  it('no file in the request: details.code = IMPORT_NO_FILE', async () => {
    const s = await setup();

    const res = await postImportForm(s, new FormData());
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(body.details.code).toBe('IMPORT_NO_FILE');
    expect(translateApiError(body, translatorFor('en'))).toBe(en.errors.IMPORT_NO_FILE);
  });

  it('more files than one request allows: details.code = IMPORT_TOO_MANY_FILES', async () => {
    const s = await setup();
    const form = new FormData();
    for (let i = 0; i < 11; i++) {
      form.append('files', new File(['date,description,amount\n'], `f${i}.csv`));
    }

    const res = await postImportForm(s, form);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(body.details.code).toBe('IMPORT_TOO_MANY_FILES');
    expect(translateApiError(body, translatorFor('es'))).toBe(es.errors.IMPORT_TOO_MANY_FILES);
  });

  it('a file above the size limit: details.code = IMPORT_TOO_LARGE', async () => {
    const s = await setup();
    const oversized = new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'too-big.csv', {
      type: 'text/csv',
    });
    const form = new FormData();
    form.append('files', oversized);

    const res = await postImportForm(s, form);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(body.details.code).toBe('IMPORT_TOO_LARGE');
    expect(translateApiError(body, translatorFor('en'))).toBe(en.errors.IMPORT_TOO_LARGE);
  });
});

// ─── (c) locale parity for every wired code ─────────────────────────

/** Codes the server emits today and the UI translates. */
const WIRED_CODES = [
  'FISCAL_PERIOD_LOCKED',
  'FISCAL_DATE_INVALID',
  'IMPORT_TIMEOUT',
  'IMPORT_TOO_LARGE',
  'IMPORT_TOO_MANY_FILES',
  'IMPORT_NO_FILE',
  'CONFLICT',
  'AI_CONFIG_MISSING',
  'AI_CONFIG_UNAVAILABLE',
  'AI_PROVIDER_UNAVAILABLE',
  'DATABASE_ERROR',
  'FORBIDDEN',
  'UNAUTHORIZED',
  'RATE_LIMIT_EXCEEDED',
  'INTERNAL_SERVER_ERROR',
] as const;

describe('S3 (c) — locale parity for error codes', () => {
  it('es and en declare exactly the same error codes', () => {
    expect(Object.keys(en.errors).sort()).toEqual(Object.keys(es.errors).sort());
  });

  it('every wired code is translated in both locales with native, non-empty text', () => {
    for (const code of WIRED_CODES) {
      const esText = (es.errors as Record<string, string>)[code];
      const enText = (en.errors as Record<string, string>)[code];

      expect(typeof esText, `${code} [es]`).toBe('string');
      expect(typeof enText, `${code} [en]`).toBe('string');
      expect(esText.trim().length, `${code} [es] non-empty`).toBeGreaterThan(0);
      expect(enText.trim().length, `${code} [en] non-empty`).toBeGreaterThan(0);
      // A copy-pasted Spanish string in the English catalog must not pass.
      expect(enText, `${code} must be English, not Spanish`).not.toBe(esText);
    }
  });

  it('every code the helper knows is a real, translated code in both locales', () => {
    const codes = Object.keys(es.errors);
    expect(codes.length).toBeGreaterThan(0);
    for (const code of codes) {
      expect(isTranslatedErrorCode(code)).toBe(true);
      expect(translatorFor('es')(`errors.${code}`)).toBe((es.errors as Record<string, string>)[code]);
      expect(translatorFor('en')(`errors.${code}`)).toBe((en.errors as Record<string, string>)[code]);
    }
  });
});

// ─── (d) the auth + backup display sites translate real response bodies ──

describe('S3 (d) — bodies of the wired auth and backup display sites', () => {
  const tEs = translatorFor('es');
  const tEn = translatorFor('en');

  it('login 401 (UNAUTHORIZED): Spanish stays byte-identical, English is translated', () => {
    // Exact body pinned by tests/identity/registration-atomic.integration.test.ts;
    // the Spanish login message must not change, English must not leak it.
    const body = { error: 'Correo electrónico o contraseña inválidos', code: 'UNAUTHORIZED' };

    expect(translateApiError(body, tEs)).toBe('Correo electrónico o contraseña inválidos');
    expect(translateApiError(body, tEn)).toBe(en.errors.UNAUTHORIZED);
    expect(translateApiError(body, tEn)).not.toBe(body.error);
  });

  it('login 429 (RATE_LIMIT_EXCEEDED) translates in both locales', () => {
    const body = {
      error: 'Demasiados intentos de inicio de sesión. Intente nuevamente más tarde.',
      code: 'RATE_LIMIT_EXCEEDED',
    };

    expect(translateApiError(body, tEs)).toBe(es.errors.RATE_LIMIT_EXCEEDED);
    expect(translateApiError(body, tEn)).toBe(en.errors.RATE_LIMIT_EXCEEDED);
  });

  it('backup failure (DATABASE_ERROR) translates in both locales', () => {
    const body = { error: 'Error de restricción o de base de datos.', code: 'DATABASE_ERROR' };

    expect(translateApiError(body, tEs)).toBe(es.errors.DATABASE_ERROR);
    expect(translateApiError(body, tEn)).toBe(en.errors.DATABASE_ERROR);
  });

  it('register 400 has no code: the server message still reaches the form', () => {
    // A zod validation failure answers { error: 'Validation failed', details } and
    // must keep showing that detail instead of a generic translated text.
    const body = { error: 'Validation failed', details: { fieldErrors: { email: ['Invalid'] } } };

    expect(translateApiError(body, tEs)).toBe('Validation failed');
    expect(translateApiError(body, tEn)).toBe('Validation failed');
  });
});
