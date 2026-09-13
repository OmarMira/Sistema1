// KE-GENERALIZATION-UI-001 — T18: productive navigation to the structural
// candidates surface from the existing Company Knowledge page.
//
// The page is a server component that fetches via db; the test proves the
// RENDERED navigation link (the product's visible action), mocking only the
// db + SSR context boundaries per the established contract-double precedent.

// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

vi.mock('@/lib/db', () => ({
  db: {
    companyKnowledge: {
      findMany: vi.fn(async () => [
        {
          id: 'ek-1',
          companyId: 'company-1',
          canonicalName: 'ACME',
          type: 'company',
          relationship: 'client',
          status: 'active',
          version: 1,
          createdAt: new Date('2026-01-01'),
        },
      ]),
    },
  },
}));

vi.mock('@/lib/ssr-context', () => ({
  requireSsrCompanyContext: vi.fn(async () => ({ ok: true, companyId: 'company-1' })),
}));

import CompanyKnowledgePage from '../../src/app/company-knowledge/page';

afterEach(() => {
  cleanup();
});

describe('KE-GENERALIZATION-UI-001 — T18 productive navigation', () => {
  it('T18: the existing Company Knowledge page exposes a visible link to the structural candidates surface', async () => {
    const Page = await CompanyKnowledgePage({ searchParams: Promise.resolve({}) });
    render(Page);
    const link = screen.getByTestId('nav-structural-candidates');
    expect(link).toBeInTheDocument();
    expect(link.getAttribute('href')).toBe('/company-knowledge/structural-candidates');
    expect(link.textContent).toBeTruthy();
  });
});
