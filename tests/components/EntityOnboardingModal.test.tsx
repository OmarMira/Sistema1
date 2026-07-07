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
      // Extract data-testid from SelectTrigger child
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
    'learning.otroDescription': 'Describe what this entity is...',
    'learning.otroAnalyzing': 'Analyzing...',
    'learning.selectRole': 'Select role...',
    'learning.preClassify': 'Suggest role',
    'learning.preClassifyPlural': 'Suggest roles',
    'learning.saveClassificationSingular': 'Save classification',
    'learning.saveClassificationPlural': 'Save classifications',
    'learning.close': 'Close',
    'learning.batch.loading': 'Classifying entities...',
    'learning.classifyCount': 'Classify ({count})',
    'learning.saving': 'Saving...',
    'learning.suggestionBanner.pending': 'Classifying...',
    'learning.suggestionBanner.title': 'Suggestion: {role}',
    'learning.suggestionBanner.confidence': 'Confidence: {percent}%',
    'learning.suggestionBanner.lowConfidence': 'Low confidence: {percent}%',
    'learning.suggestionBanner.accept': 'Assign',
    'learning.suggestionBanner.discard': 'Discard',
    'learning.suggestionBanner.edit': 'Edit role manually',
    'learning.suggestionBanner.error': 'Not available now. Pick manually.',
    'learning.suggestionBanner.assigned': 'Role assigned: {role}',
    'learning.suggestionDismissed': 'Pick manually from dropdown',
    'learning.suggestionLowConfidence': 'Could not determine role, describe more',
    'learning.suggestionReady': '{role} ({account}). {explanation}',
    'learning.suggestionAssign': 'ASIGN',
    'learning.fetchError': 'Error fetching candidates',
    'learning.loadError': 'Error loading data',
    'learning.suggestionError': 'Not available now',
    'learning.directionOverride': 'Assign anyway',
    'common.cancel': 'Cancel',
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

// Mock logger to suppress noise
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

  // ── 5.5 — F3: Split flow ─────────────────────────────────────────
  describe('F3 — Split mixed entities', () => {
    async function selectRole(
      user: ReturnType<typeof userEvent.setup>,
      entityIdx: number,
      role: string,
    ) {
      const manualBtns = screen.getAllByTestId('manual-select-btn');
      await user.click(manualBtns[0]);
      await waitFor(() => {
        expect(screen.getAllByTestId('role-select').length).toBeGreaterThan(entityIdx);
      });
      const selects = screen.getAllByTestId('role-select');
      await user.selectOptions(selects[entityIdx], role);
    }

    it('shows split UI for mixed entity (both sides >= 15%)', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      setupFetch([mixedCandidate]);
      render(<EntityOnboardingModal isOpen onClose={vi.fn()} companyId="comp_1" />);

      // Wait for candidates to load
      await waitFor(() => {
        expect(screen.getByText('MIXED ENTITY')).toBeInTheDocument();
      });

      // Split only shows after selecting a non-OTRO role (F3 fix)
      await selectRole(user, 0, 'PROVEEDOR');

      // Split UI should appear with 3 buttons
      expect(screen.getByText('Only credits')).toBeInTheDocument();
      expect(screen.getByText('Only debits')).toBeInTheDocument();
      expect(screen.getByText('Both (keep as one)')).toBeInTheDocument();
    });

    it('does NOT show split UI for directional entities', async () => {
      setupFetch([debitCandidate]);
      render(<EntityOnboardingModal isOpen onClose={vi.fn()} companyId="comp_1" />);

      await waitFor(() => {
        expect(screen.getByText('DEBIT ENTITY')).toBeInTheDocument();
      });

      expect(screen.queryByText('Only credits')).not.toBeInTheDocument();
      expect(screen.queryByText('Only debits')).not.toBeInTheDocument();
    });

    it('shows split UI for multiple entities independently', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      setupFetch([mixedCandidate, creditCandidate]);
      render(<EntityOnboardingModal isOpen onClose={vi.fn()} companyId="comp_1" />);

      await waitFor(() => {
        expect(screen.getByText('MIXED ENTITY')).toBeInTheDocument();
        expect(screen.getByText('CREDIT ENTITY')).toBeInTheDocument();
      });

      // Only MIXED ENTITY has the split UI — select a role first
      await selectRole(user, 0, 'PROVEEDOR');

      const splitButtons = screen.getAllByText('Only credits');
      expect(splitButtons).toHaveLength(1);
    });

    it('marks split button as active when clicked (credit)', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      setupFetch([mixedCandidate]);
      render(<EntityOnboardingModal isOpen onClose={vi.fn()} companyId="comp_1" />);

      await waitFor(() => {
        expect(screen.getByText('MIXED ENTITY')).toBeInTheDocument();
      });

      // Select a non-OTRO role first so split UI appears
      await selectRole(user, 0, 'PROVEEDOR');

      const creditBtn = screen.getByText('Only credits');
      await user.click(creditBtn);

      // Button should be variant="default" (active) — we can check class
      expect(creditBtn.className).toContain('bg-primary');
    });
  });

  // ── F2: Direction mismatch warning ───────────────────────────────
  describe('F2 — Direction mismatch warning', () => {
    async function selectRole(user: ReturnType<typeof userEvent.setup>, entityIdx: number, role: string) {
      const manualBtns = screen.getAllByTestId('manual-select-btn');
      await user.click(manualBtns[0]);
      await waitFor(() => {
        expect(screen.getAllByTestId('role-select').length).toBeGreaterThan(entityIdx);
      });
      const selects = screen.getAllByTestId('role-select');
      await user.selectOptions(selects[entityIdx], role);
    }

    it('shows warning when debit-heavy entity is assigned CLIENTE (expects credits)', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      // debitCandidate has 90% debits
      setupFetch([debitCandidate]);
      render(<EntityOnboardingModal isOpen onClose={vi.fn()} companyId="comp_1" />);

      await waitFor(() => {
        expect(screen.getByText('DEBIT ENTITY')).toBeInTheDocument();
      });

      // Select CLIENTE (expects credits) — conflicts with 90% debits
      await selectRole(user, 0, 'CLIENTE');

      // Warning banner should appear — the directionOverride key was called
      await waitFor(() => {
        expect(tFn).toHaveBeenCalledWith('learning.directionOverride');
      });
    });

    it('does NOT show warning when role matches direction', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      setupFetch([debitCandidate]);
      render(<EntityOnboardingModal isOpen onClose={vi.fn()} companyId="comp_1" />);

      await waitFor(() => {
        expect(screen.getByText('DEBIT ENTITY')).toBeInTheDocument();
      });

      // Select PROVEEDOR (expects debits) — matches 90% debits
      await selectRole(user, 0, 'PROVEEDOR');

      // No directionOverride call should happen
      expect(tFn).not.toHaveBeenCalledWith('learning.directionOverride');
    });
  });

  // ── Block save when all OTRO ─────────────────────────────────────
  describe('F4 — Block save (allOtroOrEmpty)', () => {
    async function selectRole(user: ReturnType<typeof userEvent.setup>, entityIdx: number, role: string) {
      const manualBtns = screen.getAllByTestId('manual-select-btn');
      await user.click(manualBtns[0]);
      await waitFor(() => {
        expect(screen.getAllByTestId('role-select').length).toBeGreaterThan(entityIdx);
      });
      const selects = screen.getAllByTestId('role-select');
      await user.selectOptions(selects[entityIdx], role);
    }

    it('disables save button when all selections are OTRO', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      setupFetch([debitCandidate]);
      render(<EntityOnboardingModal isOpen onClose={vi.fn()} companyId="comp_1" />);

      await waitFor(() => {
        expect(screen.getByText('DEBIT ENTITY')).toBeInTheDocument();
      });

      // Select OTRO
      await selectRole(user, 0, 'OTRO');

      // Main save button should be disabled (OTRO needs description)
      const saveBtn = screen.getByRole('button', { name: 'Save classification' });
      expect(saveBtn).toBeDisabled();
    });

    it('enables save button when at least one non-OTRO role is selected', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      setupFetch([debitCandidate, mixedCandidate]);
      render(<EntityOnboardingModal isOpen onClose={vi.fn()} companyId="comp_1" />);

      await waitFor(() => {
        expect(screen.getByText('DEBIT ENTITY')).toBeInTheDocument();
        expect(screen.getByText('MIXED ENTITY')).toBeInTheDocument();
      });

      // Set DEBIT to PROVEEDOR (first entity, index 0)
      await selectRole(user, 0, 'PROVEEDOR');

      const saveBtn = screen.getByRole('button', { name: 'Save classifications' });
      expect(saveBtn).not.toBeDisabled();
    });
  });

  // ── 4.2 — Descriptions snapshot prevents mid-batch pollution (FR-11) ──
  describe('4.2 — Descriptions snapshot (FR-11)', () => {
    async function selectRole(user: ReturnType<typeof userEvent.setup>, entityIdx: number, role: string) {
      const manualBtns = screen.getAllByTestId('manual-select-btn');
      await user.click(manualBtns[0]);
      await waitFor(() => {
        expect(screen.getAllByTestId('role-select').length).toBeGreaterThan(entityIdx);
      });
      const selects = screen.getAllByTestId('role-select');
      await user.selectOptions(selects[entityIdx], role);
    }

    it('snapshots descriptions at click and excludes later changes from batch', async () => {
      vi.useRealTimers();
      const user = userEvent.setup();
      const capturedBodies: string[] = [];

      // Use a controlled fetch that captures bodies and then resolves
      let resolveFirst: ((v: any) => void) | null = null;
      const controlledPromise = new Promise<Response>((resolve) => {
        resolveFirst = resolve;
      });

      const entityA = { ...debitCandidate, canonicalName: 'ENTITY_A' };
      setupFetch([entityA, { ...mixedCandidate, canonicalName: 'ENTITY_B' }]);
      mockFetch.mockImplementation((url: string, req?: RequestInit) => {
        const u = typeof url === 'string' ? url : '';
        if (u.includes('/api/learning/smart-classify') && (!req || req.method === 'GET')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                success: true,
                data: [
                  { ...debitCandidate, canonicalName: 'ENTITY_A' },
                  { ...mixedCandidate, canonicalName: 'ENTITY_B' },
                ],
              }),
          });
        }
        if (u.includes('/api/learning/suggest-role')) {
          capturedBodies.push(JSON.parse((req as RequestInit).body as string).description);
          return controlledPromise;
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      });

      render(<EntityOnboardingModal isOpen onClose={vi.fn()} companyId="comp_1" />);

      await waitFor(() => {
        expect(screen.getByText('ENTITY_A')).toBeInTheDocument();
        expect(screen.getByText('ENTITY_B')).toBeInTheDocument();
      });

      // Select OTRO for both entities
      await selectRole(user, 0, 'OTRO');
      await selectRole(user, 1, 'OTRO');

      // Type descriptions for both
      const textareas = screen.getAllByPlaceholderText('Describe what this entity is...');
      await user.type(textareas[0], 'entity a description');
      await user.type(textareas[1], 'entity b description');

      // Click "Pre classify entities" — this snapshots descriptions
      const preClassifyFooter = screen.getByRole('button', { name: 'Suggest roles' });
      await user.click(preClassifyFooter);

      // NOW change entity A's description during the batch
      await user.clear(textareas[0]);
      await user.type(textareas[0], 'polluted description');

      // Resolve the controlled promise
      resolveFirst!(
        new Response(
          JSON.stringify({
            suggestedRole: 'PROVEEDOR',
            confidence: 0.92,
            explanation: 'Supplier pattern',
          }),
          { status: 200 },
        ),
      );

      // Wait for batch to complete
      await waitFor(() => {
        expect(screen.getByText('Suggestion: Proveedor')).toBeInTheDocument();
      });

      // Verify the captured descriptions were the ORIGINAL (snapshot) values, not the polluted one
      expect(capturedBodies).toHaveLength(2);
      expect(capturedBodies).toContain('entity a description');
      expect(capturedBodies).toContain('entity b description');
      expect(capturedBodies).not.toContain('polluted description');
    });
  });

  // ── 4.3 — Promise.allSettled fires parallel requests with correct bodies ──
  describe('4.3 — Parallel batch requests', () => {
    async function selectRole(user: ReturnType<typeof userEvent.setup>, entityIdx: number, role: string) {
      // Click first available manual-select-btn (array shrinks as entities enter manual mode)
      const manualBtns = screen.getAllByTestId('manual-select-btn');
      await user.click(manualBtns[0]);
      await waitFor(() => {
        expect(screen.getAllByTestId('role-select').length).toBeGreaterThan(entityIdx);
      });
      const selects = screen.getAllByTestId('role-select');
      await user.selectOptions(selects[entityIdx], role);
    }

    it('fires 3 parallel POST requests with correct description bodies for 3 OTRO entities', async () => {
      vi.useRealTimers();
      const user = userEvent.setup();

      const entities = [
        { ...debitCandidate, canonicalName: 'ENTITY_1' },
        { ...creditCandidate, canonicalName: 'ENTITY_2' },
        { ...mixedCandidate, canonicalName: 'ENTITY_3' },
      ];

      setupFetch(entities);
      render(<EntityOnboardingModal isOpen onClose={vi.fn()} companyId="comp_1" />);

      await waitFor(() => {
        expect(screen.getByText('ENTITY_1')).toBeInTheDocument();
        expect(screen.getByText('ENTITY_2')).toBeInTheDocument();
        expect(screen.getByText('ENTITY_3')).toBeInTheDocument();
      });

      // Select OTRO for all 3
      await selectRole(user, 0, 'OTRO');
      await selectRole(user, 1, 'OTRO');
      await selectRole(user, 2, 'OTRO');

      // Type descriptions
      const textareas = screen.getAllByPlaceholderText('Describe what this entity is...');
      await user.type(textareas[0], 'rent payment');
      await user.type(textareas[1], 'customer invoice');
      await user.type(textareas[2], 'supplier bill');

      // Click footer "Suggest roles" button (triggers batch)
      await user.click(screen.getByRole('button', { name: 'Suggest roles' }));
      await waitFor(() => {
        const banners = screen.getAllByText('Suggestion: Proveedor');
        expect(banners).toHaveLength(3);
      });

      // Verify 3 POST calls to suggest-role with correct bodies
      const allCalls = mockFetch.mock.calls as [string, RequestInit][];
      const suggestCalls = allCalls.filter(
        ([url]) => typeof url === 'string' && url.includes('/api/learning/suggest-role'),
      );
      expect(suggestCalls).toHaveLength(3);
      const bodies = suggestCalls.map(([, req]) => JSON.parse(req.body as string));
      expect(bodies.map((b: { description: string }) => b.description).sort()).toEqual([
        'customer invoice',
        'rent payment',
        'supplier bill',
      ]);
    });
  });

  // ── 4.4 — Batch results update per-entity state independently ──────────
  describe('4.4 — Independent batch results', () => {
    async function selectRole(user: ReturnType<typeof userEvent.setup>, entityIdx: number, role: string) {
      const manualBtns = screen.getAllByTestId('manual-select-btn');
      await user.click(manualBtns[0]);
      await waitFor(() => {
        expect(screen.getAllByTestId('role-select').length).toBeGreaterThan(entityIdx);
      });
      const selects = screen.getAllByTestId('role-select');
      await user.selectOptions(selects[entityIdx], role);
    }

    it('handles success, error, and low-confidence independently for 3 entities', async () => {
      vi.useRealTimers();
      const user = userEvent.setup();

      // Use call-index-based mock: first call succeeds, second fails, third succeeds with low confidence
      let callIndex = 0;
      mockFetch.mockImplementation((url: string, req?: RequestInit) => {
        const u = typeof url === 'string' ? url : '';
        if (u.includes('/api/learning/smart-classify') && (!req || req.method === 'GET')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                success: true,
                data: [
                  { ...debitCandidate, canonicalName: 'ENTITY_A' },
                  { ...debitCandidate, canonicalName: 'ENTITY_B' },
                  { ...debitCandidate, canonicalName: 'ENTITY_C' },
                ],
              }),
          });
        }
        if (u.includes('/api/learning/suggest-role')) {
          callIndex++;
          if (callIndex === 1) {
            return Promise.resolve({
              ok: true,
              json: () =>
                Promise.resolve({
                  suggestedRole: 'INQUILINO',
                  confidence: 0.95,
                  explanation: 'Rent pattern',
                }),
            });
          }
          if (callIndex === 2) {
            return Promise.resolve(new Response(JSON.stringify({ error: 'AI failed' }), { status: 502 }));
          }
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                suggestedRole: 'PROVEEDOR',
                confidence: 0.45,
                explanation: 'Unclear pattern',
              }),
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      });

      render(<EntityOnboardingModal isOpen onClose={vi.fn()} companyId="comp_1" />);

      await waitFor(() => {
        expect(screen.getByText('ENTITY_A')).toBeInTheDocument();
        expect(screen.getByText('ENTITY_B')).toBeInTheDocument();
        expect(screen.getByText('ENTITY_C')).toBeInTheDocument();
      });

      // Select OTRO for all 3
      await selectRole(user, 0, 'OTRO');
      await selectRole(user, 1, 'OTRO');
      await selectRole(user, 2, 'OTRO');

      // Type descriptions
      const textareas = screen.getAllByPlaceholderText('Describe what this entity is...');
      await user.type(textareas[0], 'desc a');
      await user.type(textareas[1], 'desc b');
      await user.type(textareas[2], 'desc c');

      // 3 OTRO entities, button shows "Suggest roles" (plural)
      // Click "Suggest roles"
      await user.click(screen.getByRole('button', { name: 'Suggest roles' }));

      // Wait for all banners to appear
      await waitFor(() => {
        // Entity A: success with high confidence
        expect(screen.getByText('Suggestion: Inquilino')).toBeInTheDocument();
        // Entity B: error banner
        expect(screen.getByText('Not available now. Pick manually.')).toBeInTheDocument();
        // Entity C: low confidence banner
        expect(screen.getByText('Low confidence: 45%')).toBeInTheDocument();
      });
    });
  });

  // ── 4.5 — handleAcceptSuggestion ──────────────────────────────────────
  // Note: 'shows assigned banner after user accepts suggestion' in 3.2 covers the basic flow.
  // This test adds assertions about role change and button text transition.

  // ── 4.6 — handleDiscardSuggestion ──────────────────────────────────────
  describe('4.6 — Discard suggestion', () => {
    async function selectRole(user: ReturnType<typeof userEvent.setup>, entityIdx: number, role: string) {
      const manualBtns = screen.getAllByTestId('manual-select-btn');
      await user.click(manualBtns[0]);
      await waitFor(() => {
        expect(screen.getAllByTestId('role-select').length).toBeGreaterThan(entityIdx);
      });
      const selects = screen.getAllByTestId('role-select');
      await user.selectOptions(selects[entityIdx], role);
    }

    it('hides banner and entity stays OTRO after discard', async () => {
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

      // Select OTRO
      await selectRole(user, 0, 'OTRO');

      // Type description
      const textarea = await screen.findByPlaceholderText('Describe what this entity is...');
      await user.type(textarea, 'pays invoices monthly');

      // Click "Pre classify entities"
      await user.click(screen.getByRole('button', { name: 'Suggest role' }));

      // Wait for success banner
      await waitFor(() => {
        expect(screen.getByText('Suggestion: Proveedor')).toBeInTheDocument();
      });

      // Click "Discard"
      await user.click(screen.getByRole('button', { name: /discard/i }));

      // Banner should be gone
      await waitFor(() => {
        expect(screen.queryByText('Suggestion: Proveedor')).not.toBeInTheDocument();
      });

      // Entity should still be OTRO — description textarea still visible
      expect(screen.getByPlaceholderText('Describe what this entity is...')).toBeInTheDocument();

      // Button text — entity is OTRO and unresolved (discarded but still OTRO), or resolved?
      // After discard: batchResults[name].status = 'discarded' → hasUnresolvedOtro is false (discarded counts as resolved)
      // So button should be "Save classification" (enabled)
      const classifyBtn = screen.getByRole('button', { name: 'Save classification' });
      expect(classifyBtn).toBeInTheDocument();
      expect(classifyBtn).not.toBeDisabled();
    });
  });

  // ── 4.7 — Button text cycles through all states (additional states) ──
  describe('4.7 — Button text — additional state machine states', () => {
    async function selectRole(user: ReturnType<typeof userEvent.setup>, entityIdx: number, role: string) {
      const manualBtns = screen.getAllByTestId('manual-select-btn');
      await user.click(manualBtns[0]);
      await waitFor(() => {
        expect(screen.getAllByTestId('role-select').length).toBeGreaterThan(entityIdx);
      });
      const selects = screen.getAllByTestId('role-select');
      await user.selectOptions(selects[entityIdx], role);
    }

    it('shows "Classifying entities..." disabled during batch', async () => {
      vi.useRealTimers();
      const user = userEvent.setup();

      // Use a controlled promise that never resolves
      let neverResolve: ((v: any) => void) | null = null;
      const pendingPromise = new Promise<Response>(() => {
        // Never resolve
      });

      mockFetch.mockImplementation((url: string, req?: RequestInit) => {
        const u = typeof url === 'string' ? url : '';
        if (u.includes('/api/learning/smart-classify') && (!req || req.method === 'GET')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({ success: true, data: [debitCandidate] }),
          });
        }
        if (u.includes('/api/learning/suggest-role')) {
          return pendingPromise;
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      });

      render(<EntityOnboardingModal isOpen onClose={vi.fn()} companyId="comp_1" />);

      await waitFor(() => {
        expect(screen.getByText('DEBIT ENTITY')).toBeInTheDocument();
      });

      await selectRole(user, 0, 'OTRO');

      const textarea = await screen.findByPlaceholderText('Describe what this entity is...');
      await user.type(textarea, 'pays invoices monthly');

      // Wait for button to change to "Suggest role" (OTRO + desc >= 5)
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Suggest role' })).not.toBeDisabled();
      });

      // Click "Suggest role"
      await user.click(screen.getByRole('button', { name: 'Suggest role' }));

      // Immediately after click, should show "Classifying entities..." disabled
      await waitFor(() => {
        const btn = screen.getByRole('button', { name: 'Classifying entities...' });
        expect(btn).toBeDisabled();
      });
    });

    it('shows "Classify entities" enabled when all OTRO entities are resolved (accepted)', async () => {
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

      // Click "Suggest role" (1 OTRO entity, singular)
      await user.click(screen.getByRole('button', { name: 'Suggest role' }));

      // Wait for success banner
      await waitFor(() => {
        expect(screen.getByText('Suggestion: Proveedor')).toBeInTheDocument();
      });

      // Accept the suggestion
      await user.click(screen.getByRole('button', { name: /assign/i }));

      // After accept, button should show "Save classification" enabled
      await waitFor(() => {
        const btn = screen.getByRole('button', { name: 'Save classification' });
        expect(btn).not.toBeDisabled();
      });
    });
  });

  // ── 4.10 — Modal close aborts in-flight batch requests (FR-10) ─────
  describe('4.10 — Modal close aborts in-flight requests (FR-10)', () => {
    async function selectRole(user: ReturnType<typeof userEvent.setup>, entityIdx: number, role: string) {
      const manualBtns = screen.getAllByTestId('manual-select-btn');
      await user.click(manualBtns[0]);
      await waitFor(() => {
        expect(screen.getAllByTestId('role-select').length).toBeGreaterThan(entityIdx);
      });
      const selects = screen.getAllByTestId('role-select');
      await user.selectOptions(selects[entityIdx], role);
    }

    it('resets batch state and does not persist partial results when modal closes during batch', async () => {
      vi.useRealTimers();
      const user = userEvent.setup();

      // Use a controlled promise that resolves after close
      let resolveBatch: ((v: any) => void) | null = null;
      const controlledPromise = new Promise<Response>((resolve) => {
        resolveBatch = resolve;
      });

      mockFetch.mockImplementation((url: string, req?: RequestInit) => {
        const u = typeof url === 'string' ? url : '';
        if (u.includes('/api/learning/smart-classify') && (!req || req.method === 'GET')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                success: true,
                data: [debitCandidate],
              }),
          });
        }
        if (u.includes('/api/learning/suggest-role')) {
          return controlledPromise;
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      });

      const { rerender } = render(<EntityOnboardingModal isOpen onClose={vi.fn()} companyId="comp_1" />);

      await waitFor(() => {
        expect(screen.getByText('DEBIT ENTITY')).toBeInTheDocument();
      });

      // Select OTRO
      await selectRole(user, 0, 'OTRO');

      // Type description
      const textarea = await screen.findByPlaceholderText('Describe what this entity is...');
      await user.type(textarea, 'desc for entity');

      // Wait for button text to change to "Suggest role" (after state update)
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Suggest role' })).not.toBeDisabled();
      });

      // Click "Suggest role"
      await user.click(screen.getByRole('button', { name: 'Suggest role' }));

      // Verify "Classifying entities..." appears (confirms batch is in-flight)
      await waitFor(() => {
        expect(screen.getByText('Classifying entities...')).toBeInTheDocument();
      });

      // Close modal — unmount the component
      rerender(<EntityOnboardingModal isOpen={false} onClose={vi.fn()} companyId="comp_1" />);

      // Flush any pending effects
      await act(async () => {});

      // Now try to resolve the batch — the component is unmounted so no results should appear
      resolveBatch!(
        new Response(
          JSON.stringify({
            suggestedRole: 'PROVEEDOR',
            confidence: 0.92,
            explanation: 'Supplier pattern',
          }),
          { status: 200 },
        ),
      );

      // Advance to let any microtasks process
      await act(async () => {});

      // When we re-open the modal, it should be in clean state
      rerender(<EntityOnboardingModal isOpen onClose={vi.fn()} companyId="comp_1" />);

      await waitFor(() => {
        expect(screen.getByText('DEBIT ENTITY')).toBeInTheDocument();
      });

      // No batch results should appear from the old batch
      // The button should show "Classify entities" (disabled — no role selected)
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Save classification' })).toBeDisabled();
      });
    });
  });

  // ── 4.11 — Typing during batch does not add new entities (FR-11) ────
  describe('4.11 — Typing during batch does not add new entities (FR-11)', () => {
    async function selectRole(user: ReturnType<typeof userEvent.setup>, entityIdx: number, role: string) {
      const manualBtns = screen.getAllByTestId('manual-select-btn');
      await user.click(manualBtns[0]);
      await waitFor(() => {
        expect(screen.getAllByTestId('role-select').length).toBeGreaterThan(entityIdx);
      });
      const selects = screen.getAllByTestId('role-select');
      await user.selectOptions(selects[entityIdx], role);
    }

    it('excludes entities typed during batch from current batch results', async () => {
      vi.useRealTimers();
      const user = userEvent.setup();

      // Entity A has description at click time, Entity B does NOT yet
      let resolveBatch: ((v: any) => void) | null = null;
      const controlledPromise = new Promise<Response>((resolve) => {
        resolveBatch = resolve;
      });

      mockFetch.mockImplementation((url: string, req?: RequestInit) => {
        const u = typeof url === 'string' ? url : '';
        if (u.includes('/api/learning/smart-classify') && (!req || req.method === 'GET')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                success: true,
                data: [
                  { ...debitCandidate, canonicalName: 'ENTITY_A' },
                  { ...debitCandidate, canonicalName: 'ENTITY_B' },
                ],
              }),
          });
        }
        if (u.includes('/api/learning/suggest-role')) {
          return controlledPromise;
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      });

      render(<EntityOnboardingModal isOpen onClose={vi.fn()} companyId="comp_1" />);

      await waitFor(() => {
        expect(screen.getByText('ENTITY_A')).toBeInTheDocument();
        expect(screen.getByText('ENTITY_B')).toBeInTheDocument();
      });

      // Select OTRO for both
      await selectRole(user, 0, 'OTRO');
      await selectRole(user, 1, 'OTRO');

      // Type description ONLY for Entity A initially
      const textareas = screen.getAllByPlaceholderText('Describe what this entity is...');
      await user.type(textareas[0], 'entity a description');

      // Click "Pre classify entities" — only Entity A is eligible
      await user.click(screen.getByRole('button', { name: 'Suggest role' }));

      // DURING the batch, type description for Entity B
      await user.type(textareas[1], 'entity b description written during batch');

      // Resolve the batch
      resolveBatch!(
        new Response(
          JSON.stringify({
            suggestedRole: 'PROVEEDOR',
            confidence: 0.92,
            explanation: 'Supplier pattern',
          }),
          { status: 200 },
        ),
      );

      // Wait for batch to complete
      await waitFor(() => {
        expect(screen.getByText('Suggestion: Proveedor')).toBeInTheDocument();
      });

      // Only ONE banner should appear (for Entity A). Entity B was typed during batch and excluded.
      const suggestions = screen.queryAllByText('Suggestion: Proveedor');
      expect(suggestions).toHaveLength(1);

      // Entity B should still have its textarea visible (no batch result banner)
      expect(textareas[1]).toBeInTheDocument();
      expect(textareas[1]).toHaveValue('entity b description written during batch');
    });
  });

  // ── Role-first flow (Opción A) ──────────────────────────────────
  describe('Role-first flow', () => {
    async function selectRole(user: ReturnType<typeof userEvent.setup>, entityIdx: number, role: string) {
      // Enter manual mode first (role-select is hidden until manual mode or suggestion)
      const manualBtns = screen.getAllByTestId('manual-select-btn');
      await user.click(manualBtns[0]);
      await waitFor(() => {
        expect(screen.getAllByTestId('role-select').length).toBeGreaterThan(entityIdx);
      });
      const selects = screen.getAllByTestId('role-select');
      await user.selectOptions(selects[entityIdx], role);
    }

    it('enables classify button when at least 1 entity has a valid role (no intent needed)', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      setupFetch([debitCandidate, mixedCandidate]);
      render(<EntityOnboardingModal isOpen onClose={vi.fn()} companyId="comp_1" />);

      await waitFor(() => {
        expect(screen.getByText('DEBIT ENTITY')).toBeInTheDocument();
        expect(screen.getByText('MIXED ENTITY')).toBeInTheDocument();
      });

      // Select PROVEEDOR for first entity — no intent selected
      await selectRole(user, 0, 'PROVEEDOR');

      // Main footer button should be enabled (exact match avoids per-entity preClassify buttons)
      const saveBtn = screen.getByRole('button', { name: 'Save classifications' });
      expect(saveBtn).not.toBeDisabled();
    });

    it('sends role + optional intent to classify-entity API', async () => {
      vi.useRealTimers();
      const user = userEvent.setup();
      const capturedBodies: any[] = [];

      mockFetch.mockImplementation((url: string, req?: RequestInit) => {
        const u = typeof url === 'string' ? url : '';
        if (u.includes('/api/learning/smart-classify') && (!req || req.method === 'GET')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ success: true, data: [debitCandidate] }),
          });
        }
        if (u.includes('/api/learning/classify-entity') && req?.method === 'POST') {
          capturedBodies.push(JSON.parse(req.body as string));
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ success: true, data: { role: 'PROVEEDOR' } }),
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      });

      render(<EntityOnboardingModal isOpen onClose={vi.fn()} companyId="comp_1" />);

      await waitFor(() => {
        expect(screen.getByText('DEBIT ENTITY')).toBeInTheDocument();
      });

      // Select PROVEEDOR — no intent
      await selectRole(user, 0, 'PROVEEDOR');

      // Click classify (exact match to avoid per-entity preClassify buttons)
      const classifyBtn = screen.getByRole('button', { name: 'Save classification' });
      await user.click(classifyBtn);

      await waitFor(() => {
        expect(capturedBodies).toHaveLength(1);
      });

      // Body should have role but intent can be null
      expect(capturedBodies[0].role).toBe('PROVEEDOR');
      // intent is optional — may be null or undefined
    });

    it('keeps modal open after save when entities remain', async () => {
      vi.useRealTimers();
      const user = userEvent.setup();
      const onClose = vi.fn();

      mockFetch.mockImplementation((url: string, req?: RequestInit) => {
        const u = typeof url === 'string' ? url : '';
        if (u.includes('/api/learning/smart-classify') && (!req || req.method === 'GET')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ success: true, data: [debitCandidate, mixedCandidate] }),
          });
        }
        if (u.includes('/api/learning/classify-entity') && req?.method === 'POST') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ success: true, data: { role: 'PROVEEDOR' } }),
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      });

      render(<EntityOnboardingModal isOpen onClose={onClose} companyId="comp_1" />);

      await waitFor(() => {
        expect(screen.getByText('DEBIT ENTITY')).toBeInTheDocument();
        expect(screen.getByText('MIXED ENTITY')).toBeInTheDocument();
      });

      // Select PROVEEDOR for first entity only
      await selectRole(user, 0, 'PROVEEDOR');

      // Click classify (exact match)
      const classifyBtn = screen.getByRole('button', { name: 'Save classifications' });
      await user.click(classifyBtn);

      // Wait for save — toast.warning (not success) because MIXED ENTITY was skipped (no role)
      await waitFor(() => {
        expect(mockToast.warning).toHaveBeenCalled();
      });

      // Modal should NOT have closed — MIXED ENTITY is still pending
      expect(onClose).not.toHaveBeenCalled();

      // MIXED ENTITY should still be visible
      expect(screen.getByText('MIXED ENTITY')).toBeInTheDocument();
    });

    it('closes modal when all entities are classified', async () => {
      vi.useRealTimers();
      const user = userEvent.setup();
      const onClose = vi.fn();

      mockFetch.mockImplementation((url: string, req?: RequestInit) => {
        const u = typeof url === 'string' ? url : '';
        if (u.includes('/api/learning/smart-classify') && (!req || req.method === 'GET')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ success: true, data: [debitCandidate] }),
          });
        }
        if (u.includes('/api/learning/classify-entity') && req?.method === 'POST') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ success: true, data: { role: 'PROVEEDOR' } }),
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      });

      render(<EntityOnboardingModal isOpen onClose={onClose} companyId="comp_1" />);

      await waitFor(() => {
        expect(screen.getByText('DEBIT ENTITY')).toBeInTheDocument();
      });

      // Select PROVEEDOR
      await selectRole(user, 0, 'PROVEEDOR');

      // Click classify (exact match)
      const classifyBtn = screen.getByRole('button', { name: 'Save classification' });
      await user.click(classifyBtn);

      // Wait for save to complete
      await waitFor(() => {
        expect(mockToast.success).toHaveBeenCalled();
      });

      // Modal should close — only 1 entity and it was classified
      expect(onClose).toHaveBeenCalled();
    });
  });

  // ── 3.1 — Button text derivation (state machine) ──────────────────
  describe('3.1 — Button text derivation', () => {
    async function selectRole(user: ReturnType<typeof userEvent.setup>, entityIdx: number, role: string) {
      // Enter manual mode first (role-select is hidden until manual mode or suggestion)
      const manualBtns = screen.getAllByTestId('manual-select-btn');
      await user.click(manualBtns[0]);
      await waitFor(() => {
        expect(screen.getAllByTestId('role-select').length).toBeGreaterThan(entityIdx);
      });
      const selects = screen.getAllByTestId('role-select');
      await user.selectOptions(selects[entityIdx], role);
    }

    it('shows "Classify entities" when no OTRO is selected', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      setupFetch([debitCandidate]);
      render(<EntityOnboardingModal isOpen onClose={vi.fn()} companyId="comp_1" />);

      await waitFor(() => {
        expect(screen.getByText('DEBIT ENTITY')).toBeInTheDocument();
      });

      // Select a non-OTRO role to make button enabled
      await selectRole(user, 0, 'PROVEEDOR');

      const btn = screen.getByRole('button', { name: 'Save classification' });
      expect(btn).toBeInTheDocument();
      expect(btn).not.toBeDisabled();
    });

    it('does not show pre-classify button when OTRO selected but no description', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      setupFetch([debitCandidate]);
      render(<EntityOnboardingModal isOpen onClose={vi.fn()} companyId="comp_1" />);

      await waitFor(() => {
        expect(screen.getByText('DEBIT ENTITY')).toBeInTheDocument();
      });

      // Select OTRO → no description yet
      await selectRole(user, 0, 'OTRO');

      // Textarea should be visible but no pre-classify button yet
      await waitFor(() => {
        expect(screen.getByPlaceholderText('Describe what this entity is...')).toBeInTheDocument();
      });
      expect(screen.queryByTestId('pre-classify-btn')).not.toBeInTheDocument();
    });

    it('shows "Pre classify entities" enabled when OTRO selected with description >= 5 chars', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      setupFetch([debitCandidate]);
      render(<EntityOnboardingModal isOpen onClose={vi.fn()} companyId="comp_1" />);

      await waitFor(() => {
        expect(screen.getByText('DEBIT ENTITY')).toBeInTheDocument();
      });

      // Select OTRO
      await selectRole(user, 0, 'OTRO');

      // Type description >= 5 chars
      const textarea = await screen.findByPlaceholderText('Describe what this entity is...');
      await user.type(textarea, 'pays invoices monthly');

      await waitFor(() => {
        const btn = screen.getByTestId('pre-classify-btn');
        expect(btn).not.toBeDisabled();
      });
    });
  });

  // ── 3.2 — Inline banner rendering ─────────────────────────────────
  describe('3.2 — Inline suggestion banner', () => {
    async function selectRole(user: ReturnType<typeof userEvent.setup>, entityIdx: number, role: string) {
      // Enter manual mode first (role-select is hidden until manual mode or suggestion)
      const manualBtns = screen.getAllByTestId('manual-select-btn');
      await user.click(manualBtns[0]);
      await waitFor(() => {
        expect(screen.getAllByTestId('role-select').length).toBeGreaterThan(entityIdx);
      });
      const selects = screen.getAllByTestId('role-select');
      await user.selectOptions(selects[entityIdx], role);
    }

    /** Helper: flush pending microtasks and state updates in fake-timer mode */
    async function flushMicrotasks() {
      await act(async () => {});
    }

    it('shows success banner with suggestion after batch classification', async () => {
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

      // Select OTRO
      await selectRole(user, 0, 'OTRO');

      // Type description (same pattern as low-confidence test that passes)
      const textarea = await screen.findByPlaceholderText('Describe what this entity is...');
      await user.type(textarea, 'pays invoices monthly');

      // Click "Pre classify entities"
      const preClassifyBtn = screen.getByTestId('pre-classify-btn');
      await user.click(preClassifyBtn);

      // Verify banner rendered
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

      // Select OTRO
      await selectRole(user, 0, 'OTRO');

      // Type description
      const textarea = await screen.findByPlaceholderText('Describe what this entity is...');
      await user.type(textarea, 'pays invoices monthly');

      // Click "Pre classify entities" then flush microtasks
      const preClassifyBtn = screen.getByTestId('pre-classify-btn');
      await user.click(preClassifyBtn);
      await flushMicrotasks();

      // Wait for low confidence banner
      await waitFor(() => {
        expect(screen.getByText('Low confidence: 45%')).toBeInTheDocument();
      });
    });

    it('shows error banner when API fails during batch', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      setupFetch([debitCandidate], { suggestRoleStatus: 502 });
      render(<EntityOnboardingModal isOpen onClose={vi.fn()} companyId="comp_1" />);

      await waitFor(() => {
        expect(screen.getByText('DEBIT ENTITY')).toBeInTheDocument();
      });

      // Select OTRO
      await selectRole(user, 0, 'OTRO');

      // Type description
      const textarea = await screen.findByPlaceholderText('Describe what this entity is...');
      await user.type(textarea, 'pays invoices monthly');

      // Click "Pre classify entities" then flush microtasks
      const preClassifyBtn = screen.getByTestId('pre-classify-btn');
      await user.click(preClassifyBtn);
      await flushMicrotasks();

      // Wait for error banner
      await waitFor(() => {
        expect(screen.getByText('Not available now. Pick manually.')).toBeInTheDocument();
      });
    });

    it('shows assigned banner after user accepts suggestion', async () => {
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

      // Select OTRO
      await selectRole(user, 0, 'OTRO');

      // Type description
      const textarea = await screen.findByPlaceholderText('Describe what this entity is...');
      await user.type(textarea, 'pays invoices monthly');

      // Click "Pre classify entities"
      await user.click(screen.getByRole('button', { name: 'Suggest role' }));

      // Wait for success banner, then click "Assign"
      await waitFor(() => {
        expect(screen.getByText('Suggestion: Proveedor')).toBeInTheDocument();
      });
      await user.click(screen.getByRole('button', { name: /assign/i }));

      // Assigned banner should appear
      await waitFor(() => {
        expect(screen.getByText('Role assigned: Proveedor')).toBeInTheDocument();
      });
    });

    it('FR-6: clicking "Edit role manually" allows selecting a different role from the dropdown', async () => {
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

      // Select OTRO
      await selectRole(user, 0, 'OTRO');

      // Type description
      const textarea = await screen.findByPlaceholderText('Describe what this entity is...');
      await user.type(textarea, 'pays invoices monthly');

      // Click "Pre classify entities"
      await user.click(screen.getByRole('button', { name: 'Suggest role' }));

      // Wait for success banner
      await waitFor(() => {
        expect(screen.getByText('Suggestion: Proveedor')).toBeInTheDocument();
      });

      // Click "Edit role manually"
      await user.click(screen.getByRole('button', { name: /edit role manually/i }));

      // Select a different role — the dropdown must still be interactive
      await user.selectOptions(screen.getAllByTestId('role-select')[0], 'CLIENTE');

      // Role changed: banner should be gone and select shows the new value
      await waitFor(() => {
        expect(screen.queryByText('Suggestion: Proveedor')).not.toBeInTheDocument();
      });
      expect(screen.getAllByTestId('role-select')[0]).toHaveValue('CLIENTE');
    });
  });
});
