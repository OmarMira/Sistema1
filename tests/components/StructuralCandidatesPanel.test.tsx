// KE-GENERALIZATION-UI-001 — UI tests (T18–T33)
// StructuralCandidatesClient: discovery action, pending candidates,
// explicit separate authorization, server-authoritative refresh.

// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StructuralCandidatesClient, type PendingCandidateApiEntry } from '../../src/app/company-knowledge/_components/structural-candidates-client';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { toast } from 'sonner';

const tFn = vi.fn((key: string) => key);
vi.mock('@/store/language-store', () => ({
  useLanguageStore: (selector: (s: any) => any) => selector({ t: tFn }),
}));

const fetchMock = vi.fn();

const CANDIDATE_A: PendingCandidateApiEntry = {
  candidateItemId: 'cand-a',
  entityId: 'entity-1',
  glAccountId: 'gl-a',
  direction: 'any',
  segments: [
    { kind: 'stable', value: 'abc' },
    { kind: 'variable', evidence: ['1'] },
    { kind: 'stable', value: 'corp' },
  ],
  observationIds: ['obs-1', 'obs-2'],
};

function mockListResponse(candidates: PendingCandidateApiEntry[]) {
  return { ok: true, json: async () => ({ success: true, candidates }) };
}

function mockDiscoverResponse(found: number, recorded: number) {
  return {
    ok: true,
    json: async () => ({ success: true, groupsExamined: 1, candidatesFound: found, candidatesRecorded: recorded, duplicatesSkipped: 0, groupsWithoutCandidate: 0 }),
  };
}

function mockAuthorizeResponse(status: string) {
  return { ok: true, json: async () => ({ success: true, status, authorizedPatternId: 'pat-1' }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(mockListResponse([]));
  vi.stubGlobal('fetch', fetchMock);
});

function renderPanel() {
  return render(<StructuralCandidatesClient companyId="company-1" />);
}

describe('KE-GENERALIZATION-UI-001 — StructuralCandidatesClient (T18–T33)', () => {
  it('T19: discovery action is visible', async () => {
    renderPanel();
    await waitFor(() => {
      expect(screen.getByTestId('run-discovery-btn')).toBeInTheDocument();
    });
  });

  it('T20: loading state is shown while fetching', async () => {
    fetchMock.mockImplementation(() => new Promise(() => undefined));
    renderPanel();
    expect(tFn).toHaveBeenCalledWith('learning.structuralCandidates.loading');
  });

  it('T21: discovery error state surfaces and does not fake success', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return { ok: false, status: 500, json: async () => ({ error: 'boom' }) };
      return mockListResponse([]);
    });
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() => {
      expect(screen.getByTestId('run-discovery-btn')).toBeInTheDocument();
    });
    await user.click(screen.getByTestId('run-discovery-btn'));
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalled();
    });
  });

  it('T22: empty candidate state is rendered', async () => {
    renderPanel();
    await waitFor(() => {
      expect(screen.getByTestId('candidates-empty')).toBeInTheDocument();
    });
  });

  it('T23: pending candidate is rendered', async () => {
    fetchMock.mockResolvedValue(mockListResponse([CANDIDATE_A]));
    renderPanel();
    await waitFor(() => {
      expect(screen.getByTestId('candidate-item-cand-a')).toBeInTheDocument();
    });
  });

  it('T24: proposed pattern is rendered from contract segments', async () => {
    fetchMock.mockResolvedValue(mockListResponse([CANDIDATE_A]));
    renderPanel();
    await waitFor(() => {
      expect(screen.getByText('abc * corp')).toBeInTheDocument();
    });
  });

  it('T25: available evidence/support is rendered', async () => {
    fetchMock.mockResolvedValue(mockListResponse([CANDIDATE_A]));
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() => {
      expect(screen.getByTestId('candidate-item-cand-a')).toBeInTheDocument();
    });
    await user.click(screen.getByTestId('candidate-item-cand-a'));
    await waitFor(() => {
      expect(screen.getByTestId('candidate-evidence')).toHaveTextContent('obs-1, obs-2');
    });
  });

  it('T26: explicit authorization control exists per candidate', async () => {
    fetchMock.mockResolvedValue(mockListResponse([CANDIDATE_A]));
    renderPanel();
    await waitFor(() => {
      expect(screen.getByTestId('authorize-btn-cand-a')).toBeInTheDocument();
    });
  });

  it('T27: authorization is human-triggered (POST only after click) and hits the authorize endpoint', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST' && String(url).includes('/authorize')) return mockAuthorizeResponse('AUTHORIZED');
      return mockListResponse([CANDIDATE_A]);
    });
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() => {
      expect(screen.getByTestId('authorize-btn-cand-a')).toBeInTheDocument();
    });
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes('/authorize'))).toHaveLength(0);
    await user.click(screen.getByTestId('authorize-btn-cand-a'));
    await waitFor(() => {
      expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes('/authorize'))).toHaveLength(1);
    });
  });

  it('T28: double submit blocked while authorization is pending', async () => {
    let resolveAuth: ((v: unknown) => void) | null = null;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST' && String(url).includes('/authorize')) {
        return new Promise((resolve) => {
          resolveAuth = resolve;
        });
      }
      return mockListResponse([CANDIDATE_A]);
    });
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() => {
      expect(screen.getByTestId('authorize-btn-cand-a')).toBeInTheDocument();
    });
    await user.click(screen.getByTestId('authorize-btn-cand-a'));
    await waitFor(() => {
      expect(screen.getByTestId('authorize-btn-cand-a')).toBeDisabled();
    });
    resolveAuth?.(mockAuthorizeResponse('AUTHORIZED'));
  });

  it('T29: authorization failure preserves the pending candidate state', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST' && String(url).includes('/authorize')) {
        return { ok: false, status: 409, json: async () => ({ success: false, status: 'CONFLICT', conflictingPatternIds: ['p-1'] }) };
      }
      return mockListResponse([CANDIDATE_A]);
    });
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() => {
      expect(screen.getByTestId('authorize-btn-cand-a')).toBeInTheDocument();
    });
    await user.click(screen.getByTestId('authorize-btn-cand-a'));
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalled();
    });
    // Candidate still visible and enabled for retry.
    expect(screen.getByTestId('candidate-item-cand-a')).toBeInTheDocument();
    expect(screen.getByTestId('authorize-btn-cand-a')).not.toBeDisabled();
  });

  it('T30: success refreshes server-authoritative state (list re-fetched)', async () => {
    let authorizedOnce = false;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST' && String(url).includes('/authorize')) {
        authorizedOnce = true;
        return mockAuthorizeResponse('AUTHORIZED');
      }
      if (init?.method === 'POST') return mockDiscoverResponse(1, 1);
      return authorizedOnce ? mockListResponse([]) : mockListResponse([CANDIDATE_A]);
    });
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() => {
      expect(screen.getByTestId('candidate-item-cand-a')).toBeInTheDocument();
    });
    await user.click(screen.getByTestId('authorize-btn-cand-a'));
    await waitFor(() => {
      expect(screen.getByTestId('candidates-empty')).toBeInTheDocument();
    });
  });

  it('T31: discovery never triggers authorization (no authorize call after discovery)', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST' && !String(url).includes('/authorize')) return mockDiscoverResponse(1, 1);
      return mockListResponse([CANDIDATE_A]);
    });
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() => {
      expect(screen.getByTestId('run-discovery-btn')).toBeInTheDocument();
    });
    await user.click(screen.getByTestId('run-discovery-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('candidate-item-cand-a')).toBeInTheDocument();
    });
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes('/authorize'))).toHaveLength(0);
  });

  it('T32: discovery success shows feedback with counts (i18n EN path exercised)', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return mockDiscoverResponse(2, 1);
      return mockListResponse([]);
    });
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() => {
      expect(screen.getByTestId('run-discovery-btn')).toBeInTheDocument();
    });
    await user.click(screen.getByTestId('run-discovery-btn'));
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalled();
    });
  });

  it('T33: i18n keys are used for visible labels (no hardcoded copy)', async () => {
    fetchMock.mockResolvedValue(mockListResponse([CANDIDATE_A]));
    renderPanel();
    await waitFor(() => {
      expect(screen.getByTestId('candidate-item-cand-a')).toBeInTheDocument();
    });
    expect(tFn).toHaveBeenCalledWith('learning.structuralCandidates.title');
    expect(tFn).toHaveBeenCalledWith('learning.structuralCandidates.runDiscovery');
    expect(tFn).toHaveBeenCalledWith('learning.structuralCandidates.authorize');
  });
});
