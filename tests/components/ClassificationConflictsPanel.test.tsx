// KE-CONFLICT-UI-001 — UI tests (T22–T30)
// ClassificationConflictsClient conflict lifecycle surface.

// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ClassificationConflictsClient, type PendingConflictApiEntry } from '../../src/app/company-knowledge/_components/classification-conflicts-client';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// ─── Mock shadcn Select with native <select> for jsdom ────────────
vi.mock('@/components/ui/select', () => ({
  Select: ({ value, onValueChange, disabled, children }: any) => {
    let testId = 'mock-select';
    let seenTrigger = false;
    const options: { value: string; label: string; testId?: string }[] = [];
    React.Children.forEach(children, (child: any) => {
      if (!React.isValidElement(child)) return;
      if (child.props?.['data-testid'] && !seenTrigger) {
        testId = child.props['data-testid'];
        seenTrigger = true;
      }
      if (child.props?.children) {
        React.Children.forEach(child.props.children, (sub: any) => {
          if (!React.isValidElement(sub)) return;
          if (sub.props?.value !== undefined) {
            options.push({ value: sub.props.value, label: String(sub.props.children ?? sub.props.value), testId: sub.props['data-testid'] });
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
          <option key={o.value} value={o.value} data-testid={o.testId ?? `option-${o.value}`}>{o.label}</option>
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
  SelectItem: ({ value, children, ...props }: any) => <div {...props}>{children}</div>,
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}));

const tFn = vi.fn((key: string) => key);

vi.mock('@/store/language-store', () => ({
  useLanguageStore: (selector: (s: any) => any) => selector({ t: tFn }),
}));

// ─── fetch mock (vi.stubGlobal survives the global setup network barrier) ───

const fetchMock = vi.fn();

const CONFLICT_A: PendingConflictApiEntry = {
  conflictItemId: 'conflict-a',
  kind: 'OBSERVATION_VS_AUTHORIZED',
  authorizedPatternIds: ['pattern-1'],
  conflictingGlAccountId: 'gl-b',
  observationIds: ['obs-1', 'obs-2'],
  detectedAt: '2026-09-01T10:00:00.000Z',
};

const CONFLICT_B: PendingConflictApiEntry = {
  conflictItemId: 'conflict-b',
  kind: 'AUTHORIZED_VS_EXACT',
  authorizedPatternIds: ['pattern-2'],
  exactTreatmentItemIds: ['exact-9'],
  conflictingGlAccountId: 'gl-c',
  observationIds: ['obs-3'],
  detectedAt: '2026-09-02T10:00:00.000Z',
};

const CONFLICT_LEGACY: PendingConflictApiEntry = {
  conflictItemId: 'conflict-legacy',
  kind: 'AUTHORIZED_VS_EXACT',
  authorizedPatternIds: ['pattern-3'],
  conflictingGlAccountId: 'gl-d',
  observationIds: ['obs-4'],
  detectedAt: '2026-09-03T10:00:00.000Z',
};

function mockListResponse(conflicts: PendingConflictApiEntry[]) {
  return {
    ok: true,
    json: async () => ({ success: true, conflicts }),
  };
}

function mockActionResponse(status: string, extra: Record<string, unknown> = {}) {
  return {
    ok: true,
    json: async () => ({ success: true, status, ...extra }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(mockListResponse([]));
  vi.stubGlobal('fetch', fetchMock);
});

function renderPanel() {
  return render(<ClassificationConflictsClient companyId="company-1" />);
}

describe('KE-CONFLICT-UI-001 — ClassificationConflictsClient (T22–T30)', () => {
  it('T22: pending conflicts are visible', async () => {
    fetchMock.mockResolvedValue(mockListResponse([CONFLICT_A]));
    renderPanel();
    await waitFor(() => {
      expect(screen.getAllByTestId('conflict-item')).toHaveLength(1);
    });
    expect(screen.getByText('OBSERVATION_VS_AUTHORIZED')).toBeInTheDocument();
  });

  it('T23: a conflict is selectable and shows its evidence/ids', async () => {
    fetchMock.mockResolvedValue(mockListResponse([CONFLICT_A]));
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() => {
      expect(screen.getAllByTestId('conflict-item')).toHaveLength(1);
    });
    await user.click(screen.getAllByTestId('conflict-item')[0]);
    await waitFor(() => {
      expect(screen.getByTestId('conflict-detail')).toBeInTheDocument();
    });
    expect(screen.getAllByText('obs-1, obs-2')).toHaveLength(1);
    expect(screen.getAllByText('pattern-1').length).toBeGreaterThanOrEqual(1);
  });

  it('T24: resolution requires a non-empty reason (button disabled)', async () => {
    fetchMock.mockResolvedValue(mockListResponse([CONFLICT_A]));
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() => {
      expect(screen.getAllByTestId('conflict-item')).toHaveLength(1);
    });
    await user.click(screen.getAllByTestId('conflict-item')[0]);
    await waitFor(() => {
      expect(screen.getByTestId('resolve-conflict-btn')).toBeInTheDocument();
    });
    expect(screen.getByTestId('resolve-conflict-btn')).toBeDisabled();
    await user.type(screen.getByTestId('resolution-reason-input'), 'kept GL-B per approval');
    expect(screen.getByTestId('resolve-conflict-btn')).toBeEnabled();
  });

  it('T25: RESOLVE and REHABILITATE are separate, distinct actions', async () => {
    fetchMock.mockResolvedValue(mockListResponse([CONFLICT_A]));
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() => {
      expect(screen.getAllByTestId('conflict-item')).toHaveLength(1);
    });
    await user.click(screen.getAllByTestId('conflict-item')[0]);
    await waitFor(() => {
      expect(screen.getByTestId('resolve-conflict-btn')).toBeInTheDocument();
    });
    expect(screen.getByTestId('rehabilitate-knowledge-btn')).toBeInTheDocument();
    // Rehabilitate is disabled before an explicit resolution
    expect(screen.getByTestId('rehabilitate-knowledge-btn')).toBeDisabled();
    await user.type(screen.getByTestId('resolution-reason-input'), 'kept GL-B per approval');
    await user.click(screen.getByTestId('resolve-conflict-btn'));
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'POST'
        && String((init as RequestInit | undefined)?.body as string).includes('resolutionReason'))).toBe(true);
    });
    // After resolution the second button becomes enabled — still a SEPARATE click
    await waitFor(() => {
      expect(screen.getByTestId('rehabilitate-knowledge-btn')).toBeEnabled();
    });
    expect(screen.getByTestId('resolution-recorded-hint')).toBeInTheDocument();
  });

  it('T26: resolution does NOT trigger rehabilitation anywhere', async () => {
    fetchMock
      .mockResolvedValueOnce(mockListResponse([CONFLICT_A]))
      .mockResolvedValueOnce(mockListResponse([]))
      .mockResolvedValue(mockListResponse([]));
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() => {
      expect(screen.getAllByTestId('conflict-item')).toHaveLength(1);
    });
    await user.click(screen.getAllByTestId('conflict-item')[0]);
    await user.type(screen.getByTestId('resolution-reason-input'), 'kept GL-B per approval');
    await user.click(screen.getByTestId('resolve-conflict-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('resolution-recorded-hint')).toBeInTheDocument();
    });
    const postCalls = fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST');
    expect(postCalls).toHaveLength(1);
    expect(String(postCalls[0][0])).toContain('/resolve');
  });

  it('T27: only explicitly implicated targets are offered', async () => {
    fetchMock.mockResolvedValue(mockListResponse([CONFLICT_B]));
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() => {
      expect(screen.getAllByTestId('conflict-item')).toHaveLength(1);
    });
    await user.click(screen.getAllByTestId('conflict-item')[0]);
    await user.type(screen.getByTestId('resolution-reason-input'), 'kept exact treatment');
    await user.click(screen.getByTestId('resolve-conflict-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('rehabilitate-knowledge-btn')).toBeEnabled();
    });
    const offered = Array.from(
      (screen.getByTestId('rehabilitation-target-select') as HTMLSelectElement).options,
    ).map((o) => o.value);
    expect(offered).toEqual(['pattern-2', 'exact-9']);
    // No query-param guessing was made to the API either
    expect(fetchMock.mock.calls.every((call) => {
      const url = String(call[0]);
      return !url.includes('knowledgeItemId') && !url.includes('target');
    })).toBe(true);
  });

  it('T28: legacy conflict without exactTreatmentItemIds does NOT invent an exact target', async () => {
    fetchMock.mockResolvedValue(mockListResponse([CONFLICT_LEGACY]));
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() => {
      expect(screen.getAllByTestId('conflict-item')).toHaveLength(1);
    });
    await user.click(screen.getAllByTestId('conflict-item')[0]);
    await user.type(screen.getByTestId('resolution-reason-input'), 'kept pattern');
    await user.click(screen.getByTestId('resolve-conflict-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('rehabilitate-knowledge-btn')).toBeEnabled();
    });
    const offered = Array.from(
      (screen.getByTestId('rehabilitation-target-select') as HTMLSelectElement).options,
    ).map((o) => o.value);
    // Only the explicitly-linked pattern; the legacy exact item is not derivable
    expect(offered).toEqual(['pattern-3']);
    expect(screen.queryByText('exact-treatment-item')).not.toBeInTheDocument();
  });

  it('T29: rehabilitation result is shown', async () => {
    fetchMock
      .mockResolvedValueOnce(mockListResponse([CONFLICT_B]))
      .mockResolvedValueOnce(mockListResponse([]))
      .mockResolvedValueOnce(mockListResponse([]))
      .mockResolvedValue(mockActionResponse('REHABILITATED', { knowledgeItemId: 'exact-9', conflictItemId: 'conflict-b' }));
    const { toast } = await import('sonner');
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() => {
      expect(screen.getAllByTestId('conflict-item')).toHaveLength(1);
    });
    await user.click(screen.getAllByTestId('conflict-item')[0]);
    await user.type(screen.getByTestId('resolution-reason-input'), 'kept exact treatment');
    await user.click(screen.getByTestId('resolve-conflict-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('rehabilitate-knowledge-btn')).toBeEnabled();
    });
    await user.selectOptions(screen.getByTestId('rehabilitation-target-select'), 'exact-9');
    await user.click(screen.getByTestId('rehabilitate-knowledge-btn'));
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith(
        expect.stringContaining('exact-9'),
      );
    });
    const rehabCalls = fetchMock.mock.calls.filter((call) => String(call[0]).includes('/rehabilitate'));
    expect(rehabCalls).toHaveLength(1);
  });

  it('T30: API error is visible and does not appear as success', async () => {
    fetchMock
      .mockResolvedValueOnce(mockListResponse([CONFLICT_A]))
      .mockResolvedValue({
        ok: false,
        json: async () => ({ error: 'Resolution failed', code: 'CONFLICT_NOT_FOUND' }),
      });
    const { toast } = await import('sonner');
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() => {
      expect(screen.getAllByTestId('conflict-item')).toHaveLength(1);
    });
    await user.click(screen.getAllByTestId('conflict-item')[0]);
    await user.type(screen.getByTestId('resolution-reason-input'), 'kept GL-B per approval');
    await user.click(screen.getByTestId('resolve-conflict-btn'));
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalled();
    });
    expect(toast.success).not.toHaveBeenCalled();
  });
});
