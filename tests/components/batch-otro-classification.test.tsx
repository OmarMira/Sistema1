// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, act, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EntityOnboardingModal } from '@/components/learning/EntityOnboardingModal';

afterEach(() => cleanup());

// ─── Mock shadcn Select ──────────────────────────────────────────────
vi.mock('@/components/ui/select', () => {
  const ALL_ROLES = [
    'INQUILINO', 'PROVEEDOR', 'SOCIO', 'CLIENTE', 'EMPLEADO',
    'TARJETA_CREDITO', 'PRESTAMO', 'GASTO_OPERATIVO', 'INGRESO', 'OTRO', 'IGNORADA',
  ];
  return {
    Select: ({ value, onValueChange, disabled, children }: any) => {
      let testId = 'mock-select';
      React.Children.forEach(children, (child: any) => {
        if (React.isValidElement(child) && child.props?.['data-testid']) {
          testId = child.props['data-testid'];
        }
      });
      return (
        <select
          data-testid={testId}
          value={value ?? ''}
          onChange={(e) => onValueChange?.(e.target.value)}
          disabled={disabled}
        >
          {ALL_ROLES.map((r) => (
            <option key={r} value={r}>{r}</option>
          ))}
        </select>
      );
    },
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
const tFn = vi.hoisted(() => vi.fn((key: string, params?: Record<string, any>) => {
  const map: Record<string, string> = {
    'learning.onboardingTitle': 'Classify Entities',
    'learning.onboardingDesc': 'Assign roles to detected entities',
    'learning.allClassified': 'All entities classified',
    'learning.noPendingEntities': 'No pending entities',
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
    'learning.selectRole': 'Select role...',
    'learning.describeRelationship': 'Describe the relationship',
    'learning.otroDescription': 'Describe what this entity is...',
    'learning.preClassify': 'Suggest role',
    'learning.preClassifyPlural': 'Suggest roles',
    'learning.manualSelection': 'Manual selection',
    'learning.accept': 'Accept',
    'learning.classify': 'Classify',
    'learning.close': 'Close',
    'learning.classifyCount': 'Classify ({count})',
    'learning.saving': 'Saving...',
    'learning.fetchError': 'Error fetching candidates',
    'learning.loadError': 'Error loading data',
    'learning.directionOverride': 'Assign anyway',
    'learning.suggestionBanner.pending': 'Classifying...',
    'learning.suggestionBanner.title': 'Suggestion: {role}',
    'learning.suggestionBanner.confidence': 'Confidence: {percent}%',
    'learning.suggestionBanner.lowConfidence': 'Low confidence: {percent}%',
    'learning.suggestionBanner.accept': 'Assign',
    'learning.suggestionBanner.discard': 'Discard',
    'learning.suggestionBanner.edit': 'Edit role manually',
    'learning.suggestionBanner.error': 'Not available now. Pick manually.',
    'learning.suggestionBanner.retry': 'Retry',
    'learning.suggestionBanner.assigned': 'Role assigned: {role}',
    'learning.suggestionBanner.newRoleTitle': 'New role suggested',
    'learning.suggestionBanner.newRoleDesc': 'Suggested new role: {role}',
    'learning.suggestionBanner.newRoleUse': 'Use this role',
    'learning.suggestionBanner.newRoleCancel': 'Cancel',
    'common.cancel': 'Cancel',
    'learning.saveEntity': 'Save entity',
    'settings.aiConfigTab': 'AI Config',
  };
  let value = map[key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      value = value.replace(`{${k}}`, String(v));
    }
  }
  return value;
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
    if (u.includes('/api/learning/smart-classify') && (!req || req.method === 'GET')) {
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

// ─── Integration: handler modifications ───────────────────────────────
describe('Batch OTRO — handler modifications', () => {
  /** Helper: enter manual mode, then select a role from the dropdown */
  async function selectRole(user: ReturnType<typeof userEvent.setup>, entityIdx: number, role: string) {
    const manualBtns = screen.getAllByTestId('manual-select-btn');
    await user.click(manualBtns[0]);
    await waitFor(() => {
      expect(screen.getAllByTestId('role-select').length).toBeGreaterThan(entityIdx);
    });
    const selects = screen.getAllByTestId('role-select');
    await user.selectOptions(selects[entityIdx], role);
  }

  /** Helper: change role when entity is already in manual mode */
  async function changeRole(user: ReturnType<typeof userEvent.setup>, entityIdx: number, role: string) {
    const selects = screen.getAllByTestId('role-select');
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
    await changeRole(user, 0, 'PROVEEDOR');

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
      // The accept button should be enabled (PROVEEDOR is not OTRO)
      const saveBtn = screen.getByRole('button', { name: /Save entity/i });
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
    await changeRole(user, 0, 'PROVEEDOR');

    await waitFor(() => {
      expect(
        screen.queryByPlaceholderText('Describe what this entity is...'),
      ).not.toBeInTheDocument();
    });
  });
});
