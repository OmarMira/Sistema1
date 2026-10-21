// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, act, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EntityOnboardingModal } from '@/components/learning/EntityOnboardingModal';
import es from '@/i18n/locales/es';
import en from '@/i18n/locales/en';

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
        <option value="">Select...</option>
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
    'learning.newSuggestion': 'Get new suggestion',
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
    'learning.rentReceipt': 'Rent received',
    'learning.customRoleLabel': 'Nombre del rol personalizado',
    'learning.customRoleOption': 'Personalizado...',
    'learning.customRolePlaceholder': 'Ej: FIDEICOMISO, PLATAFORMA, INVERSOR...',
    'learning.accountGuidance.title': 'Suggested account',
    'learning.accountGuidance.useSuggested': 'Use suggested account',
    'learning.accountGuidance.chooseExisting': 'Choose another account',
    'learning.accountGuidance.createChild': 'Create subaccount',
    'learning.accountGuidance.confirmCreate': 'Confirm subaccount creation',
    'learning.accountGuidance.childName': 'Subaccount name',
    'learning.accountGuidance.cancel': 'Cancel creation',
    'learning.accountGuidance.createError': 'Could not create subaccount.',
    'learning.accountGuidance.codeConflict': 'Account code already exists. Choose another name or refresh.',
    'learning.accountGuidance.clarification': 'Please clarify the movement',
    'learning.accountGuidance.clarificationPlaceholder': 'Explain what these payments represent',
    'learning.accountGuidance.caution': 'Review this proposal. Not all movements from one entity represent the same concept.',
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
const languageState = vi.hoisted(() => ({ language: 'en' }));
const spanishT = (key: string, params?: Record<string, string | number>) => {
  let value: any = es;
  for (const part of key.split('.')) value = value?.[part];
  return Object.entries(params ?? {}).reduce((text, [name, replacement]) => text.replace(`{${name}}`, String(replacement)), typeof value === 'string' ? value : key);
};
vi.mock('@/store/language-store', () => ({
  useLanguageStore: (selector: (s: any) => any) => selector({ t: languageState.language === 'es' ? spanishT : tFn, language: languageState.language }),
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
    accounts?: any[];
    accountStatus?: number;
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
    if (u.includes('/api/accounts') && req?.method === 'POST') {
      const status = options?.accountStatus ?? 201;
      return Promise.resolve({ ok: status === 201, status, json: async () => ({
        account: { id: 'new-child', ...JSON.parse(String(req.body)) },
      }) });
    }
    if (u.includes('/api/accounts')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ accounts: options?.accounts ?? [{ id: 'gl-1', code: '4010', name: 'Test Account' }] }),
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
    languageState.language = 'en';
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  describe('per-entity suggestion lifecycle', () => {
    it('distinguishes first and subsequent requests in the real translations', () => {
      expect(es.learning.preClassify).toBe('Obtener sugerencia');
      expect(es.learning.newSuggestion).toBe('Obtener nueva sugerencia');
      expect(en.learning.preClassify).toBe('Get suggestion');
      expect(en.learning.newSuggestion).toBe('Get new suggestion');
    });

    it('starts with a first-suggestion label and does not request or save anything on opening', async () => {
      setupFetch([debitCandidate, creditCandidate]);
      render(<EntityOnboardingModal isOpen onClose={vi.fn()} companyId="comp_1" />);
      const buttons = await screen.findAllByTestId('pre-classify-btn');
      expect(buttons).toHaveLength(2);
      buttons.forEach((button) => expect(button).toHaveTextContent('Suggest role'));
      expect(mockFetch.mock.calls.filter(([url]) => url.includes('/suggest-role') || url.includes('/classify-entity'))).toHaveLength(0);
    });

    it('keeps history per entity after discard and sends it on a real retry without saving', async () => {
      vi.useRealTimers();
      const user = userEvent.setup();
      setupFetch([debitCandidate, creditCandidate]);
      render(<EntityOnboardingModal isOpen onClose={vi.fn()} companyId="comp_1" />);
      await user.click((await screen.findAllByTestId('pre-classify-btn'))[0]);
      expect(await screen.findByText('Matches supplier pattern')).toBeInTheDocument();
      await user.click(screen.getByTestId('discard-suggestion-btn'));
      const buttons = screen.getAllByTestId('pre-classify-btn');
      expect(buttons[0]).toHaveTextContent('Get new suggestion');
      expect(buttons[1]).toHaveTextContent('Suggest role');
      await user.click(buttons[0]);
      await screen.findByTestId('accept-suggestion-btn');
      const calls = mockFetch.mock.calls.filter(([url]) => url.includes('/suggest-role'));
      expect(calls).toHaveLength(2);
      expect(JSON.parse(calls[0][1].body)).toMatchObject({
        entityName: 'DEBIT ENTITY', description: 'DEBIT ENTITY', companyId: 'comp_1', manualRequest: true,
      });
      expect(JSON.parse(calls[0][1].body).previousSuggestion).toBeUndefined();
      expect(JSON.parse(calls[1][1].body)).toMatchObject({
        entityName: 'DEBIT ENTITY',
        previousSuggestion: { role: 'PROVEEDOR', explanation: 'Matches supplier pattern' },
      });
      expect(mockFetch.mock.calls.filter(([url]) => url.includes('/classify-entity'))).toHaveLength(0);
    });

    it('offers a new suggestion directly and saves only after explicit acceptance', async () => {
      vi.useRealTimers();
      const user = userEvent.setup();
      setupFetch([debitCandidate]);
      render(<EntityOnboardingModal isOpen onClose={vi.fn()} companyId="comp_1" />);
      await user.click(await screen.findByTestId('pre-classify-btn'));
      await user.click(await screen.findByRole('button', { name: /Get new suggestion/i }));
      await screen.findByTestId('accept-suggestion-btn');
      expect(mockFetch.mock.calls.filter(([url]) => url.includes('/suggest-role'))).toHaveLength(2);
      expect(mockFetch.mock.calls.filter(([url]) => url.includes('/classify-entity'))).toHaveLength(0);
      await user.click(screen.getByTestId('accept-suggestion-btn'));
      await screen.findByText('All entities classified');
      const saves = mockFetch.mock.calls.filter(([url]) => url.includes('/classify-entity'));
      expect(saves).toHaveLength(1);
      expect(JSON.parse(saves[0][1].body)).toEqual({
        companyId: 'comp_1', pattern: 'DEBIT ENTITY', userInput: 'DEBIT ENTITY', role: 'PROVEEDOR', createRule: false,
      });
    });

    it('can reevaluate a newly proposed role without assigning or creating it', async () => {
      vi.useRealTimers();
      const user = userEvent.setup();
      setupFetch([debitCandidate], { suggestRoleResponse: {
        suggestedRole: 'PLATAFORMA', confidence: 0.8, explanation: 'Platform payouts', isNewRole: true,
      } });
      render(<EntityOnboardingModal isOpen onClose={vi.fn()} companyId="comp_1" />);
      await user.click(await screen.findByTestId('pre-classify-btn'));
      await user.click(await screen.findByRole('button', { name: /Get new suggestion/i }));
      await screen.findByText('Platform payouts');
      expect(mockFetch.mock.calls.filter(([url]) => url.includes('/suggest-role'))).toHaveLength(2);
      expect(mockFetch.mock.calls.filter(([url]) => url.includes('/classify-entity'))).toHaveLength(0);
    });

    it('resets proposal history when the dialog closes', async () => {
      vi.useRealTimers();
      const user = userEvent.setup();
      setupFetch([debitCandidate]);
      const { rerender } = render(<EntityOnboardingModal isOpen onClose={vi.fn()} companyId="comp_1" />);
      await user.click(await screen.findByTestId('pre-classify-btn'));
      await screen.findByTestId('accept-suggestion-btn');
      rerender(<EntityOnboardingModal isOpen={false} onClose={vi.fn()} companyId="comp_1" />);
      rerender(<EntityOnboardingModal isOpen onClose={vi.fn()} companyId="comp_1" />);
      expect(await screen.findByTestId('pre-classify-btn')).toHaveTextContent('Suggest role');
      await user.click(screen.getByTestId('pre-classify-btn'));
      await screen.findByTestId('accept-suggestion-btn');
      const calls = mockFetch.mock.calls.filter(([url]) => url.includes('/suggest-role'));
      expect(JSON.parse(calls[1][1].body).previousSuggestion).toBeUndefined();
    });

    it('keeps the actual entity name when manual relationship context is provided', async () => {
      vi.useRealTimers();
      const user = userEvent.setup();
      setupFetch([debitCandidate]);
      render(<EntityOnboardingModal isOpen onClose={vi.fn()} companyId="comp_1" />);
      await screen.findByText('DEBIT ENTITY');
      await selectRole(user, 0, 'OTRO');
      await user.type(screen.getByPlaceholderText('Describe what this entity is...'), 'Owner withdrawal');
      await user.click(screen.getByRole('button', { name: /Suggest role/i }));
      await screen.findByTestId('accept-suggestion-btn');
      const calls = mockFetch.mock.calls.filter(([url]) => url.includes('/suggest-role'));
      expect(JSON.parse(calls[0][1].body)).toMatchObject({ entityName: 'DEBIT ENTITY', description: 'Owner withdrawal' });
    });
  });

  describe('account guidance for non-expert users', () => {
    const rentAccount = { id: 'rent', code: '4020', name: 'Ingresos por alquileres', accountType: 'revenue', normalBalance: 'credit', parentId: null, isActive: true };
    const guidance = {
      account: rentAccount, intent: 'RENT_PAYMENT', needsClarification: false,
      reason: 'Rental receipts belong to income.', question: null,
    };
    function setupGuidance(accountStatus = 201) {
      setupFetch([creditCandidate], { accounts: [rentAccount], accountStatus, suggestRoleResponse: {
        suggestedRole: 'INQUILINO', confidence: 0.9, explanation: 'Tenant payments.', accountGuidance: guidance,
      } });
    }

    it('offers the suggested account and receipt concept without silently enabling automation', async () => {
      vi.useRealTimers();
      const user = userEvent.setup();
      setupGuidance();
      render(<EntityOnboardingModal isOpen onClose={vi.fn()} companyId="comp_1" />);
      await user.click(await screen.findByTestId('pre-classify-btn'));
      await user.click(await screen.findByTestId('use-suggested-account'));
      expect(screen.getByText('Rent received')).toBeInTheDocument();
      expect(screen.getByTestId('create-rule-toggle')).not.toBeChecked();
      const requests = mockFetch.mock.calls.filter(([url]) => url.includes('/suggest-role'));
      expect(requests[0][1].headers).toMatchObject({ 'x-locale': 'en' });
      await user.click(screen.getByTestId('accept-suggestion-btn'));
      await screen.findByText('All entities classified');
      const saves = mockFetch.mock.calls.filter(([url]) => url.includes('/classify-entity'));
      expect(JSON.parse(saves[0][1].body)).toMatchObject({ glAccountCode: '4020', intent: 'RENT_PAYMENT', createRule: false });
    });

    it('uses Spanish controls and sends the selected language to suggestion and assignment', async () => {
      vi.useRealTimers();
      languageState.language = 'es';
      const user = userEvent.setup();
      setupFetch([creditCandidate], { accounts: [rentAccount], suggestRoleResponse: {
        suggestedRole: 'INQUILINO', confidence: 0.9, explanation: 'Son cobros de alquiler.',
        accountGuidance: { ...guidance, reason: 'Corresponden a ingresos, no a gastos.' },
      } });
      render(<EntityOnboardingModal isOpen onClose={vi.fn()} companyId="comp_1" />);
      await user.click(await screen.findByTestId('pre-classify-btn'));
      await screen.findByText('Son cobros de alquiler.');
      await user.click(screen.getByRole('button', { name: es.learning.accountGuidance.useSuggested }));
      expect(screen.getByText('Cobro de alquiler')).toBeInTheDocument();
      await user.click(screen.getByTestId('accept-suggestion-btn'));
      await screen.findByText(es.learning.allClassified);
      for (const [, req] of mockFetch.mock.calls.filter(([url]) => url.includes('/suggest-role') || url.includes('/classify-entity'))) {
        expect(req.headers).toMatchObject({ 'x-locale': 'es' });
      }
    });

    it('lets the user choose another existing account without creating one', async () => {
      vi.useRealTimers();
      const user = userEvent.setup();
      setupFetch([creditCandidate], { accounts: [rentAccount, { ...rentAccount, id: 'other-income', code: '4030', name: 'Other income' }], suggestRoleResponse: {
        suggestedRole: 'INQUILINO', confidence: 0.9, explanation: 'Tenant.', accountGuidance: guidance,
      } });
      render(<EntityOnboardingModal isOpen onClose={vi.fn()} companyId="comp_1" />);
      await user.click(await screen.findByTestId('pre-classify-btn'));
      await user.selectOptions(await screen.findByTestId('guidance-account-select'), '4030');
      await user.click(screen.getByTestId('accept-suggestion-btn'));
      await screen.findByText('All entities classified');
      const saves = mockFetch.mock.calls.filter(([url]) => url.includes('/classify-entity'));
      expect(JSON.parse(saves[0][1].body)).toMatchObject({ glAccountCode: '4030', createRule: false });
      expect(mockFetch.mock.calls.filter(([url, req]) => url.includes('/api/accounts') && req?.method === 'POST')).toHaveLength(0);
    });

    it('sends the clarification for reevaluation instead of saving a guessed account', async () => {
      vi.useRealTimers();
      const user = userEvent.setup();
      setupFetch([creditCandidate], { accounts: [rentAccount], suggestRoleResponse: {
        suggestedRole: 'INQUILINO', confidence: 0.6, explanation: 'Purpose unclear.',
        accountGuidance: { account: null, intent: null, needsClarification: true, reason: '', question: 'Rent or security deposit?' },
      } });
      render(<EntityOnboardingModal isOpen onClose={vi.fn()} companyId="comp_1" />);
      await user.click(await screen.findByTestId('pre-classify-btn'));
      await user.type(await screen.findByTestId('guidance-clarification'), 'Son cobros de alquiler de la unidad A');
      await user.click(screen.getByRole('button', { name: /Get new suggestion/i }));
      await waitFor(() => expect(mockFetch.mock.calls.filter(([url]) => url.includes('/suggest-role'))).toHaveLength(2));
      const requests = mockFetch.mock.calls.filter(([url]) => url.includes('/suggest-role'));
      expect(JSON.parse(requests[1][1].body)).toMatchObject({ entityName: creditCandidate.canonicalName, description: 'Son cobros de alquiler de la unidad A' });
      expect(mockFetch.mock.calls.filter(([url]) => url.includes('/classify-entity'))).toHaveLength(0);
    });

    it('creates a child only after explicit confirmation, inheriting its actual parent type', async () => {
      vi.useRealTimers();
      const user = userEvent.setup();
      setupGuidance();
      render(<EntityOnboardingModal isOpen onClose={vi.fn()} companyId="comp_1" />);
      await user.click(await screen.findByTestId('pre-classify-btn'));
      await user.click(await screen.findByTestId('create-subaccount-btn'));
      expect(screen.getByText(/4020-01/)).toBeInTheDocument();
      expect(mockFetch.mock.calls.filter(([url, req]) => url.includes('/api/accounts') && req?.method === 'POST')).toHaveLength(0);
      await user.type(screen.getByTestId('subaccount-name'), 'Alquiler Unidad A');
      await user.click(screen.getByTestId('confirm-subaccount-btn'));
      await waitFor(() => expect(screen.getByTestId('guidance-account-select')).toHaveValue('4020-01'));
      const creates = mockFetch.mock.calls.filter(([url, req]) => url.includes('/api/accounts') && req?.method === 'POST');
      expect(creates).toHaveLength(1);
      expect(JSON.parse(creates[0][1].body)).toEqual({ code: '4020-01', name: 'Alquiler Unidad A', accountType: 'revenue', normalBalance: 'credit', parentId: 'rent' });
      expect(mockFetch.mock.calls.filter(([url]) => url.includes('/classify-entity'))).toHaveLength(0);
    });

    it('does not save a classification when child creation fails', async () => {
      vi.useRealTimers();
      const user = userEvent.setup();
      setupGuidance(409);
      render(<EntityOnboardingModal isOpen onClose={vi.fn()} companyId="comp_1" />);
      await user.click(await screen.findByTestId('pre-classify-btn'));
      await user.click(await screen.findByTestId('create-subaccount-btn'));
      await user.type(screen.getByTestId('subaccount-name'), 'Alquiler Unidad A');
      await user.click(screen.getByTestId('confirm-subaccount-btn'));
      await screen.findByRole('alert');
      expect(screen.getByTestId('guidance-account-select')).toHaveValue('');
      expect(mockFetch.mock.calls.filter(([url]) => url.includes('/classify-entity'))).toHaveLength(0);
    });
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
        expect(screen.getByText('This entity already has a rule for this intent with a different GL account.')).toBeInTheDocument();
        expect(screen.queryByText(/CONFLICT:/i)).not.toBeInTheDocument();
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

  describe('E1 — saved entities leave candidates and reset on reopen', () => {
    it('after saving a candidate it is removed, no duplicate HTTP save, and reopen resets', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      setupFetch([debitCandidate]);
      const { rerender } = render(
        <EntityOnboardingModal isOpen onClose={vi.fn()} companyId="comp_1" />,
      );

      // 1) candidate visible before saving
      await waitFor(() => {
        expect(screen.getByText('DEBIT ENTITY')).toBeInTheDocument();
      });
      expect(screen.getAllByTestId('manual-select-btn')).toHaveLength(1);

      // 2) successful save
      await selectRole(user, 0, 'PROVEEDOR');
      await user.click(screen.getByRole('button', { name: /Save entity/i }));
      await waitFor(() => {
        expect(screen.getByText('All entities classified')).toBeInTheDocument();
      });

      // 3) candidate disappears from remaining candidates (no pending save affordance)
      expect(screen.queryByTestId('manual-select-btn')).not.toBeInTheDocument();

      // 4) the same candidate was POSTed exactly once (no duplicate HTTP save) together with the removal
      const classifyCalls = mockFetch.mock.calls.filter(
        ([u, r]) =>
          typeof u === 'string' &&
          u.includes('/api/learning/classify-entity') &&
          (r as RequestInit | undefined)?.method === 'POST',
      );
      expect(classifyCalls).toHaveLength(1);

      // 5) close and reopen resets the saved set so the candidate is offered again
      rerender(<EntityOnboardingModal isOpen={false} onClose={vi.fn()} companyId="comp_1" />);
      rerender(<EntityOnboardingModal isOpen onClose={vi.fn()} companyId="comp_1" />);
      await waitFor(() => {
        expect(screen.getByText('DEBIT ENTITY')).toBeInTheDocument();
      });
      expect(screen.getAllByTestId('manual-select-btn')).toHaveLength(1);
    });

    it('duplicate guard: continuing the flow after a successful save does not re-POST the entity', async () => {
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

      const classifyCalls = mockFetch.mock.calls.filter(
        ([u, r]) =>
          typeof u === 'string' &&
          u.includes('/api/learning/classify-entity') &&
          (r as RequestInit | undefined)?.method === 'POST',
      );
      expect(classifyCalls).toHaveLength(1);
    });
  });
});
