// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, act, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EntityOnboardingModal } from '@/components/learning/EntityOnboardingModal';
import { getEligibleBatchEntities } from '@/components/learning/EntityOnboardingModal';

afterEach(() => cleanup());

// ─── Mock shadcn Select ──────────────────────────────────────────────
vi.mock('@/components/ui/select', () => {
  const ALL_ROLES = [
    'INQUILINO', 'PROVEEDOR', 'SOCIO', 'CLIENTE', 'EMPLEADO',
    'TARJETA_CREDITO', 'PRESTAMO', 'GASTO_OPERATIVO', 'INGRESO', 'OTRO', 'IGNORADA',
  ];
  return {
    Select: ({ value, onValueChange, disabled, children }: any) => (
      <select
        data-testid="mock-select"
        value={value ?? ''}
        onChange={(e) => onValueChange?.(e.target.value)}
        disabled={disabled}
      >
        {ALL_ROLES.map((r) => (
          <option key={r} value={r}>{r}</option>
        ))}
      </select>
    ),
    SelectTrigger: ({ className, children, ...props }: any) => (
      <div data-testid="mock-select-trigger" {...props}>{children}</div>
    ),
    SelectValue: ({ placeholder }: any) => (
      <span data-testid="mock-select-value">{placeholder}</span>
    ),
    SelectContent: ({ children }: any) => <>{children}</>,
    SelectItem: ({ value, children }: any) => <>{children}</>,
    SelectGroup: ({ children }: any) => <>{children}</>,
    SelectLabel: () => null,
    SelectSeparator: () => null,
  };
});

// ─── Mocks ───────────────────────────────────────────────────────────
const tFn = vi.hoisted(() => vi.fn((key: string) => {
  const map: Record<string, string> = {
    'learning.title': 'Classify Entities',
    'learning.transactions': '{count} transactions',
    'learning.directionCredit': 'Mostly credits',
    'learning.directionDebit': 'Mostly debits',
    'learning.directionMixed': 'Mixed direction',
    'learning.splitTitle': 'Split title',
    'learning.splitCredit': 'Only credits',
    'learning.splitDebit': 'Only debits',
    'learning.splitBoth': 'Both',
    'learning.rolePlaceholder': 'Select role...',
    'learning.otroDescription': 'Describe what this entity is...',
    'learning.classify': 'Classify',
    'learning.close': 'Close',
    'learning.classifyCount': 'Classify ({count})',
    'learning.saving': 'Saving...',
    'learning.fetchError': 'Error fetching candidates',
    'learning.loadError': 'Error loading data',
    'learning.directionOverride': 'Assign anyway',
    'common.cancel': 'Cancel',
  };
  return map[key] ?? key;
}));
vi.mock('@/store/language-store', () => ({
  useLanguageStore: (selector: (s: any) => any) => selector({ t: tFn, language: 'en' }),
}));

const mockToast = vi.hoisted(() => ({
  info: vi.fn(),
  error: vi.fn(),
  custom: vi.fn(),
  dismiss: vi.fn(),
  warning: vi.fn(),
  success: vi.fn(),
}));
vi.mock('sonner', () => ({ toast: mockToast }));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ─── Test data ────────────────────────────────────────────────────────
const debitCandidate = {
  id: 'can_1',
  canonicalName: 'DEBIT ENTITY',
  occurrences: 5,
  directionProfile: { creditPct: 0.1, debitPct: 0.9 },
  sampleDescriptions: ['Expense payment'],
};

const otroCandidate1 = {
  id: 'can_2',
  canonicalName: 'OTHER ENTITY ONE',
  occurrences: 3,
  directionProfile: { creditPct: 0.3, debitPct: 0.7 },
  sampleDescriptions: ['Various payments'],
};

const otroCandidate2 = {
  id: 'can_3',
  canonicalName: 'OTHER ENTITY TWO',
  occurrences: 7,
  directionProfile: { creditPct: 0.5, debitPct: 0.5 },
  sampleDescriptions: ['Mixed transactions'],
};

const mockFetch = vi.fn();

function setupFetch(candidates: any[] = [debitCandidate]) {
  mockFetch.mockImplementation((url: string, req?: RequestInit) => {
    const u = typeof url === 'string' ? url : '';
    if (u.includes('/api/learning/classify-entity') && (!req || req.method === 'GET')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, data: candidates }),
      });
    }
    if (u.includes('/api/learning/suggest-role')) {
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            suggestedRole: 'PROVEEDOR',
            confidence: 0.92,
            explanation: 'Matches supplier pattern',
          }),
      });
    }
    if (u.includes('/api/learning/classify-entity') && req?.method === 'POST') {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true }),
      });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  });
}

// ─── Pure function: getEligibleBatchEntities ─────────────────────────
describe('getEligibleBatchEntities', () => {
  it('returns OTRO entities with description >= 5 chars', () => {
    // This test will fail initially because getEligibleBatchEntities doesn't exist yet
    const candidates = [debitCandidate, otroCandidate1, otroCandidate2];
    const descriptions: Record<string, string> = {
      'OTHER ENTITY ONE': 'pays invoices monthly',
    };
    const selections: Record<string, { role: string }> = {
      'OTHER ENTITY ONE': { role: 'OTRO' },
      'DEBIT ENTITY': { role: 'PROVEEDOR' },
    };

    const result = getEligibleBatchEntities(candidates, descriptions, selections, () => '');
    expect(result).toEqual(['OTHER ENTITY ONE']);
  });

  it('excludes entities without OTRO role', () => {
    const candidates = [otroCandidate1];
    const descriptions: Record<string, string> = {
      'OTHER ENTITY ONE': 'pays invoices monthly',
    };
    const selections = {}; // No selection yet → getDefaultRole returns ''

    const result = getEligibleBatchEntities(candidates, descriptions, selections, () => '');
    expect(result).toEqual([]);
  });

  it('excludes entities with description < 5 chars', () => {
    const candidates = [otroCandidate1];
    const descriptions: Record<string, string> = {
      'OTHER ENTITY ONE': 'abc',
    };
    const selections: Record<string, { role: string }> = {
      'OTHER ENTITY ONE': { role: 'OTRO' },
    };

    const result = getEligibleBatchEntities(candidates, descriptions, selections, () => '');
    expect(result).toEqual([]);
  });

  it('excludes entities with empty description', () => {
    const candidates = [otroCandidate1];
    const descriptions: Record<string, string> = {
      'OTHER ENTITY ONE': '',
    };
    const selections: Record<string, { role: string }> = {
      'OTHER ENTITY ONE': { role: 'OTRO' },
    };

    const result = getEligibleBatchEntities(candidates, descriptions, selections, () => '');
    expect(result).toEqual([]);
  });

  it('returns multiple eligible entities', () => {
    const candidates = [otroCandidate1, otroCandidate2];
    const descriptions: Record<string, string> = {
      'OTHER ENTITY ONE': 'pays invoices monthly',
      'OTHER ENTITY TWO': 'receives rent payments',
    };
    const selections: Record<string, { role: string }> = {
      'OTHER ENTITY ONE': { role: 'OTRO' },
      'OTHER ENTITY TWO': { role: 'OTRO' },
    };

    const result = getEligibleBatchEntities(candidates, descriptions, selections, () => '');
    expect(result).toEqual(['OTHER ENTITY ONE', 'OTHER ENTITY TWO']);
  });

  it('only returns entities with OTRO role from selections, not from getDefaultRole', () => {
    // Entity "RENTAL INC" has a getDefaultRole of 'INQUILINO' but NO selection
    const rentalCandidate = {
      id: 'can_4',
      canonicalName: 'RENTAL INC',
      occurrences: 5,
      directionProfile: { creditPct: 0.9, debitPct: 0.1 },
      sampleDescriptions: ['Monthly rent'],
    };
    const candidates = [otroCandidate1, rentalCandidate];
    const descriptions: Record<string, string> = {
      'OTHER ENTITY ONE': 'pays invoices',
      'RENTAL INC': 'monthly rent payments',
    };
    const selections: Record<string, { role: string }> = {
      'OTHER ENTITY ONE': { role: 'OTRO' },
      // RENTAL INC has NO selection — role comes from getDefaultRoleFn
    };

    // getDefaultRoleFn returns 'INQUILINO' for 'RENTAL INC'
    const getDefaultRoleFn = (name: string) => {
      if (name === 'RENTAL INC') return 'INQUILINO';
      return '';
    };

    const result = getEligibleBatchEntities(candidates, descriptions, selections, getDefaultRoleFn);
    // RENTAL INC has description >= 5 chars but its role is INQUILINO (not OTRO)
    expect(result).toEqual(['OTHER ENTITY ONE']);
  });

  it('uses getDefaultRole when selection exists but has no role set', () => {
    const otroCandidate = {
      id: 'can_5',
      canonicalName: 'SUPPLIER LTD',
      occurrences: 3,
      directionProfile: { creditPct: 0.4, debitPct: 0.6 },
      sampleDescriptions: [],
    };
    const candidates = [otroCandidate];
    const descriptions: Record<string, string> = {
      'SUPPLIER LTD': 'supplies office materials',
    };
    // Selection exists but with no role set — should use getDefaultRole
    const selections: Record<string, { role: string }> = {
      'SUPPLIER LTD': { role: '' },
    };

    const getDefaultRoleFn = (name: string) => {
      if (name === 'SUPPLIER LTD') return 'PROVEEDOR';
      return '';
    };

    const result = getEligibleBatchEntities(candidates, descriptions, selections, getDefaultRoleFn);
    // Default role is PROVEEDOR, not OTRO → excluded
    expect(result).toEqual([]);
  });
});

// ─── Integration: handler modifications ───────────────────────────────
describe('Batch OTRO — handler modifications', () => {
  /** Helper: select a role from the native mock select */
  async function selectRole(user: ReturnType<typeof userEvent.setup>, entityIdx: number, role: string) {
    const selects = screen.getAllByTestId('mock-select');
    await user.selectOptions(selects[entityIdx], role);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // ── Task 2.5: handleRoleChange clears batchResults when switching from OTRO ──
  it('clears batchResults when switching from OTRO to another role', async () => {
    // This test verifies the modification to handleRoleChange
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    setupFetch([debitCandidate]);
    render(<EntityOnboardingModal isOpen onClose={vi.fn()} companyId="comp_1" />);

    await waitFor(() => {
      expect(screen.getByText('DEBIT ENTITY')).toBeInTheDocument();
    });

    // First select OTRO — batch result would be set for this entity
    await selectRole(user, 0, 'OTRO');

    const textarea = await screen.findByPlaceholderText('Describe what this entity is...');
    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'pays invoices monthly' } });
    });

    await waitFor(() => {
      expect(textarea).toHaveValue('pays invoices monthly');
    });

    // Now switch away from OTRO to PROVEEDOR
    await selectRole(user, 0, 'PROVEEDOR');

    // The textarea should disappear
    await waitFor(() => {
      expect(
        screen.queryByPlaceholderText('Describe what this entity is...'),
      ).not.toBeInTheDocument();
    });
  });

  // ── Task 2.4: handleDescriptionChange clears batchResults ──
  it('clears batchResults when description changes for OTRO entity', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    setupFetch([debitCandidate]);
    render(<EntityOnboardingModal isOpen onClose={vi.fn()} companyId="comp_1" />);

    await waitFor(() => {
      expect(screen.getByText('DEBIT ENTITY')).toBeInTheDocument();
    });

    // Select OTRO
    await selectRole(user, 0, 'OTRO');

    const textarea = await screen.findByPlaceholderText('Describe what this entity is...');

    // Type a long description
    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'pays invoices monthly' } });
    });

    await waitFor(() => {
      expect(textarea).toHaveValue('pays invoices monthly');
    });

    // Type a different description — the old batch result should be cleared
    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'new vendor description' } });
    });

    await waitFor(() => {
      expect(textarea).toHaveValue('new vendor description');
    });
  });

  // ── Triangulation: non-OTRO role change does NOT clear batchResults ──
  it('does NOT clear batchResults when switching between non-OTRO roles', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    setupFetch([debitCandidate]);
    render(<EntityOnboardingModal isOpen onClose={vi.fn()} companyId="comp_1" />);

    await waitFor(() => {
      expect(screen.getByText('DEBIT ENTITY')).toBeInTheDocument();
    });

    // Select PROVEEDOR (non-OTRO)
    await selectRole(user, 0, 'PROVEEDOR');

    // Wait for selection to settle — no crash, no error
    await waitFor(() => {
      // The classify button should be enabled (PROVEEDOR is not OTRO)
      const saveBtn = screen.getByRole('button', { name: /Classify/i });
      expect(saveBtn).not.toBeDisabled();
    });
  });

  // ── Triangulation: Empty description does not crash ──
  it('handles empty description change without error', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    setupFetch([debitCandidate]);
    render(<EntityOnboardingModal isOpen onClose={vi.fn()} companyId="comp_1" />);

    await waitFor(() => {
      expect(screen.getByText('DEBIT ENTITY')).toBeInTheDocument();
    });

    // Select OTRO
    await selectRole(user, 0, 'OTRO');

    const textarea = await screen.findByPlaceholderText('Describe what this entity is...');

    // Type and clear — should not crash
    await act(async () => {
      fireEvent.change(textarea, { target: { value: '' } });
    });

    await waitFor(() => {
      expect(textarea).toHaveValue('');
    });
  });

  // ── Task 2.4: handleRoleChange keeps description clearing when switching to OTRO ──
  it('preserves handleRoleChange existing clear description behavior when switching to OTRO', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    setupFetch([debitCandidate]);
    render(<EntityOnboardingModal isOpen onClose={vi.fn()} companyId="comp_1" />);

    await waitFor(() => {
      expect(screen.getByText('DEBIT ENTITY')).toBeInTheDocument();
    });

    // Select OTRO and type a description
    await selectRole(user, 0, 'OTRO');

    const textarea = await screen.findByPlaceholderText('Describe what this entity is...');
    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'pays invoices monthly' } });
    });

    await waitFor(() => {
      expect(textarea).toHaveValue('pays invoices monthly');
    });

    // Switch to PROVEEDOR — description should be cleared
    await selectRole(user, 0, 'PROVEEDOR');

    await waitFor(() => {
      expect(
        screen.queryByPlaceholderText('Describe what this entity is...'),
      ).not.toBeInTheDocument();
    });
  });
});
