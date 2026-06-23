import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { POST as conversationalParsePost } from '@/app/api/learning/conversational-parse/route';
import { createTestUser, createTestCompany, createTestCompanyMember, createTestGlAccount, clearDatabase } from '../helpers/factories';
import { createSession } from '@/lib/sessions';
import { NextRequest } from 'next/server';
import { parseConversationalContext } from '@/lib/services/conversational-service';

// Mock the conversational context service
vi.mock('@/lib/services/conversational-service', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/services/conversational-service')>();
  return {
    ...original,
    parseConversationalContext: vi.fn(),
  };
});

describe('Direction Profiles Integration Exception Flag', () => {
  let user: any;
  let company: any;
  let token: string;

  beforeEach(async () => {
    await clearDatabase();
    user = await createTestUser('test-direction@example.com');
    company = await createTestCompany('Direction Test Corp');
    await createTestCompanyMember(user.id, company.id);
    token = await createSession(user.id);

    // Create the GL accounts referenced by mock parseConversationalContext results
    await createTestGlAccount({
      companyId: company.id,
      code: '3010',
      name: 'Capital Social / Aportes de Socios',
      accountType: 'equity',
      normalBalance: 'credit',
    });
    await createTestGlAccount({
      companyId: company.id,
      code: '2010',
      name: 'Cuentas por Pagar',
      accountType: 'liability',
      normalBalance: 'credit',
    });
  });

  afterEach(async () => {
    await clearDatabase();
    vi.restoreAllMocks();
  });

  it('debe permitir mapear a categoria 3 (allowOpposite) sin disparar error 400 ante transaccion de debito (debitPct: 1.0)', async () => {
    // Mock the parser result to suggest a Patrimonio account (category '3')
    vi.mocked(parseConversationalContext).mockResolvedValue({
      role: 'SOCIO',
      glAccountCode: '3010',
      glAccountId: null,
      suggestSubAccount: false,
      subAccountName: null,
      confidence: 0.95,
      confidenceLabel: 'high',
      explanation: 'Contexto previo para SOCIO',
      uncertaintyReasons: [],
      account: {
        code: '3010',
        name: 'Capital Social / Aportes de Socios',
      },
    });

    const req = new NextRequest('http://localhost/api/learning/conversational-parse', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        companyId: company.id,
        pattern: 'Aporte de socio',
        userInput: 'retiro de capital por socio',
        directionProfile: {
          creditPct: 0.0,
          debitPct: 1.0,
        },
      }),
    });

    const response = await conversationalParsePost(req, { params: Promise.resolve({}) });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
  });

  it('debe PERMITIR mapear a categoria 2 (Pasivo) ante transaccion de debito (debitPct: 1.0) porque pagar un pasivo es un debito valido', async () => {
    // Accounting rationale: a debit to a liability account (class 2) is
    // a payment that reduces the liability. This is standard GAAP.
    // Example: Paying credit card (2020) or accounts payable (2010) → Debit 2020/2010.
    // Blocking this with a 400 would be wrong.
    vi.mocked(parseConversationalContext).mockResolvedValue({
      role: 'PASIVO',
      glAccountCode: '2010',
      glAccountId: null,
      suggestSubAccount: false,
      subAccountName: null,
      confidence: 0.85,
      confidenceLabel: 'high',
      explanation: 'Clasificación por heurístico',
      uncertaintyReasons: [],
      account: {
        code: '2010',
        name: 'Cuentas por Pagar',
      },
    });

    const req = new NextRequest('http://localhost/api/learning/conversational-parse', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        companyId: company.id,
        pattern: 'Pago proveedor',
        userInput: 'pago a proveedor pendiente',
        directionProfile: {
          creditPct: 0.0,
          debitPct: 1.0,
        },
      }),
    });

    const response = await conversationalParsePost(req, { params: Promise.resolve({}) });
    const body = await response.json();

    // 200: paying down a liability is valid accounting, must NOT be blocked
    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
  });
});
