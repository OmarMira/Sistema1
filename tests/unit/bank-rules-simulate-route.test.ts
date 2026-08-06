import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockGetSessionUserId = vi.hoisted(() => vi.fn().mockResolvedValue('user-1'));
const mockDbUserFindUnique = vi.hoisted(() => vi.fn());
const mockDbCompanyMemberFindUnique = vi.hoisted(() => vi.fn());
const mockDbCompanyFindUnique = vi.hoisted(() => vi.fn());
const mockSimulateApply = vi.hoisted(() => vi.fn());

vi.mock('@/lib/sessions', () => ({
  getSessionUserId: mockGetSessionUserId,
}));

vi.mock('@/lib/db', () => ({
  db: {
    user: { findUnique: mockDbUserFindUnique },
    companyMember: { findUnique: mockDbCompanyMemberFindUnique },
    company: { findUnique: mockDbCompanyFindUnique },
  },
}));

vi.mock('@/lib/services/rule-simulation.service', () => ({
  simulateApply: mockSimulateApply,
}));

import { POST, parseSimulateLimit } from '@/app/api/bank-rules/simulate/route';
import { MAX_PER_BATCH } from '@/lib/services/apply-all-engine';

const BASE_URL = 'http://localhost/api/bank-rules/simulate?companyId=c1';

function createRequest(body?: unknown): NextRequest {
  return new NextRequest(BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSessionUserId.mockResolvedValue('user-1');
  mockDbUserFindUnique.mockResolvedValue({ role: 'user' });
  mockDbCompanyMemberFindUnique.mockResolvedValue({ id: 'membership-1' });
  mockDbCompanyFindUnique.mockResolvedValue({ isActive: true });
  mockSimulateApply.mockResolvedValue({
    matchResult: { matchedRules: [] },
    readOnly: true,
    recordCreated: false,
    ledgerAccuracyNotGuaranteed: true,
  });
});

describe('POST /api/bank-rules/simulate — limit validation', () => {
  it('accepts limit omitted (default engine cap)', async () => {
    const res = await POST(createRequest(), { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
    expect(mockSimulateApply).toHaveBeenCalledWith('c1', { limit: undefined });
  });

  it('accepts limit = 1', async () => {
    const res = await POST(createRequest({ limit: 1 }), { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
    expect(mockSimulateApply).toHaveBeenCalledWith('c1', { limit: 1 });
  });

  it('accepts limit = MAX_PER_BATCH (200)', async () => {
    expect(MAX_PER_BATCH).toBe(200);
    const res = await POST(createRequest({ limit: 200 }), { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
    expect(mockSimulateApply).toHaveBeenCalledWith('c1', { limit: 200 });
  });

  it('rejects limit = 0', async () => {
    const res = await POST(createRequest({ limit: 0 }), { params: Promise.resolve({}) });
    expect(res.status).toBe(400);
    expect(mockSimulateApply).not.toHaveBeenCalled();
  });

  it('rejects limit = 201 (over cap)', async () => {
    const res = await POST(createRequest({ limit: 201 }), { params: Promise.resolve({}) });
    expect(res.status).toBe(400);
    expect(mockSimulateApply).not.toHaveBeenCalled();
  });

  it('rejects negative limit', async () => {
    const res = await POST(createRequest({ limit: -5 }), { params: Promise.resolve({}) });
    expect(res.status).toBe(400);
    expect(mockSimulateApply).not.toHaveBeenCalled();
  });

  it('rejects decimal limit', async () => {
    const res = await POST(createRequest({ limit: 2.5 }), { params: Promise.resolve({}) });
    expect(res.status).toBe(400);
    expect(mockSimulateApply).not.toHaveBeenCalled();
  });

  it('rejects invalid string limit', async () => {
    const res = await POST(createRequest({ limit: 'abc' }), { params: Promise.resolve({}) });
    expect(res.status).toBe(400);
    expect(mockSimulateApply).not.toHaveBeenCalled();
  });
});

describe('parseSimulateLimit — edge values not transportable as JSON', () => {
  it('rejects NaN', () => {
    expect(parseSimulateLimit(Number.NaN)).toEqual({ ok: false });
  });

  it('rejects Infinity', () => {
    expect(parseSimulateLimit(Number.POSITIVE_INFINITY)).toEqual({ ok: false });
  });

  it('rejects boolean true', () => {
    expect(parseSimulateLimit(true)).toEqual({ ok: false });
  });

  it('rejects numeric string', () => {
    expect(parseSimulateLimit('5')).toEqual({ ok: false });
  });

  it('treats null as omitted (valid)', () => {
    expect(parseSimulateLimit(null)).toEqual({ ok: true, value: undefined });
  });
});
