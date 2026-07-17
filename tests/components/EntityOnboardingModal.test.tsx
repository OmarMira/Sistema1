// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, act, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EntityOnboardingModal } from '@/components/learning/EntityOnboardingModal';

afterEach(() => cleanup());

// ─── Mock shadcn Select with native <select> for jsdom ────────────
vi.mock('@/components/ui/select', () => ({
  Select: ({ value, onValueChange, disabled, children }: any) => {
    let testId = 'mock-select';
    const options: { value: string; label: string }[] = [];
    React.Children.forEach(children, (child: any) => {
      if (!React.isValidElement(child)) return;
      if (child.props?.['data-testid']) {
        testId = child.props['data-testid'];
      }
      if (child.props?.children) {
        React.Children.forEach(child.props.children, (sub: any) => {
          if (!React.isValidElement(sub)) return;
          if (sub.props?.['data-testid']) {
            testId = sub.props['data-testid'];
          }
          if (sub.props?.value !== undefined) {
            options.push({ value: sub.props.value, label: String(sub.props.children ?? sub.props.value) });
          }
        });
      }
    });
    return (
      <select
        data-testid={testId}
        value={value ?? ''}
        onChange={(e) => onValueChange?.(e.target.value)}
        disabled={disabled}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
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
}));

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
    'learning.automationToggle': 'Do you want to automate these transactions?',
    'learning.saveEntity': 'Save entity',
    'learning.saveEntityAndRule': 'Save entity and create rule',
    'learning.conflictError': 'This entity already has a rule for this intent with a different GL account.',
    'learning.noAccounts': 'No GL accounts available',
    'learning.loadingAccounts': 'Loading accounts...',
    'learning.accountsError': 'Failed to load GL accounts.',
    'learning.intentRequired': 'Intent is required when creating a rule.',
    'learning.glAccountRequired': 'GL Account is required when creating a rule.',
    'learning.intentSelectorPlaceholder': 'What does this movement represent?',
    'learning.glAccount': 'GL Account',
    'learning.accountPlaceholder': 'Select an account...',
    'transactionIntent.OPERATING_EXPENSE': 'Operating Expense',
    'transactionIntent.LOAN_PAYMENT': 'Loan Payment',
    'transactionIntent.RENT_PAYMENT': 'Rent Payment',
    'transactionIntent.OWNER_CONTRIBUTION': 'Owner Contribution',
    'transactionIntent.CUSTOMER_PAYMENT': 'Customer Payment',
    'transactionIntent.TRANSFER': 'Transfer',
    'transactionIntent.TAX_PAYMENT': 'Tax Payment',
    'transactionIntent.OTHER': 'Other',
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
    classifyStatus?: number;
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
    if (u.includes('/api/accounts')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ accounts: [{ id: 'gl-1', code: '4010', name: 'Test Account' }] }),
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
      const status = options?.classifyStatus ?? 200;
      return Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        json: () =>
          Promise.resolve(
            status >= 200 && status < 300
              ? options?.classifyResponse ?? { success: true, data: { role: 'PROVEEDOR' } }
              : status === 409
                ? { error: 'CONFLICT: Rule already exists with a different GL Account' }
                : { error: 'Classify error' },
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
    it('shows save button in manual mode for non-OTRO roles', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      setupFetch([debitCandidate]);
      render(<EntityOnboardingModal isOpen onClose={vi.fn()} companyId="comp_1" />);

      await waitFor(() => {
        expect(screen.getByText('DEBIT ENTITY')).toBeInTheDocument();
      });

      await selectRole(user, 0, 'PROVEEDOR');

      const assignBtn = screen.getByRole('button', { name: /Save entity/i });
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

  // ── S6-02: Automation toggle ─────────────────────────────────────
  describe('S6-02 — Entity Onboarding UI automation', () => {
    function getToggle(name: string): HTMLInputElement {
      const toggles = screen.getAllByTestId('create-rule-toggle');
      const idx = [...screen.getAllByTestId('create-rule-toggle')].findIndex(
        (t) => t.closest('.border')?.textContent?.includes(name),
      );
      return screen.getAllByTestId<HTMLInputElement>('create-rule-toggle')[idx >= 0 ? idx : 0];
    }

    it('toggle is off by default', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      setupFetch([debitCandidate]);
      render(<EntityOnboardingModal isOpen onClose={vi.fn()} companyId="comp_1" />);

      await waitFor(() => {
        expect(screen.getByText('DEBIT ENTITY')).toBeInTheDocument();
      });

      await selectRole(user, 0, 'PROVEEDOR');

      const toggle = screen.getByTestId<HTMLInputElement>('create-rule-toggle');
      expect(toggle).not.toBeChecked();
    });

    it('OFF hides intent and GL account selectors', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      setupFetch([debitCandidate]);
      render(<EntityOnboardingModal isOpen onClose={vi.fn()} companyId="comp_1" />);

      await waitFor(() => {
        expect(screen.getByText('DEBIT ENTITY')).toBeInTheDocument();
      });

      await selectRole(user, 0, 'PROVEEDOR');

      expect(screen.queryByTestId('intent-select')).not.toBeInTheDocument();
      expect(screen.queryByTestId('gl-account-select')).not.toBeInTheDocument();
    });

    it('OFF sends createRule:false', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      setupFetch([debitCandidate]);
      render(<EntityOnboardingModal isOpen onClose={vi.fn()} companyId="comp_1" />);

      await waitFor(() => {
        expect(screen.getByText('DEBIT ENTITY')).toBeInTheDocument();
      });

      await selectRole(user, 0, 'PROVEEDOR');
      await user.click(screen.getByRole('button', { name: /Save entity/i }));

      await waitFor(() => {
        const call = mockFetch.mock.calls.find(
          (c: any) => c[0].includes('classify-entity'),
        );
        expect(call).toBeDefined();
        const body = JSON.parse(call[1].body);
        expect(body.createRule).toBe(false);
      });
    });

    it('ON shows intent and GL account selectors', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      setupFetch([debitCandidate]);
      render(<EntityOnboardingModal isOpen onClose={vi.fn()} companyId="comp_1" />);

      await waitFor(() => {
        expect(screen.getByText('DEBIT ENTITY')).toBeInTheDocument();
      });

      await selectRole(user, 0, 'PROVEEDOR');

      const toggle = screen.getByTestId<HTMLInputElement>('create-rule-toggle');
      await user.click(toggle);

      await waitFor(() => {
        expect(screen.getByTestId('intent-select')).toBeInTheDocument();
      });
      expect(screen.getByTestId('gl-account-select')).toBeInTheDocument();
    });

    it('ON blocks submit if intent or GL account is missing', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      setupFetch([debitCandidate]);
      render(<EntityOnboardingModal isOpen onClose={vi.fn()} companyId="comp_1" />);

      await waitFor(() => {
        expect(screen.getByText('DEBIT ENTITY')).toBeInTheDocument();
      });

      await selectRole(user, 0, 'PROVEEDOR');

      const toggle = screen.getByTestId<HTMLInputElement>('create-rule-toggle');
      await user.click(toggle);

      const saveBtn = screen.getByRole('button', { name: /Save entity and create rule/i });
      expect(saveBtn).toBeDisabled();
    });

    it('ON sends createRule:true with intent and GL account', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      setupFetch([debitCandidate]);
      render(<EntityOnboardingModal isOpen onClose={vi.fn()} companyId="comp_1" />);

      await waitFor(() => {
        expect(screen.getByText('DEBIT ENTITY')).toBeInTheDocument();
      });

      await selectRole(user, 0, 'PROVEEDOR');

      const toggle = screen.getByTestId<HTMLInputElement>('create-rule-toggle');
      await user.click(toggle);

      const intentSelect = screen.getByTestId('intent-select');
      await user.selectOptions(intentSelect, 'OPERATING_EXPENSE');

      const glSelect = screen.getByTestId('gl-account-select');
      await user.selectOptions(glSelect, '4010');

      await user.click(screen.getByRole('button', { name: /Save entity and create rule/i }));

      await waitFor(() => {
        const call = mockFetch.mock.calls.find(
          (c: any) => c[0].includes('classify-entity'),
        );
        expect(call).toBeDefined();
        const body = JSON.parse(call[1].body);
        expect(body.createRule).toBe(true);
        expect(body.intent).toBe('OPERATING_EXPENSE');
        expect(body.glAccountCode).toBe('4010');
      });
    });

    it('role and intent remain independent (no coupling)', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      setupFetch([debitCandidate]);
      render(<EntityOnboardingModal isOpen onClose={vi.fn()} companyId="comp_1" />);

      await waitFor(() => {
        expect(screen.getByText('DEBIT ENTITY')).toBeInTheDocument();
      });

      await selectRole(user, 0, 'PROVEEDOR');

      const toggle = screen.getByTestId<HTMLInputElement>('create-rule-toggle');
      await user.click(toggle);

      await user.selectOptions(screen.getByTestId('intent-select'), 'LOAN_PAYMENT');
      await user.selectOptions(screen.getByTestId('gl-account-select'), '4010');

      await user.click(screen.getByRole('button', { name: /Save entity and create rule/i }));

      await waitFor(() => {
        const call = mockFetch.mock.calls.find(
          (c: any) => c[0].includes('classify-entity'),
        );
        expect(call).toBeDefined();
        const body = JSON.parse(call[1].body);
        // Role stays PROVEEDOR, not overwritten by LOAN_PAYMENT intent
        expect(body.role).toBe('PROVEEDOR');
        expect(body.intent).toBe('LOAN_PAYMENT');
      });
    });

    it('GASTO_OPERATIVO and INGRESO are not in the role selector', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      setupFetch([debitCandidate]);
      render(<EntityOnboardingModal isOpen onClose={vi.fn()} companyId="comp_1" />);

      await waitFor(() => {
        expect(screen.getByText('DEBIT ENTITY')).toBeInTheDocument();
      });

      await selectRole(user, 0, 'PROVEEDOR');

      const roleSelect = screen.getAllByTestId('role-select')[0];
      const options = Array.from(roleSelect.querySelectorAll('option')).map((o: any) => o.value);
      expect(options).not.toContain('GASTO_OPERATIVO');
      expect(options).not.toContain('INGRESO');
      expect(options).not.toContain('IGNORADA');
    });

    it('409 conflict is shown without closing the modal', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      setupFetch([debitCandidate], { classifyStatus: 409 });
      render(<EntityOnboardingModal isOpen onClose={vi.fn()} companyId="comp_1" />);

      await waitFor(() => {
        expect(screen.getByText('DEBIT ENTITY')).toBeInTheDocument();
      });

      await selectRole(user, 0, 'PROVEEDOR');

      const toggle = screen.getByTestId<HTMLInputElement>('create-rule-toggle');
      await user.click(toggle);

      await user.selectOptions(screen.getByTestId('intent-select'), 'OPERATING_EXPENSE');
      await user.selectOptions(screen.getByTestId('gl-account-select'), '4010');

      await user.click(screen.getByRole('button', { name: /Save entity and create rule/i }));

      await waitFor(() => {
        expect(screen.getByText(/CONFLICT/i)).toBeInTheDocument();
      });

      // Modal is still open — we can still interact
      expect(screen.getByTestId('create-rule-toggle')).toBeInTheDocument();
    });

    it('success OFF saves entity only', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      setupFetch([debitCandidate]);
      render(<EntityOnboardingModal isOpen onClose={vi.fn()} companyId="comp_1" />);

      await waitFor(() => {
        expect(screen.getByText('DEBIT ENTITY')).toBeInTheDocument();
      });

      await selectRole(user, 0, 'PROVEEDOR');

      await user.click(screen.getByRole('button', { name: /Save entity/i }));

      await waitFor(() => {
        expect(screen.getByText('All entities classified')).toBeInTheDocument();
      });
    });

    it('success ON saves entity and creates rule', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      setupFetch([debitCandidate]);
      render(<EntityOnboardingModal isOpen onClose={vi.fn()} companyId="comp_1" />);

      await waitFor(() => {
        expect(screen.getByText('DEBIT ENTITY')).toBeInTheDocument();
      });

      await selectRole(user, 0, 'PROVEEDOR');

      const toggle = screen.getByTestId<HTMLInputElement>('create-rule-toggle');
      await user.click(toggle);

      await user.selectOptions(screen.getByTestId('intent-select'), 'OPERATING_EXPENSE');
      await user.selectOptions(screen.getByTestId('gl-account-select'), '4010');

      await user.click(screen.getByRole('button', { name: /Save entity and create rule/i }));

      await waitFor(() => {
        expect(screen.getByText('All entities classified')).toBeInTheDocument();
      });
    });

    it('FR-7: existing-role suggestion button is disabled when toggle ON without intent/account', async () => {
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

      const toggle = screen.getByTestId<HTMLInputElement>('create-rule-toggle');
      await user.click(toggle);

      const acceptBtn = screen.getByRole('button', { name: /assign/i });
      expect(acceptBtn).toBeDisabled();
    });

    it('FR-7: new-role suggestion button is disabled when toggle ON without intent/account', async () => {
      vi.useRealTimers();
      const user = userEvent.setup();
      setupFetch([debitCandidate], {
        suggestRoleResponse: {
          suggestedRole: 'PROVEEDOR',
          confidence: 0.92,
          explanation: 'Supplier pattern match',
          isNewRole: true,
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
        expect(screen.getByText(/Suggested new role/i)).toBeInTheDocument();
      });

      const toggle = screen.getByTestId<HTMLInputElement>('create-rule-toggle');
      await user.click(toggle);

      const useBtn = screen.getByRole('button', { name: /Use this role/i });
      expect(useBtn).toBeDisabled();
    });
  });
});
