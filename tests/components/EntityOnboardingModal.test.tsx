// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, act, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EntityOnboardingModal } from '@/components/learning/EntityOnboardingModal';

afterEach(() => cleanup());

// ─── Mock shadcn Select with native <select> for jsdom ────────────
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

// ─── Mocks ─────────────────────────────────────────────────────────

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
    'learning.splitTitle': 'This entity has both debits and credits. What do you want to do?',
    'learning.splitCredit': 'Only credits',
    'learning.splitDebit': 'Only debits',
    'learning.splitBoth': 'Both (keep as one)',
    'learning.rolePlaceholder': 'Select role...',
    'learning.selectRole': 'Select role...',
    'learning.describeRelationship': 'Describe the relationship',
    'learning.otroDescription': 'Describe what this entity is...',
    'learning.otroAnalyzing': 'Analyzing...',
    'learning.preClassify': 'Suggest role',
    'learning.preClassifyPlural': 'Suggest roles',
    'learning.manualSelection': 'Manual selection',
    'learning.accept': 'Accept',
    'learning.saveClassificationSingular': 'Save classification',
    'learning.saveClassificationPlural': 'Save classifications',
    'learning.close': 'Close',
    'learning.batch.loading': 'Classifying entities...',
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
    'learning.suggestionBanner.errorNotConfigured': 'AI not configured',
    'learning.suggestionBanner.errorRequestFailed': 'AI request failed',
    'learning.suggestionDismissed': 'Pick manually from dropdown',
    'learning.suggestionLowConfidence': 'Could not determine role, describe more',
    'learning.suggestionReady': '{role} ({account}). {explanation}',
    'learning.suggestionAssign': 'ASIGN',
    'learning.suggestionError': 'Not available now',
    'common.cancel': 'Cancel',
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
  warning: vi.fn(),
  success: vi.fn(),
  custom: vi.fn(),
  dismiss: vi.fn(),
}));
vi.mock('sonner', () => ({ toast: mockToast }));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ─── Test data ──────────────────────────────────────────────────────

const mixedCandidate = {
  id: 'can_1',
  canonicalName: 'MIXED ENTITY',
  occurrences: 10,
  directionProfile: { creditPct: 0.45, debitPct: 0.55 },
  sampleDescriptions: ['Payment received', 'Invoice paid'],
};

const debitCandidate = {
  id: 'can_2',
  canonicalName: 'DEBIT ENTITY',
  occurrences: 5,
  directionProfile: { creditPct: 0.1, debitPct: 0.9 },
  sampleDescriptions: ['Expense payment'],
};

const creditCandidate = {
  id: 'can_3',
  canonicalName: 'CREDIT ENTITY',
  occurrences: 3,
  directionProfile: { creditPct: 0.95, debitPct: 0.05 },
  sampleDescriptions: ['Customer payment'],
};

const mockFetch = vi.fn();

function setupFetch(
  candidates: any[] = [mixedCandidate, debitCandidate],
  options?: {
    suggestRoleResponse?: any;
    classifyResponse?: any;
    suggestRoleStatus?: number;
  },
) {
  mockFetch.mockImplementation((url: string, req?: RequestInit) => {
    const u = typeof url === 'string' ? url : '';
    if (u.includes('/api/learning/smart-classify') && (!req || req.method === 'GET')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, data: candidates }),
      });
    }
    if (u.includes('/api/learning/suggest-role')) {
      const status = options?.suggestRoleStatus ?? 200;
      return Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        json: () =>
          Promise.resolve(
            status >= 200 && status < 300
              ? options?.suggestRoleResponse ?? {
                  suggestedRole: 'PROVEEDOR',
                  confidence: 0.92,
                  explanation: 'Matches supplier pattern',
                }
              : { error: 'AI service failed' },
          ),
      });
    }
    if (u.includes('/api/learning/classify-entity') && req?.method === 'POST') {
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve(
            options?.classifyResponse ?? { success: true, data: { role: 'PROVEEDOR' } },
          ),
      });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  });
}

// ─── Helper ──────────────────────────────────────────────────────────
async function selectRole(user: ReturnType<typeof userEvent.setup>, entityIdx: number, role: string) {
  const manualBtns = screen.getAllByTestId('manual-select-btn');
  await user.click(manualBtns[entityIdx]);
  await waitFor(() => {
    expect(screen.getAllByTestId('role-select').length).toBeGreaterThan(entityIdx);
  });
  const selects = screen.getAllByTestId('role-select');
  await user.selectOptions(selects[entityIdx], role);
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('EntityOnboardingModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // ── F3: Split flow (absence check) ───────────────────────────────
  describe('F3 — Split mixed entities', () => {
    it('does NOT show split UI for directional entities', async () => {
      setupFetch([debitCandidate]);
      render(<EntityOnboardingModal isOpen onClose={vi.fn()} companyId="comp_1" />);

      await waitFor(() => {
        expect(screen.getByText('DEBIT ENTITY')).toBeInTheDocument();
      });

      expect(screen.queryByText('Only credits')).not.toBeInTheDocument();
      expect(screen.queryByText('Only debits')).not.toBeInTheDocument();
    });
  });

  // ── F2: Direction mismatch warning (absence check) ───────────────
  describe('F2 — Direction mismatch warning', () => {
    it('does NOT show direction override warning in the UI', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      setupFetch([debitCandidate]);
      render(<EntityOnboardingModal isOpen onClose={vi.fn()} companyId="comp_1" />);

      await waitFor(() => {
        expect(screen.getByText('DEBIT ENTITY')).toBeInTheDocument();
      });

      await selectRole(user, 0, 'CLIENTE');

      expect(screen.queryByText('Assign anyway')).not.toBeInTheDocument();
    });
  });

  // ── 3.1 — Button text derivation ──────────────────────────────────
  describe('3.1 — Button text derivation', () => {
    it('shows assign button in manual mode for non-OTRO roles', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      setupFetch([debitCandidate]);
      render(<EntityOnboardingModal isOpen onClose={vi.fn()} companyId="comp_1" />);

      await waitFor(() => {
        expect(screen.getByText('DEBIT ENTITY')).toBeInTheDocument();
      });

      await selectRole(user, 0, 'PROVEEDOR');

      const assignBtn = screen.getByRole('button', { name: /Assign/i });
      expect(assignBtn).toBeInTheDocument();
      expect(assignBtn).not.toBeDisabled();
    });

    it('shows textarea and suggest button when OTRO selected with description >= 5 chars', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      setupFetch([debitCandidate]);
      render(<EntityOnboardingModal isOpen onClose={vi.fn()} companyId="comp_1" />);

      await waitFor(() => {
        expect(screen.getByText('DEBIT ENTITY')).toBeInTheDocument();
      });

      await selectRole(user, 0, 'OTRO');

      const textarea = await screen.findByPlaceholderText('Describe what this entity is...');
      await user.type(textarea, 'pays invoices monthly');

      await waitFor(() => {
        const suggestBtn = screen.getByRole('button', { name: /Suggest role/i });
        expect(suggestBtn).not.toBeDisabled();
      });
    });
  });

  // ── 3.2 — Inline suggestion banner ─────────────────────────────────
  describe('3.2 — Inline suggestion banner', () => {
    it('shows success banner with suggestion after classification', async () => {
      vi.useRealTimers();
      const user = userEvent.setup();
      setupFetch([debitCandidate], {
        suggestRoleResponse: {
          suggestedRole: 'PROVEEDOR',
          confidence: 0.92,
          explanation: 'Supplier pattern match',
        },
      });
      render(<EntityOnboardingModal isOpen onClose={vi.fn()} companyId="comp_1" />);

      await waitFor(() => {
        expect(screen.getByText('DEBIT ENTITY')).toBeInTheDocument();
      });

      await selectRole(user, 0, 'OTRO');

      const textarea = await screen.findByPlaceholderText('Describe what this entity is...');
      await user.type(textarea, 'pays invoices monthly');

      await user.click(screen.getByRole('button', { name: /Suggest role/i }));

      await waitFor(() => {
        expect(screen.getByText('Suggestion: Proveedor')).toBeInTheDocument();
      });
      expect(screen.getByText('Confidence: 92%')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /assign/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /discard/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /edit role manually/i })).toBeInTheDocument();
    });

    it('shows low confidence indicator when confidence < 0.7', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      setupFetch([debitCandidate], {
        suggestRoleResponse: {
          suggestedRole: 'PROVEEDOR',
          confidence: 0.45,
          explanation: 'Unclear pattern',
        },
      });
      render(<EntityOnboardingModal isOpen onClose={vi.fn()} companyId="comp_1" />);

      await waitFor(() => {
        expect(screen.getByText('DEBIT ENTITY')).toBeInTheDocument();
      });

      await selectRole(user, 0, 'OTRO');

      const textarea = await screen.findByPlaceholderText('Describe what this entity is...');
      await user.type(textarea, 'pays invoices monthly');

      await user.click(screen.getByRole('button', { name: /Suggest role/i }));

      await waitFor(() => {
        expect(screen.getByText('Low confidence: 45%')).toBeInTheDocument();
      });
    });

    it('shows error banner when API fails', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      setupFetch([debitCandidate], { suggestRoleStatus: 502 });
      render(<EntityOnboardingModal isOpen onClose={vi.fn()} companyId="comp_1" />);

      await waitFor(() => {
        expect(screen.getByText('DEBIT ENTITY')).toBeInTheDocument();
      });

      await selectRole(user, 0, 'OTRO');

      const textarea = await screen.findByPlaceholderText('Describe what this entity is...');
      await user.type(textarea, 'pays invoices monthly');

      await user.click(screen.getByRole('button', { name: /Suggest role/i }));

      await waitFor(() => {
        const msgs = screen.getAllByText('Not available now. Pick manually.');
        expect(msgs.length).toBeGreaterThanOrEqual(1);
      });
    });

    it('shows success state after user accepts suggestion', async () => {
      vi.useRealTimers();
      const user = userEvent.setup();
      setupFetch([debitCandidate], {
        suggestRoleResponse: {
          suggestedRole: 'PROVEEDOR',
          confidence: 0.92,
          explanation: 'Supplier pattern match',
        },
      });
      render(<EntityOnboardingModal isOpen onClose={vi.fn()} companyId="comp_1" />);

      await waitFor(() => {
        expect(screen.getByText('DEBIT ENTITY')).toBeInTheDocument();
      });

      await selectRole(user, 0, 'OTRO');

      const textarea = await screen.findByPlaceholderText('Describe what this entity is...');
      await user.type(textarea, 'pays invoices monthly');

      await user.click(screen.getByRole('button', { name: /Suggest role/i }));

      await waitFor(() => {
        expect(screen.getByText('Suggestion: Proveedor')).toBeInTheDocument();
      });
      await user.click(screen.getByRole('button', { name: /assign/i }));

      await waitFor(() => {
        expect(screen.getByText('All entities classified')).toBeInTheDocument();
      });
      expect(screen.getByText('No pending entities')).toBeInTheDocument();
    });

    it('FR-6: clicking "Edit role manually" allows selecting a different role', async () => {
      vi.useRealTimers();
      const user = userEvent.setup();
      setupFetch([debitCandidate], {
        suggestRoleResponse: {
          suggestedRole: 'PROVEEDOR',
          confidence: 0.92,
          explanation: 'Supplier pattern match',
        },
      });
      render(<EntityOnboardingModal isOpen onClose={vi.fn()} companyId="comp_1" />);

      await waitFor(() => {
        expect(screen.getByText('DEBIT ENTITY')).toBeInTheDocument();
      });

      await selectRole(user, 0, 'OTRO');

      const textarea = await screen.findByPlaceholderText('Describe what this entity is...');
      await user.type(textarea, 'pays invoices monthly');

      await user.click(screen.getByRole('button', { name: /Suggest role/i }));

      await waitFor(() => {
        expect(screen.getByText('Suggestion: Proveedor')).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /edit role manually/i }));

      await user.selectOptions(screen.getAllByTestId('role-select')[0], 'CLIENTE');

      await waitFor(() => {
        expect(screen.queryByText('Suggestion: Proveedor')).not.toBeInTheDocument();
      });
      expect(screen.getAllByTestId('role-select')[0]).toHaveValue('CLIENTE');
    });
  });

  // ── 4.6 — Discard suggestion ──────────────────────────────────────
  describe('4.6 — Discard suggestion', () => {
    it('hides banner and entity returns to pending mode after discard', async () => {
      vi.useRealTimers();
      const user = userEvent.setup();
      setupFetch([debitCandidate], {
        suggestRoleResponse: {
          suggestedRole: 'PROVEEDOR',
          confidence: 0.92,
          explanation: 'Supplier pattern',
        },
      });
      render(<EntityOnboardingModal isOpen onClose={vi.fn()} companyId="comp_1" />);

      await waitFor(() => {
        expect(screen.getByText('DEBIT ENTITY')).toBeInTheDocument();
      });

      await selectRole(user, 0, 'OTRO');

      const textarea = await screen.findByPlaceholderText('Describe what this entity is...');
      await user.type(textarea, 'pays invoices monthly');

      await user.click(screen.getByRole('button', { name: /Suggest role/i }));

      await waitFor(() => {
        expect(screen.getByText('Suggestion: Proveedor')).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /discard/i }));

      await waitFor(() => {
        expect(screen.queryByText('Suggestion: Proveedor')).not.toBeInTheDocument();
      });

      expect(screen.getByTestId('manual-select-btn')).toBeInTheDocument();
      expect(screen.getByTestId('pre-classify-btn')).toBeInTheDocument();
    });
  });
});
