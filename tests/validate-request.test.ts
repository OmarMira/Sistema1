import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';
import { z } from 'zod';

// Mock sanitize so we control the exact behavior
vi.mock('@/lib/sanitize', () => ({
  sanitizeInput: vi.fn((val: string) => {
    // Strip HTML tags to simulate sanitize-html behavior
    return val.replace(/<[^>]*>/g, '');
  }),
}));

import { validateRequest } from '@/lib/validate-request';

const TestSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  age: z.number().optional(),
});

describe('validateRequest', () => {
  /* ── Valid body ──────────────────────────────────────── */

  it('returns validated data for a valid request body', async () => {
    const req = new Request('http://localhost/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'test@test.com', name: 'John' }),
    });

    const result = await validateRequest(req, TestSchema);
    expect(result).not.toBeInstanceOf(NextResponse);
    if (!(result instanceof NextResponse)) {
      expect(result.email).toBe('test@test.com');
      expect(result.name).toBe('John');
    }
  });

  /* ── Invalid body (schema validation failure) ────────── */

  it('returns NextResponse with 400 for invalid body', async () => {
    const req = new Request('http://localhost/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'not-an-email', name: '' }),
    });

    const result = await validateRequest(req, TestSchema);
    expect(result).toBeInstanceOf(NextResponse);
    if (result instanceof NextResponse) {
      expect(result.status).toBe(400);
      const body = await result.json();
      expect(body.error).toBe('Validation failed');
      expect(body.details).toBeDefined();
    }
  });

  /* ── XSS sanitization ────────────────────────────────── */

  it('sanitizes XSS in string fields', async () => {
    const req = new Request('http://localhost/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'test@test.com',
        name: '<script>alert("xss")</script>John',
      }),
    });

    const result = await validateRequest(req, TestSchema);
    expect(result).not.toBeInstanceOf(NextResponse);
    if (!(result instanceof NextResponse)) {
      expect(result.name).not.toContain('<script>');
      expect(result.name).toContain('John');
    }
  });

  it('sanitizes nested object fields', async () => {
    const NestedSchema = z.object({
      user: z.object({
        name: z.string(),
        bio: z.string(),
      }),
    });

    const req = new Request('http://localhost/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user: {
          name: '<b>Alice</b>',
          bio: '<script>steal()</script>Hello',
        },
      }),
    });

    const result = await validateRequest(req, NestedSchema);
    expect(result).not.toBeInstanceOf(NextResponse);
    if (!(result instanceof NextResponse)) {
      expect(result.user.name).not.toContain('<b>');
      expect(result.user.name).toBe('Alice');
      expect(result.user.bio).not.toContain('<script>');
    }
  });

  it('sanitizes array elements', async () => {
    const ArraySchema = z.object({
      tags: z.array(z.string()),
    });

    const req = new Request('http://localhost/api/items', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tags: ['<a>link</a>', '<script>bad</script>'] }),
    });

    const result = await validateRequest(req, ArraySchema);
    expect(result).not.toBeInstanceOf(NextResponse);
    if (!(result instanceof NextResponse)) {
      expect(result.tags[0]).toBe('link');
      expect(result.tags[1]).toBe('bad');
    }
  });

  /* ── Skip path ───────────────────────────────────────── */

  it('skips schema validation for /api/auth/logout', async () => {
    const req = new Request('http://localhost/api/auth/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ anything: 'goes' }),
    });

    const result = await validateRequest(req, TestSchema);
    // Should return raw JSON, not validated against schema
    expect(result).not.toBeInstanceOf(NextResponse);
    if (!(result instanceof NextResponse)) {
      expect(result).toHaveProperty('anything', 'goes');
    }
  });

  it('returns 400 on skip path when JSON is invalid', async () => {
    const req = new Request('http://localhost/api/auth/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    });

    const result = await validateRequest(req, TestSchema);
    expect(result).toBeInstanceOf(NextResponse);
    if (result instanceof NextResponse) {
      expect(result.status).toBe(400);
      const body = await result.json();
      expect(body.error).toBe('Invalid JSON body');
    }
  });

  /* ── Invalid JSON ────────────────────────────────────── */

  it('returns 400 for invalid JSON body', async () => {
    const req = new Request('http://localhost/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'this is not json',
    });

    const result = await validateRequest(req, TestSchema);
    expect(result).toBeInstanceOf(NextResponse);
    if (result instanceof NextResponse) {
      expect(result.status).toBe(400);
      const body = await result.json();
      expect(body.error).toBe('Invalid JSON body');
    }
  });

  /* ── Non-object primitives ───────────────────────────── */

  it('preserves non-string, non-object values through sanitization', async () => {
    const req = new Request('http://localhost/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'a@b.com', name: 'Test', age: 30 }),
    });

    const result = await validateRequest(req, TestSchema);
    expect(result).not.toBeInstanceOf(NextResponse);
    if (!(result instanceof NextResponse)) {
      expect(result.age).toBe(30);
    }
  });
});
